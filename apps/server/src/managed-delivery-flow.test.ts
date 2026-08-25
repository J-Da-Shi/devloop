import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DevLoopRepository, openDatabase } from "@devloop/db";
import { FakeRunner } from "@devloop/runners";
import type { TaskStatus } from "@devloop/shared";
import { expect, it } from "vitest";
import { AgentWorker } from "./agent-worker.js";
import { DomainEventBus } from "./event-bus.js";

const migrationsFolder = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

const waitForTaskStatus = async (
  repository: DevLoopRepository,
  taskId: string,
  status: TaskStatus,
): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (repository.getTask(taskId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待自测任务进入 ${status} 状态超时`);
};

it("生成托管任务并完成预算暂停、提高预算和恢复审核", async () => {
  const database = openDatabase({ filePath: ":memory:", migrationsFolder });
  const repository = new DevLoopRepository(database);
  const initialSettings = repository.getManagedDeliverySettings();
  repository.updateManagedDeliverySettings({
    ...initialSettings,
    runnerHourlyRatesCents: {
      ...initialSettings.runnerHourlyRatesCents,
      fake: 360_000,
    },
    expectedVersion: initialSettings.version,
  });
  const project = repository.createProject({
    name: "托管流程自测项目",
    repositoryUrl: null,
    repositoryPath: "/tmp/devloop-managed-flow-project",
    defaultBaseRef: "main",
    headCommit: "base-commit",
    lastFetchedAt: null,
    runner: "codex",
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    taskType: "DEVELOPMENT",
    targetBranch: "main",
    executionMode: "MANAGED",
    budgetHardLimitCents: 100,
    title: "验证托管预算恢复",
    goal: "达到预算上限后停止，提高预算后继续到待审核",
    acceptanceCriteria: ["预算暂停", "恢复执行", "进入待审核"],
    priority: 50,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });

  let budgetClock = 0;
  const worker = new AgentWorker(
    repository,
    new FakeRunner(20),
    new DomainEventBus(),
    "/tmp/schema.json",
    {
      claimDelayMs: 0,
      budgetCheckIntervalMs: 5,
      budgetNow: () => {
        budgetClock += 3_600_000;
        return budgetClock;
      },
    },
  );

  try {
    worker.start();
    await waitForTaskStatus(repository, draft.id, "BUDGET_PAUSED");
    const paused = repository.getTask(draft.id);
    expect(paused).toMatchObject({
      status: "BUDGET_PAUSED",
      budget: { consumedCents: 100, hardLimitCents: 100 },
    });
    const pausedRun = paused?.latestRunId ? repository.getRun(paused.latestRunId) : null;
    expect(pausedRun).toMatchObject({ runner: "fake", status: "BUDGET_PAUSED" });
    expect(repository.getRunEvents(pausedRun?.id ?? "").map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.budget.warning", "run.budget.paused"]),
    );

    worker.setStatus("PAUSED");
    const currentSettings = repository.getManagedDeliverySettings();
    repository.updateManagedDeliverySettings({
      ...currentSettings,
      runnerHourlyRatesCents: {
        ...currentSettings.runnerHourlyRatesCents,
        fake: 0,
      },
      expectedVersion: currentSettings.version,
    });
    if (!paused) throw new Error("预算暂停后的任务不存在");
    const resumedDraft = repository.unconfirmTask(
      paused.id,
      "instance-owner",
      paused.version,
      randomUUID(),
    ).value;
    const raised = repository.updateDraftTask(resumedDraft.id, "instance-owner", {
      budgetHardLimitCents: 200,
      expectedVersion: resumedDraft.version,
      idempotencyKey: randomUUID(),
    }).value;
    const ready = repository.confirmTask(raised.id, "instance-owner", {
      expectedVersion: raised.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: "main",
    }).value;
    const revision = ready.activeRevisionId
      ? repository.getTaskRevision(ready.activeRevisionId)
      : null;
    expect(revision?.retryContext).toMatchObject({
      sourceStatus: "BUDGET_PAUSED",
      sourceRunId: pausedRun?.id,
    });

    worker.setStatus("RUNNING");
    await waitForTaskStatus(repository, draft.id, "REVIEW");
    const reviewed = repository.getTask(draft.id);
    expect(reviewed).toMatchObject({
      status: "REVIEW",
      budget: { consumedCents: 100, hardLimitCents: 200 },
    });
    expect(reviewed?.latestRunId).not.toBe(pausedRun?.id);
    expect(reviewed?.latestRunId ? repository.getRun(reviewed.latestRunId) : null).toMatchObject({
      runner: "fake",
      status: "SUCCEEDED",
      budget: { estimatedCostCents: 0, hardLimitCents: 200 },
    });
  } finally {
    await worker.stop();
    database.close();
  }
});
