import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
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

it("远端已经包含结果并继续前进时仍可完成审核", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "审核重试测试项目",
    repositoryUrl: "git@example.com:team/approval-retry.git",
    repositoryPath: "/tmp/devloop-approval-retry-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "恢复推送后的审核",
    goal: "验证远端包含结果后的审核重试",
    acceptanceCriteria: ["记录远端实际头 Commit"],
    priority: 100,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const claimed = repository.claimNextTask();
  expect(claimed).not.toBeNull();
  const completed = repository.completeRun(
    claimed!.value.run.id,
    claimed!.value.run.executionToken,
    "执行完成",
    "result-commit",
  ).value;
  const publication = {
    status: "already_pushed" as const,
    branch: "main",
    previousCommit: "remote-later-commit",
    currentCommit: "remote-later-commit",
    branchCreated: false,
  };

  const approved = repository.approvePublishedRun(
    claimed!.value.run.id,
    "instance-owner",
    completed.task.version,
    randomUUID(),
    publication,
  );

  expect(approved.value.task.status).toBe("COMPLETED");
  expect(repository.getRun(claimed!.value.run.id)?.resultCommit).toBe("result-commit");
  expect(repository.getRun(claimed!.value.run.id)?.pushedCommit).toBe("remote-later-commit");
  expect(repository.listProjects()[0]?.integrationCommit).toBe("remote-later-commit");
});

it("软删除后不再出现在任务列表和调度队列，但执行历史仍保留", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "软删除测试项目",
    repositoryUrl: "git@example.com:team/soft-delete.git",
    repositoryPath: "/tmp/devloop-soft-delete-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "待删除任务",
    goal: "验证任务软删除",
    acceptanceCriteria: ["任务从看板隐藏", "历史数据仍然保留"],
    priority: 50,
  }).value;
  const ready = repository.confirmTask(draft.id, "local-desktop", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;

  const deleted = repository.deleteTask(ready.id, "local-desktop", ready.version, randomUUID());

  expect(deleted.value.deletedAt).not.toBeNull();
  expect(repository.getTask(ready.id)).toBeNull();
  expect(repository.getTaskIncludingDeleted(ready.id)?.title).toBe("待删除任务");
  expect(repository.listTasks()).toHaveLength(0);
  expect(repository.claimNextTask()).toBeNull();
  expect(deleted.events.map((event) => event.type)).toContain("task.deleted");
});

it("执行中的任务不能直接删除，取消后 Task 和 Run 同时进入已取消", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "取消测试项目",
    repositoryUrl: "git@example.com:team/cancel.git",
    repositoryPath: "/tmp/devloop-cancel-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "执行中任务",
    goal: "验证取消执行",
    acceptanceCriteria: ["Task 和 Run 均进入 CANCELLED"],
    priority: 100,
  }).value;
  repository.confirmTask(draft.id, "local-desktop", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const claimed = repository.claimNextTask();
  expect(claimed).not.toBeNull();

  expect(() =>
    repository.deleteTask(
      claimed!.value.task.id,
      "local-desktop",
      claimed!.value.task.version,
      randomUUID(),
    ),
  ).toThrow("执行中的任务不能删除");

  const idempotencyKey = randomUUID();
  const cancelled = repository.cancelRunningTask(
    claimed!.value.task.id,
    "local-desktop",
    claimed!.value.task.version,
    idempotencyKey,
  );
  expect(cancelled.value.task.status).toBe("CANCELLED");
  expect(cancelled.value.run.status).toBe("CANCELLED");
  expect(cancelled.value.run.executionToken).not.toBe(claimed!.value.run.executionToken);
  expect(repository.getWorkerState().activeRunId).toBeNull();
  expect(repository.getRunEvents(claimed!.value.run.id).at(-1)?.type).toBe("run.cancelled");

  expect(() =>
    repository.completeRun(
      claimed!.value.run.id,
      claimed!.value.run.executionToken,
      "迟到的成功结果",
    ),
  ).toThrow("执行令牌已经失效");

  const replayed = repository.cancelRunningTask(
    claimed!.value.task.id,
    "local-desktop",
    claimed!.value.task.version,
    idempotencyKey,
  );
  expect(replayed.replayed).toBe(true);
  expect(replayed.value.task.status).toBe("CANCELLED");
});

it("持久化并发上限并返回全部活跃 Run", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "并发 Worker 测试项目",
    repositoryUrl: "git@example.com:team/concurrency.git",
    repositoryPath: "/tmp/devloop-concurrency-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const first = createReadyTask(repository, project.id, "并发任务一", 90);
  const second = createReadyTask(repository, project.id, "并发任务二", 80);

  expect(repository.getWorkerState()).toMatchObject({
    concurrencyLimit: 1,
    activeRunIds: [],
  });
  const configured = repository.setWorkerConcurrency(2).value;
  expect(configured.concurrencyLimit).toBe(2);

  const firstClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  const secondClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(firstClaim?.value.task.id).toBe(first.id);
  expect(secondClaim?.value.task.id).toBe(second.id);
  const expectedRunIds = [firstClaim!.value.run.id, secondClaim!.value.run.id].sort();
  const activeState = repository.getWorkerState();
  expect([...activeState.activeRunIds].sort()).toEqual(expectedRunIds);
  expect(
    repository
      .listActiveRuns()
      .map((run) => run.id)
      .sort(),
  ).toEqual(expectedRunIds);

  const secondaryClaim =
    activeState.activeRunId === firstClaim!.value.run.id ? secondClaim! : firstClaim!;
  const primaryClaim = secondaryClaim === firstClaim ? secondClaim! : firstClaim!;
  const cancelled = repository.cancelRunningTask(
    secondaryClaim.value.task.id,
    "instance-owner",
    secondaryClaim.value.task.version,
    randomUUID(),
  ).value;
  expect(cancelled.run.status).toBe("CANCELLED");
  expect(repository.getWorkerState().activeRunIds).toEqual([primaryClaim.value.run.id]);

  repository.completeRun(
    primaryClaim.value.run.id,
    primaryClaim.value.run.executionToken,
    "第一条完成",
  );
  expect(repository.getWorkerState().activeRunIds).toEqual([]);
});

it("驳回最新成功执行后把审核反馈传入下一 Revision，并拒绝驳回旧 Run", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "审核反馈测试项目",
    repositoryUrl: "git@example.com:team/review-feedback.git",
    repositoryPath: "/tmp/devloop-review-feedback-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "feature/review-feedback",
    title: "处理审核反馈",
    goal: "按审核意见完善实现",
    acceptanceCriteria: ["补充回归测试", "保留现有行为"],
    priority: 50,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const firstClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(firstClaim).not.toBeNull();
  const firstCompleted = repository.completeRun(
    firstClaim!.value.run.id,
    firstClaim!.value.run.executionToken,
    "第一轮执行完成",
    "first-result-commit",
  ).value;
  const feedback = "缺少边界条件回归测试，请补充后重新提交。";

  const rejected = repository.rejectRun(
    firstClaim!.value.run.id,
    "instance-owner",
    firstCompleted.task.version,
    randomUUID(),
    feedback,
  );

  expect(rejected.value.status).toBe("READY");
  expect(rejected.events.map((event) => event.type)).toContain("run.rejected");
  expect(repository.getRunEvents(firstClaim!.value.run.id).at(-1)).toMatchObject({
    type: "run.rejected",
    message: `审核已驳回：${feedback}`,
  });
  expect(repository.getTaskRevision(rejected.value.activeRevisionId!)).toMatchObject({
    baseStrategy: "PINNED",
    baseRef: "first-result-commit",
    confirmedBaseCommit: "first-result-commit",
    reviewFeedback: feedback,
  });

  const retryClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(retryClaim?.value).toMatchObject({
    title: "处理审核反馈",
    goal: "按审核意见完善实现",
    acceptanceCriteria: ["补充回归测试", "保留现有行为"],
    reviewFeedback: feedback,
    continuationBaseCommit: "base-commit",
    continuationResultCommit: "first-result-commit",
    run: { baseCommit: "first-result-commit" },
  });
  const blockedRetry = repository.blockRun(
    retryClaim!.value.run.id,
    retryClaim!.value.run.executionToken,
    "第二轮暂时阻塞",
  ).value.task;
  const directRetry = repository.confirmTask(blockedRetry.id, "instance-owner", {
    expectedVersion: blockedRetry.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;
  const directRetryClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(directRetryClaim?.value).toMatchObject({
    reviewFeedback: feedback,
    continuationBaseCommit: "base-commit",
    continuationResultCommit: "first-result-commit",
    run: { baseCommit: "first-result-commit", taskRevisionId: directRetry.activeRevisionId },
  });

  expect(() =>
    repository.rejectRun(
      firstClaim!.value.run.id,
      "instance-owner",
      directRetryClaim!.value.task.version,
      randomUUID(),
      "错误地驳回旧 Run",
    ),
  ).toThrow("只有任务最近一次成功执行可以驳回");
});

it("完整读取 Run 对应的不可变 Revision、审核决定和事件 payload", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "运行审计测试项目",
    repositoryUrl: "git@example.com:team/run-audit.git",
    repositoryPath: "/tmp/devloop-run-audit-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "feature/run-audit",
    title: "原始任务标题",
    goal: "保留运行时任务快照",
    acceptanceCriteria: ["可读取命令详情", "可读取驳回反馈"],
    priority: 50,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(claimed).not.toBeNull();

  repository.setRunPhase(
    claimed!.value.run.id,
    claimed!.value.run.executionToken,
    "AGENT_RUNNING",
    "runner.agent",
    "Codex 命令执行完成，退出码 1",
    {
      event: {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "pnpm test",
          exit_code: 1,
          aggregated_output: "1 test failed",
        },
      },
    },
  );
  const completed = repository.completeRun(
    claimed!.value.run.id,
    claimed!.value.run.executionToken,
    "等待审核",
    "result-commit",
  ).value;
  const conflictEvent = repository.recordRunEvent(
    claimed!.value.run.id,
    "run.conflict_resolution.completed",
    "Agent 已生成冲突解决建议",
    {
      targetCommit: "target-commit",
      resolutions: [{ path: "README.md", strategy: "content", content: "resolved\n" }],
    },
  );
  expect(conflictEvent.replayed).toBe(false);
  expect(conflictEvent.events).toEqual([
    expect.objectContaining({
      aggregateType: "run",
      aggregateId: claimed!.value.run.id,
      type: "run.step_changed",
    }),
  ]);
  const feedback = "命令失败详情需要保留。";
  const rejected = repository.rejectRun(
    claimed!.value.run.id,
    "instance-owner",
    completed.task.version,
    randomUUID(),
    feedback,
  ).value;
  const reopened = repository.unconfirmTask(
    rejected.id,
    "instance-owner",
    rejected.version,
    randomUUID(),
  ).value;
  repository.updateDraftTask(reopened.id, "instance-owner", {
    title: "后来修改的任务标题",
    goal: "当前任务内容不应覆盖旧 Run",
    acceptanceCriteria: ["当前内容已变化"],
    expectedVersion: reopened.version,
    idempotencyKey: randomUUID(),
  });

  expect(repository.getTaskIncludingDeleted(draft.id)?.title).toBe("后来修改的任务标题");
  expect(repository.getTaskRevision(claimed!.value.run.taskRevisionId)).toMatchObject({
    id: claimed!.value.run.taskRevisionId,
    taskId: draft.id,
    revision: 1,
    title: "原始任务标题",
    goal: "保留运行时任务快照",
    acceptanceCriteria: ["可读取命令详情", "可读取驳回反馈"],
    reviewFeedback: null,
    createdFrom: "draft",
    createdByDeviceId: "instance-owner",
  });
  expect(repository.getRunReviewDecision(claimed!.value.run.id)).toMatchObject({
    runId: claimed!.value.run.id,
    decision: "REJECTED",
    feedback,
    deviceId: "instance-owner",
  });
  expect(
    repository
      .getRunEvents(claimed!.value.run.id)
      .find((event) => event.message === "Codex 命令执行完成，退出码 1")?.payload,
  ).toEqual({
    status: "AGENT_RUNNING",
    event: {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "pnpm test",
        exit_code: 1,
        aggregated_output: "1 test failed",
      },
    },
  });
  expect(
    repository
      .getRunEvents(claimed!.value.run.id)
      .find((event) => event.type === "run.conflict_resolution.completed")?.payload,
  ).toEqual({
    targetCommit: "target-commit",
    resolutions: [{ path: "README.md", strategy: "content", content: "resolved\n" }],
  });
});
