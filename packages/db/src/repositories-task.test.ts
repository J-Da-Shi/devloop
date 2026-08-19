import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "./client.js";
import { DevLoopRepository } from "./repositories.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const handles: DatabaseHandle[] = [];

const createRepository = (): DevLoopRepository => {
  const handle = openDatabase({ filePath: ":memory:", migrationsFolder });
  handles.push(handle);
  return new DevLoopRepository(handle);
};

const createReadyTask = (
  repository: DevLoopRepository,
  projectId: string,
  title: string,
  priority: number,
) => {
  const draft = repository.createTask({
    projectId,
    targetBranch: "main",
    title,
    goal: `完成 ${title}`,
    acceptanceCriteria: ["任务可以被 Worker 领取"],
    priority,
  }).value;
  return repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;
};

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
});

it("自动解决冲突默认开启，并随不可变 Revision 和审核重试保留", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "自动解决冲突测试项目",
    repositoryUrl: "git@example.com:team/auto-resolve.git",
    repositoryPath: "/tmp/devloop-auto-resolve-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "自动解决冲突设置",
    goal: "验证设置完整传递",
    acceptanceCriteria: ["Worker 读取 Revision 中的设置"],
    priority: 50,
  }).value;

  expect(draft.autoResolveConflicts).toBe(true);

  const updated = repository.updateDraftTask(draft.id, "instance-owner", {
    autoResolveConflicts: false,
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
  }).value;
  const ready = repository.confirmTask(updated.id, "instance-owner", {
    expectedVersion: updated.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;

  expect(updated.autoResolveConflicts).toBe(false);
  expect(repository.getTaskRevision(ready.activeRevisionId!)).toMatchObject({
    autoResolveConflicts: false,
    reviewFeedback: null,
  });

  const firstClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(firstClaim?.value.autoResolveConflicts).toBe(false);
  const completed = repository.completeRun(
    firstClaim!.value.run.id,
    firstClaim!.value.run.executionToken,
    "等待审核",
    "result-commit",
  ).value;
  const rejected = repository.rejectRun(
    firstClaim!.value.run.id,
    "instance-owner",
    completed.task.version,
    randomUUID(),
    "请调整实现",
  ).value;

  expect(repository.getTaskRevision(rejected.activeRevisionId!)).toMatchObject({
    autoResolveConflicts: false,
    reviewFeedback: "请调整实现",
  });
  expect(
    repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" })?.value
      .autoResolveConflicts,
  ).toBe(false);
});

it("持久化研究任务类型，并通过总结审核完成任务而不推进项目基线", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "互联网研究项目",
    repositoryUrl: "git@example.com:team/research.git",
    repositoryPath: "/tmp/devloop-research-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    taskType: "RESEARCH",
    targetBranch: "main",
    title: "研究公开资料",
    goal: "从互联网获取资料并总结",
    acceptanceCriteria: ["总结包含来源 URL"],
    priority: 80,
  }).value;
  expect(draft.taskType).toBe("RESEARCH");

  const ready = repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;
  expect(repository.getTaskRevision(ready.activeRevisionId!)).toMatchObject({
    taskType: "RESEARCH",
    reviewFeedback: null,
  });

  const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(claimed?.value).toMatchObject({
    taskType: "RESEARCH",
    task: { taskType: "RESEARCH" },
  });
  const completed = repository.completeRun(
    claimed!.value.run.id,
    claimed!.value.run.executionToken,
    "研究总结\n\n来源：https://example.com/report",
  ).value;
  expect(repository.getRunApprovalContext(claimed!.value.run.id, completed.task.version)).toEqual({
    type: "research",
    context: { summary: "研究总结\n\n来源：https://example.com/report" },
  });

  const idempotencyKey = randomUUID();
  const approved = repository.approveResearchRun(
    claimed!.value.run.id,
    "instance-owner",
    completed.task.version,
    idempotencyKey,
  );
  expect(approved.value).toMatchObject({
    task: { status: "COMPLETED", taskType: "RESEARCH" },
    research: { status: "accepted", summary: expect.stringContaining("example.com") },
  });
  expect(repository.listProjects()[0]?.integrationCommit).toBe("base-commit");
  expect(repository.getRunReviewDecision(claimed!.value.run.id)?.decision).toBe("APPROVED");

  const replayed = repository.approveResearchRun(
    claimed!.value.run.id,
    "instance-owner",
    completed.task.version,
    idempotencyKey,
  );
  expect(replayed.replayed).toBe(true);
});

it("驳回研究总结后保留类型和反馈，但不串联上一轮 Git 结果", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "研究返工项目",
    repositoryUrl: null,
    repositoryPath: "/tmp/devloop-research-retry-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
    lastFetchedAt: null,
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    taskType: "RESEARCH",
    targetBranch: "main",
    title: "补充研究来源",
    goal: "核对公开来源",
    acceptanceCriteria: ["至少核对两个来源"],
    priority: 70,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" })!;
  const completed = repository.completeRun(
    claimed.value.run.id,
    claimed.value.run.executionToken,
    "第一版研究总结",
  ).value;

  const rejected = repository.rejectRun(
    claimed.value.run.id,
    "instance-owner",
    completed.task.version,
    randomUUID(),
    "请增加第二个权威来源",
  ).value;
  expect(repository.getTaskRevision(rejected.activeRevisionId!)).toMatchObject({
    taskType: "RESEARCH",
    reviewFeedback: "请增加第二个权威来源",
    baseStrategy: "LATEST_ACCEPTED",
  });
  expect(
    repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" })?.value,
  ).toMatchObject({
    taskType: "RESEARCH",
    reviewFeedback: "请增加第二个权威来源",
    continuationBaseCommit: null,
    continuationResultCommit: null,
  });
});

it("从开发任务切换为研究任务时丢弃未通过代码的连续迭代基线", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "任务类型切换项目",
    repositoryUrl: null,
    repositoryPath: "/tmp/devloop-task-type-switch-test",
    defaultBaseRef: "main",
    headCommit: "accepted-base-commit",
    lastFetchedAt: null,
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "先开发后研究",
    goal: "验证任务类型切换后的执行基线",
    acceptanceCriteria: ["不沿用未通过代码"],
    priority: 60,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const firstClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" })!;
  const completed = repository.completeRun(
    firstClaim.value.run.id,
    firstClaim.value.run.executionToken,
    "开发结果待审核",
    "unaccepted-result-commit",
  ).value;
  const rejected = repository.rejectRun(
    firstClaim.value.run.id,
    "instance-owner",
    completed.task.version,
    randomUUID(),
    "改为调研现有方案",
  ).value;
  const reopened = repository.unconfirmTask(
    rejected.id,
    "instance-owner",
    rejected.version,
    randomUUID(),
  ).value;
  const researchDraft = repository.updateDraftTask(reopened.id, "instance-owner", {
    taskType: "RESEARCH",
    expectedVersion: reopened.version,
    idempotencyKey: randomUUID(),
  }).value;
  repository.confirmTask(researchDraft.id, "instance-owner", {
    expectedVersion: researchDraft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });

  expect(
    repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" })?.value,
  ).toMatchObject({
    taskType: "RESEARCH",
    continuationBaseCommit: null,
    continuationResultCommit: null,
    run: { baseCommit: "accepted-base-commit" },
  });
});

it("项目 runner 默认 codex，claim 时按项目 runner 写入 taskRuns.runner", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "多 runner 项目",
    repositoryUrl: "git@example.com:team/multi-runner.git",
    repositoryPath: "/tmp/devloop-multi-runner-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
    runner: "claude-code",
  }).value;
  expect(project.runner).toBe("claude-code");

  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "验证按项目选 runner",
    goal: "确认 run 记录里的 runner 与项目一致",
    acceptanceCriteria: ["taskRuns.runner === 'claude-code'"],
    priority: 90,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const claimed = repository.claimNextTask({
    resolveRunnerVersion: (runnerId) => (runnerId === "claude-code" ? "claude-cli test" : null),
  });
  expect(claimed?.value.projectRunner).toBe("claude-code");
  expect(claimed?.value.run.runner).toBe("claude-code");
  expect(claimed?.value.run.runnerVersion).toBe("claude-cli test");
});

it("updateProjectRunner 幂等重放不会再次写入", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "runner 切换项目",
    repositoryUrl: "git@example.com:team/runner-switch.git",
    repositoryPath: "/tmp/devloop-runner-switch-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const idempotencyKey = randomUUID();
  const first = repository.updateProjectRunner(
    project.id,
    "claude-code",
    "instance-owner",
    project.version,
    idempotencyKey,
  );
  expect(first.value.runner).toBe("claude-code");
  expect(first.replayed).toBe(false);

  const second = repository.updateProjectRunner(
    project.id,
    "claude-code",
    "instance-owner",
    project.version,
    idempotencyKey,
  );
  expect(second.replayed).toBe(true);
  expect(second.value.runner).toBe("claude-code");
});

it("持久化项目预览配置，并在领取任务时固定到执行上下文", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "预览项目",
    repositoryUrl: "git@example.com:team/preview.git",
    repositoryPath: "/tmp/devloop-preview-project",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const idempotencyKey = randomUUID();
  const configured = repository.updateProjectPreview(
    project.id,
    {
      previewCommand: "pnpm dev -- --port {{port}}",
      previewWorkingDirectory: "apps/web",
      previewHealthPath: "/health",
      playwrightEnabled: true,
      playwrightTestCommand: "pnpm playwright test",
      expectedVersion: project.version,
      idempotencyKey,
    },
    "instance-owner",
  );
  expect(configured.replayed).toBe(false);
  expect(configured.value).toMatchObject({
    previewWorkingDirectory: "apps/web",
    previewHealthPath: "/health",
    playwrightEnabled: true,
  });
  expect(
    repository.updateProjectPreview(
      project.id,
      {
        previewCommand: "pnpm dev -- --port {{port}}",
        previewWorkingDirectory: "apps/web",
        previewHealthPath: "/health",
        playwrightEnabled: true,
        playwrightTestCommand: "pnpm playwright test",
        expectedVersion: project.version,
        idempotencyKey,
      },
      "instance-owner",
    ).replayed,
  ).toBe(true);

  const ready = createReadyTask(repository, project.id, "验证预览配置", 70);
  const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(claimed?.value).toMatchObject({
    task: { id: ready.id },
    previewCommand: "pnpm dev -- --port {{port}}",
    previewWorkingDirectory: "apps/web",
    previewHealthPath: "/health",
    playwrightEnabled: true,
    playwrightTestCommand: "pnpm playwright test",
  });
});

it("记录 Run 产物元数据但不在公开列表暴露存储路径", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "产物项目",
    repositoryUrl: "git@example.com:team/artifacts.git",
    repositoryPath: "/tmp/devloop-artifact-project",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  createReadyTask(repository, project.id, "验证运行产物", 70);
  const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  const runId = claimed!.value.run.id;
  const artifact = repository.createRunArtifact({
    runId,
    kind: "playwright-screenshot",
    storagePath: "/private/devloop/artifacts/screenshot.png",
    size: 42,
    checksum: "checksum",
  });

  expect(repository.listRunArtifacts(runId)).toEqual([artifact]);
  expect("path" in artifact).toBe(false);
  expect(repository.getRunArtifact(runId, artifact.id)).toEqual({
    artifact,
    storagePath: "/private/devloop/artifacts/screenshot.png",
  });
});

it("公开项目不包含服务器托管路径", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "远程项目",
    repositoryUrl: "git@example.com:team/private-path.git",
    repositoryPath: "/data/repositories/private-project",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;

  expect(project.repositoryUrl).toBe("git@example.com:team/private-path.git");
  expect("path" in project).toBe(false);
  expect(repository.getProjectExecutionContext(project.id)?.repositoryPath).toBe(
    "/data/repositories/private-project",
  );
});

it("本地项目可以进入执行队列并保留本地来源", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "本地项目",
    repositoryUrl: null,
    repositoryPath: "/tmp/devloop-local-project",
    defaultBaseRef: "main",
    headCommit: "local-base-commit",
    lastFetchedAt: null,
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "本地任务",
    goal: "验证本地项目可以执行",
    acceptanceCriteria: ["任务被 Worker 领取"],
    priority: 50,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });

  const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });

  expect(repository.findProjectByPath("/tmp/devloop-local-project")?.id).toBe(project.id);
  expect(project.lastFetchedAt).toBeNull();
  expect(claimed?.value).toMatchObject({
    projectPath: "/tmp/devloop-local-project",
    projectRepositoryUrl: null,
    projectDefaultBaseRef: "main",
  });
});

it("草稿分数从 99 变为 100 后自动进入待执行", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "自动入队测试项目",
    repositoryUrl: "git@example.com:team/auto-queue.git",
    repositoryPath: "/tmp/devloop-auto-queue-test",
    defaultBaseRef: "main",
    headCommit: "test-base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "自动入队测试任务",
    goal: "验证满分草稿自动进入待执行",
    acceptanceCriteria: ["草稿生成不可变 Revision", "任务状态变为 READY"],
    priority: 99,
  }).value;

  expect(repository.autoQueueTask(draft.id, "local-desktop")).toBeNull();
  expect(repository.getTask(draft.id)?.status).toBe("DRAFT");

  const updated = repository.updateDraftTask(draft.id, "local-desktop", {
    priority: 100,
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
  }).value;
  const queued = repository.autoQueueTask(updated.id, "local-desktop");

  expect(queued?.value.status).toBe("READY");
  expect(queued?.value.targetBranch).toBe("main");
  expect(queued?.value.activeRevisionId).not.toBeNull();
  expect(queued?.events.map((event) => event.type)).toContain("task.status_changed");
});

it("远程推送成功后完成审核并记录结果 Commit", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "结果应用测试项目",
    repositoryUrl: "git@example.com:team/apply-result.git",
    repositoryPath: "/tmp/devloop-apply-result-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "feature/result-apply",
    title: "应用结果 Commit",
    goal: "验证审核后的结果应用事件",
    acceptanceCriteria: ["记录 run.applied 事件"],
    priority: 50,
  }).value;
  repository.confirmTask(draft.id, "local-desktop", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const claimed = repository.claimNextTask();
  expect(claimed).not.toBeNull();
  expect(claimed!.value.run.targetBranch).toBe("feature/result-apply");
  const completed = repository.completeRun(
    claimed!.value.run.id,
    claimed!.value.run.executionToken,
    "执行完成",
    "result-commit",
  ).value;
  expect(repository.getRunPublishContext(claimed!.value.run.id, completed.task.version)).toEqual({
    repositoryPath: "/tmp/devloop-apply-result-test",
    targetBranch: "feature/result-apply",
    baseCommit: "base-commit",
    resultCommit: "result-commit",
  });

  const idempotencyKey = randomUUID();
  const publication = {
    status: "pushed" as const,
    branch: "feature/result-apply",
    previousCommit: null,
    currentCommit: "result-commit",
    branchCreated: true,
  };
  const recorded = repository.approvePublishedRun(
    claimed!.value.run.id,
    "local-desktop",
    completed.task.version,
    idempotencyKey,
    publication,
  );
  expect(recorded.value.task.status).toBe("COMPLETED");
  expect(recorded.value.publication).toEqual(publication);
  expect(repository.listProjects()[0]?.integrationCommit).toBe("result-commit");
  expect(repository.getRun(claimed!.value.run.id)?.pushedCommit).toBe("result-commit");
  expect(recorded.events.map((event) => event.type)).toContain("run.pushed");
  expect(repository.getRunEvents(claimed!.value.run.id).at(-1)?.type).toBe("run.pushed");

  const replayed = repository.approvePublishedRun(
    claimed!.value.run.id,
    "local-desktop",
    completed.task.version,
    idempotencyKey,
    publication,
  );
  expect(replayed.replayed).toBe(true);
  expect(replayed.value.publication).toEqual(publication);
});

it("本地结果写回后完成审核并推进本地集成基线", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "本地审核项目",
    repositoryUrl: null,
    repositoryPath: "/tmp/devloop-local-approval-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
    lastFetchedAt: null,
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "写回本地结果",
    goal: "把审核通过的结果写入本地分支",
    acceptanceCriteria: ["记录 run.applied 事件"],
    priority: 50,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  const completed = repository.completeRun(
    claimed!.value.run.id,
    claimed!.value.run.executionToken,
    "本地执行完成",
    "result-commit",
  ).value;

  expect(repository.getRunApprovalContext(claimed!.value.run.id, completed.task.version)).toEqual({
    type: "local",
    context: {
      projectPath: "/tmp/devloop-local-approval-test",
      targetBranch: "main",
      baseCommit: "base-commit",
      resultCommit: "result-commit",
    },
  });

  const approved = repository.approveAppliedRun(
    claimed!.value.run.id,
    "instance-owner",
    completed.task.version,
    randomUUID(),
    {
      status: "applied",
      branch: "main",
      previousCommit: "base-commit",
      currentCommit: "applied-commit",
      branchCreated: false,
      workingTreeUpdated: true,
    },
  );

  expect(approved.value.task.status).toBe("COMPLETED");
  expect(repository.listProjects()[0]?.integrationCommit).toBe("applied-commit");
  expect(approved.events.map((event) => event.type)).toContain("run.applied");
  expect(repository.getRunEvents(claimed!.value.run.id).at(-1)?.type).toBe("run.applied");
});
