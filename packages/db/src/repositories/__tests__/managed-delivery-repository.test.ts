import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../../database/client.js";
import { DevLoopRepository } from "../index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const handles: DatabaseHandle[] = [];

const createRepository = (): DevLoopRepository => {
  const handle = openDatabase({ filePath: ":memory:", migrationsFolder });
  handles.push(handle);
  return new DevLoopRepository(handle);
};

const createProject = (repository: DevLoopRepository) =>
  repository.createProject({
    name: "托管交付测试项目",
    repositoryUrl: null,
    repositoryPath: `/tmp/devloop-managed-${randomUUID()}`,
    defaultBaseRef: "main",
    headCommit: "base-commit",
    lastFetchedAt: null,
  }).value;

const createReadyTask = (
  repository: DevLoopRepository,
  projectId: string,
  budgetHardLimitCents = 1_000,
) => {
  const draft = repository.createTask({
    projectId,
    targetBranch: "main",
    executionMode: "MANAGED",
    budgetHardLimitCents,
    title: "执行托管任务",
    goal: "完成实现并保留预算和失败上下文",
    acceptanceCriteria: ["任务状态可追踪", "达到预算后自动停止"],
    priority: 50,
  }).value;
  return repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;
};

const claimNextTask = (repository: DevLoopRepository) => {
  const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  if (!claimed) throw new Error("测试任务未被领取");
  return claimed;
};

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

describe("托管预算", () => {
  it("根据任务内容和 Runner 费率生成预算区间与硬上限", () => {
    const repository = createRepository();
    const project = createProject(repository);
    const estimate = repository.estimateTaskBudget(project.id, {
      taskType: "DEVELOPMENT",
      executionMode: "MANAGED",
      title: "实现预算管理",
      goal: "输入目标后估算任务执行时间和成本，并在超过硬上限时停止执行。",
      acceptanceCriteria: ["显示预算区间", "超过上限自动停止"],
    });

    expect(estimate).toMatchObject({
      currency: "CNY",
      confidence: "LOW",
      consumedCents: 0,
      warningPercent: 80,
    });
    expect(estimate.lowCents).toBeGreaterThan(0);
    expect(estimate.highCents).toBeGreaterThanOrEqual(estimate.lowCents);
    expect(estimate.hardLimitCents).toBeGreaterThanOrEqual(estimate.highCents);
    expect(estimate.hardLimitCents).toBeLessThanOrEqual(10_000);
  });

  it("在 80% 触发一次预警，并在硬上限暂停且保留检查点", () => {
    const repository = createRepository();
    const project = createProject(repository);
    createReadyTask(repository, project.id);
    const claimed = claimNextTask(repository);

    const belowWarning = repository.updateRunBudgetUsage(
      claimed.value.run.id,
      claimed.value.run.executionToken,
      { elapsedMs: 10_000, estimatedCostCents: 799, taskConsumedCents: 799 },
    );
    expect(belowWarning.value.warningTriggered).toBe(false);

    const warning = repository.updateRunBudgetUsage(
      claimed.value.run.id,
      claimed.value.run.executionToken,
      { elapsedMs: 20_000, estimatedCostCents: 800, taskConsumedCents: 800 },
    );
    expect(warning.value.warningTriggered).toBe(true);

    const limit = repository.updateRunBudgetUsage(
      claimed.value.run.id,
      claimed.value.run.executionToken,
      { elapsedMs: 30_000, estimatedCostCents: 1_000, taskConsumedCents: 1_000 },
    );
    expect(limit.value.warningTriggered).toBe(false);

    const paused = repository.pauseRunForBudget(
      claimed.value.run.id,
      claimed.value.run.executionToken,
      "达到预算硬上限",
      "checkpoint-commit",
    ).value;
    expect(paused).toMatchObject({
      task: { status: "BUDGET_PAUSED", budget: { consumedCents: 1_000 } },
      run: { status: "BUDGET_PAUSED", resultCommit: "checkpoint-commit" },
    });
    expect(
      repository
        .getRunEvents(claimed.value.run.id)
        .filter((event) => event.type.startsWith("run.budget.")),
    ).toEqual([
      expect.objectContaining({ type: "run.budget.warning" }),
      expect.objectContaining({ type: "run.budget.paused" }),
    ]);
  });

  it("预算暂停后必须提高上限，恢复时携带暂停上下文和结果 Commit", () => {
    const repository = createRepository();
    const project = createProject(repository);
    createReadyTask(repository, project.id);
    const claimed = claimNextTask(repository);
    repository.updateRunBudgetUsage(claimed.value.run.id, claimed.value.run.executionToken, {
      elapsedMs: 30_000,
      estimatedCostCents: 1_000,
      taskConsumedCents: 1_000,
    });
    const paused = repository.pauseRunForBudget(
      claimed.value.run.id,
      claimed.value.run.executionToken,
      "达到预算硬上限",
      "checkpoint-commit",
    ).value.task;
    expect(() =>
      repository.confirmTask(paused.id, "instance-owner", {
        expectedVersion: paused.version,
        idempotencyKey: randomUUID(),
        baseStrategy: "LATEST_ACCEPTED",
        baseRef: "main",
      }),
    ).toThrow("预算硬上限必须高于已消耗金额");

    const draft = repository.unconfirmTask(
      paused.id,
      "instance-owner",
      paused.version,
      randomUUID(),
    ).value;
    const raised = repository.updateDraftTask(draft.id, "instance-owner", {
      budgetHardLimitCents: 1_500,
      expectedVersion: draft.version,
      idempotencyKey: randomUUID(),
    }).value;
    const resumed = repository.confirmTask(raised.id, "instance-owner", {
      expectedVersion: raised.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: "main",
    }).value;
    if (!resumed.activeRevisionId) throw new Error("恢复任务缺少 Revision");
    const revision = repository.getTaskRevision(resumed.activeRevisionId);
    expect(resumed.budget).toMatchObject({ hardLimitCents: 1_500, consumedCents: 1_000 });
    expect(revision?.retryContext).toMatchObject({
      sourceStatus: "BUDGET_PAUSED",
      resultCommit: "checkpoint-commit",
    });
    expect(revision).toMatchObject({
      baseStrategy: "PINNED",
      baseRef: "checkpoint-commit",
    });
    const resumedClaim = claimNextTask(repository);
    expect(resumedClaim.value).toMatchObject({
      continuationBaseCommit: "base-commit",
      continuationResultCommit: "checkpoint-commit",
    });
  });
});

describe("托管失败重试", () => {
  it("退避到期后自动排队，并在重试上限后保留失败状态", () => {
    const repository = createRepository();
    const project = createProject(repository);
    createReadyTask(repository, project.id);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = claimNextTask(repository);
      const failed = repository.failRun(
        claimed.value.run.id,
        claimed.value.run.executionToken,
        `第 ${attempt} 次失败`,
        `checkpoint-${attempt}`,
      ).value.task;
      expect(failed).toMatchObject({ status: "FAILED", managedRetryCount: attempt });
      const retries = repository.queueDueManagedRetries("9999-12-31T23:59:59.999Z");
      if (attempt <= 2) {
        expect(retries).toHaveLength(1);
        expect(retries[0]?.value.status).toBe("READY");
      } else {
        expect(retries).toHaveLength(0);
        expect(repository.getTask(failed.id)?.status).toBe("FAILED");
      }
    }
  });
});
