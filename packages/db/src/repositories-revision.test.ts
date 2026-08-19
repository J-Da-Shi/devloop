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

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
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
  const firstRevisionId = repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value.activeRevisionId;
  const firstClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
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

  const secondClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
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
  const thirdClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });

  expect(revisedRetry.status).toBe("READY");
  expect(thirdClaim?.value).toMatchObject({
    goal: "补充异常路径处理后再次执行",
    acceptanceCriteria: ["保留运行历史", "异常路径测试通过"],
    reviewFeedback: null,
  });
});

it("失败重试会冻结失败诊断，并从已保存的结果 Commit 继续", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "失败续跑项目",
    repositoryUrl: "git@example.com:team/retry-context.git",
    repositoryPath: "/tmp/devloop-retry-context-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "从失败处继续",
    goal: "保留失败轮已完成的实现并继续修复测试",
    acceptanceCriteria: ["失败上下文会传给下一轮"],
    priority: 80,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const firstClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(firstClaim).not.toBeNull();
  repository.recordRunEvent(firstClaim!.value.run.id, "runner.command", "pnpm test 退出码 1", {
    command: "pnpm test",
  });
  const failed = repository.failRun(
    firstClaim!.value.run.id,
    firstClaim!.value.run.executionToken,
    "测试失败：缺少异常路径断言",
    "partial-result-commit",
  ).value.task;

  const retry = repository.confirmTask(failed.id, "instance-owner", {
    expectedVersion: failed.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;
  const retryRevision = repository.getTaskRevision(retry.activeRevisionId!);
  expect(retryRevision).toMatchObject({
    baseStrategy: "PINNED",
    baseRef: "partial-result-commit",
    confirmedBaseCommit: "partial-result-commit",
    retryContext: {
      sourceRunId: firstClaim!.value.run.id,
      sourceStatus: "FAILED",
      summary: "测试失败：缺少异常路径断言",
      baseCommit: "base-commit",
      resultCommit: "partial-result-commit",
    },
  });
  expect(retryRevision?.retryContext?.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "runner.command", message: "pnpm test 退出码 1" }),
      expect.objectContaining({ type: "run.failed", message: "测试失败：缺少异常路径断言" }),
    ]),
  );

  const retryClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(retryClaim?.value).toMatchObject({
    run: { baseCommit: "partial-result-commit" },
    continuationBaseCommit: "base-commit",
    continuationResultCommit: "partial-result-commit",
    retryContext: {
      sourceRunId: firstClaim!.value.run.id,
      resultCommit: "partial-result-commit",
    },
  });
});

it("已完成任务可以继续迭代，并以最新已接受结果为下一轮基础", () => {
  const repository = createRepository();
  const project = repository.createProject({
    name: "完成任务迭代项目",
    repositoryUrl: "git@example.com:team/completed-continuation.git",
    repositoryPath: "/tmp/devloop-completed-continuation-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    title: "第一轮需求",
    goal: "完成初始功能",
    acceptanceCriteria: ["初始验收通过"],
    priority: 50,
  }).value;
  const firstReady = repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;
  const firstClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  const firstCompleted = repository.completeRun(
    firstClaim!.value.run.id,
    firstClaim!.value.run.executionToken,
    "第一轮完成",
    "first-result-commit",
  ).value;
  const rejected = repository.rejectRun(
    firstClaim!.value.run.id,
    "instance-owner",
    firstCompleted.task.version,
    randomUUID(),
    "请补充边界处理",
  ).value;
  const secondClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  const secondCompleted = repository.completeRun(
    secondClaim!.value.run.id,
    secondClaim!.value.run.executionToken,
    "第二轮完成",
    "second-result-commit",
  ).value;
  const approved = repository.approvePublishedRun(
    secondClaim!.value.run.id,
    "instance-owner",
    secondCompleted.task.version,
    randomUUID(),
    {
      status: "pushed",
      branch: "main",
      previousCommit: "first-result-commit",
      currentCommit: "second-result-commit",
      branchCreated: false,
    },
  ).value;

  const continueKey = randomUUID();
  const continued = repository.continueCompletedTask(
    approved.task.id,
    "instance-owner",
    approved.task.version,
    continueKey,
  ).value;
  expect(continued.status).toBe("DRAFT");
  expect(continued.activeRevisionId).toBe(secondClaim!.value.run.taskRevisionId);
  expect(
    repository.continueCompletedTask(
      approved.task.id,
      "instance-owner",
      approved.task.version,
      continueKey,
    ).replayed,
  ).toBe(true);

  const edited = repository.updateDraftTask(continued.id, "instance-owner", {
    goal: "在初始功能上继续完善边界处理",
    acceptanceCriteria: ["初始验收通过", "边界处理有回归测试"],
    expectedVersion: continued.version,
    idempotencyKey: randomUUID(),
  }).value;
  const nextReady = repository.confirmTask(edited.id, "instance-owner", {
    expectedVersion: edited.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;
  const nextRevision = repository.getTaskRevision(nextReady.activeRevisionId!);
  expect(nextRevision).toMatchObject({
    revision: 3,
    createdFrom: secondClaim!.value.run.taskRevisionId,
    goal: "在初始功能上继续完善边界处理",
    acceptanceCriteria: ["初始验收通过", "边界处理有回归测试"],
    reviewFeedback: null,
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
    confirmedBaseCommit: "second-result-commit",
  });

  const nextClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  expect(nextClaim?.value).toMatchObject({
    goal: "在初始功能上继续完善边界处理",
    continuationBaseCommit: null,
    continuationResultCommit: null,
    reviewFeedback: null,
    run: { baseCommit: "second-result-commit" },
  });
  expect(firstReady.activeRevisionId).not.toBe(nextReady.activeRevisionId);
  expect(rejected.activeRevisionId).not.toBe(nextReady.activeRevisionId);
});
