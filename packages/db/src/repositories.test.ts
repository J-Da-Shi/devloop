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
});
