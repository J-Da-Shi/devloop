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

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
});

describe("DevLoopRepository 自动入队", () => {
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

    const firstClaim = repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z");
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
      repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z")?.value.autoResolveConflicts,
    ).toBe(false);
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

    const claimed = repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z");

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
    const claimed = repository.claimNextTask("codex");
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
    const claimed = repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z");
    const completed = repository.completeRun(
      claimed!.value.run.id,
      claimed!.value.run.executionToken,
      "本地执行完成",
      "result-commit",
    ).value;

    expect(repository.getRunApprovalContext(claimed!.value.run.id, completed.task.version)).toEqual(
      {
        type: "local",
        context: {
          projectPath: "/tmp/devloop-local-approval-test",
          targetBranch: "main",
          baseCommit: "base-commit",
          resultCommit: "result-commit",
        },
      },
    );

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
    const claimed = repository.claimNextTask("codex");
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
    expect(repository.claimNextTask("fake")).toBeNull();
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
    const claimed = repository.claimNextTask("fake");
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
    const firstClaim = repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z");
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

    const retryClaim = repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z");
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
    const directRetryClaim = repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z");
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
    const claimed = repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z");
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

  it("阻塞任务可直接重试，失败任务可退回草稿修改后重试", () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "任务恢复测试项目",
      repositoryUrl: "git@example.com:team/task-recovery.git",
      repositoryPath: "/tmp/devloop-task-recovery-test",
      defaultBaseRef: "main",
      headCommit: "base-commit",
    }).value;
    const draft = repository.createTask({
      projectId: project.id,
      targetBranch: "feature/recovery",
      title: "恢复失败任务",
      goal: "验证直接重试和修改后重试",
      acceptanceCriteria: ["保留运行历史"],
      priority: 80,
    }).value;
    const ready = repository.confirmTask(draft.id, "instance-owner", {
      expectedVersion: draft.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: "main",
    }).value;
    const firstRevisionId = ready.activeRevisionId;
    const firstClaim = repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z");
    expect(firstClaim).not.toBeNull();
    const blocked = repository.blockRun(
      firstClaim!.value.run.id,
      firstClaim!.value.run.executionToken,
      "外部依赖不可用",
    ).value.task;

    const directRetry = repository.confirmTask(blocked.id, "instance-owner", {
      expectedVersion: blocked.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: "main",
    }).value;
    expect(directRetry.status).toBe("READY");
    expect(directRetry.activeRevisionId).not.toBe(firstRevisionId);

    const secondClaim = repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z");
    expect(secondClaim?.value.run.taskRevisionId).toBe(directRetry.activeRevisionId);
    const failed = repository.failRun(
      secondClaim!.value.run.id,
      secondClaim!.value.run.executionToken,
      "测试命令失败",
    ).value.task;

    const reopened = repository.unconfirmTask(
      failed.id,
      "instance-owner",
      failed.version,
      randomUUID(),
    ).value;
    expect(reopened.status).toBe("DRAFT");
    const edited = repository.updateDraftTask(reopened.id, "instance-owner", {
      goal: "补充异常路径处理后再次执行",
      acceptanceCriteria: ["保留运行历史", "异常路径测试通过"],
      expectedVersion: reopened.version,
      idempotencyKey: randomUUID(),
    }).value;
    const revisedRetry = repository.confirmTask(edited.id, "instance-owner", {
      expectedVersion: edited.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: "main",
    }).value;
    const thirdClaim = repository.claimNextTask("codex", "9999-12-31T23:59:59.999Z");

    expect(revisedRetry.status).toBe("READY");
    expect(thirdClaim?.value).toMatchObject({
      goal: "补充异常路径处理后再次执行",
      acceptanceCriteria: ["保留运行历史", "异常路径测试通过"],
      reviewFeedback: null,
    });
  });
});
