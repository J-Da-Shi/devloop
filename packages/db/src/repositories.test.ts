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
  it("草稿分数从 99 变为 100 后自动进入待执行", () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "自动入队测试项目",
      path: "/tmp/devloop-auto-queue-test",
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

  it("审核通过后记录结果已写入目标分支", () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "结果应用测试项目",
      path: "/tmp/devloop-apply-result-test",
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
      "执行完成",
      "result-commit",
    ).value;
    const approved = repository.approveRun(
      claimed!.value.run.id,
      "local-desktop",
      completed.task.version,
      randomUUID(),
    ).value;
    expect(repository.getRunApplicationContext(claimed!.value.run.id, approved.version)).toEqual({
      projectPath: project.path,
      targetBranch: "feature/result-apply",
      baseCommit: "base-commit",
      resultCommit: "result-commit",
    });

    const idempotencyKey = randomUUID();
    const application = {
      status: "applied" as const,
      branch: "feature/result-apply",
      previousCommit: "base-commit",
      currentCommit: "result-commit",
      branchCreated: true,
      workingTreeUpdated: false,
    };
    const recorded = repository.recordRunApplication(
      claimed!.value.run.id,
      "local-desktop",
      approved.version,
      idempotencyKey,
      application,
    );
    expect(recorded.value).toEqual(application);
    expect(repository.findProjectByPath(project.path)?.integrationCommit).toBe("base-commit");
    expect(recorded.events.map((event) => event.type)).toContain("run.applied");
    expect(repository.getRunEvents(claimed!.value.run.id).at(-1)?.type).toBe("run.applied");

    const replayed = repository.recordRunApplication(
      claimed!.value.run.id,
      "local-desktop",
      approved.version,
      idempotencyKey,
      application,
    );
    expect(replayed.replayed).toBe(true);
    expect(replayed.value).toEqual(application);
  });
});
