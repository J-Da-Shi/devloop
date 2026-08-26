import { randomUUID } from "node:crypto";
import {
  assertTaskTransition,
  type ManagedDeliverySettings,
  type Task,
  type TaskRun,
  type UpdateManagedDeliverySettingsInput,
} from "@devloop/shared";
import { and, eq, isNull, lte } from "drizzle-orm";
import { managedDeliverySettings, taskRuns, tasks } from "../database/schema.js";
import {
  estimateTaskBudget,
  type TaskBudgetEstimateRequest,
} from "../budget/task-budget-estimator.js";
import { mapRun, mapTask, now, parseProjectRunner } from "./repository-codecs.js";
import { DeviceRepository } from "./device-repository.js";
import type { EventfulResult } from "./repository-types.js";

const mapSettings = (
  row: typeof managedDeliverySettings.$inferSelect,
): ManagedDeliverySettings => ({
  maxTaskBudgetCents: row.maxTaskBudgetCents,
  warningPercent: row.warningPercent,
  budgetOverrunPercent: row.budgetOverrunPercent,
  autoRetryLimit: row.autoRetryLimit,
  runnerHourlyRatesCents: {
    codex: row.codexHourlyRateCents,
    "claude-code": row.claudeCodeHourlyRateCents,
    fake: row.fakeHourlyRateCents,
  },
  version: row.version,
  updatedAt: row.updatedAt,
});

export class ManagedDeliveryRepository extends DeviceRepository {
  getManagedDeliverySettings(): ManagedDeliverySettings {
    const row = this.handle.db
      .select()
      .from(managedDeliverySettings)
      .where(eq(managedDeliverySettings.id, "primary"))
      .get();
    if (!row) throw new Error("托管交付设置尚未初始化");
    return mapSettings(row);
  }

  estimateTaskBudget(projectId: string, input: TaskBudgetEstimateRequest) {
    const project = this.requireProjectRow(projectId);
    return estimateTaskBudget(
      input,
      parseProjectRunner(project.runner),
      this.getManagedDeliverySettings(),
    );
  }

  updateManagedDeliverySettings(
    input: UpdateManagedDeliverySettingsInput,
  ): EventfulResult<ManagedDeliverySettings> {
    const current = this.getManagedDeliverySettings();
    this.assertVersion(current.version, input.expectedVersion);
    const timestamp = now();
    const row = this.handle.db
      .update(managedDeliverySettings)
      .set({
        maxTaskBudgetCents: input.maxTaskBudgetCents,
        warningPercent: input.warningPercent,
        budgetOverrunPercent: input.budgetOverrunPercent,
        autoRetryLimit: input.autoRetryLimit,
        codexHourlyRateCents: input.runnerHourlyRatesCents.codex,
        claudeCodeHourlyRateCents: input.runnerHourlyRatesCents["claude-code"],
        fakeHourlyRateCents: input.runnerHourlyRatesCents.fake,
        version: current.version + 1,
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(managedDeliverySettings.id, "primary"),
          eq(managedDeliverySettings.version, input.expectedVersion),
        ),
      )
      .returning()
      .get();
    if (!row) throw new Error("Version conflict: 托管交付设置已发生变化");
    const event = this.insertDomainEvent("worker", "primary", "managed.settings_changed", {
      version: row.version,
    });
    return { value: mapSettings(row), events: [event], replayed: false };
  }

  updateRunBudgetUsage(
    runId: string,
    executionToken: string,
    input: { elapsedMs: number; estimatedCostCents: number; taskConsumedCents: number },
  ): EventfulResult<{ task: Task; run: TaskRun; warningTriggered: boolean }> {
    return this.handle.sqlite.transaction(() => {
      const currentRun = this.requireRunRow(runId);
      if (currentRun.executionToken !== executionToken || currentRun.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (currentTask.status !== "RUNNING" || currentTask.latestRunId !== runId) {
        throw new Error("当前任务已经不再由此 Run 执行");
      }
      const warningAtCents = Math.ceil(
        (currentTask.budgetHardLimitCents * currentTask.budgetWarningPercent) / 100,
      );
      const warningTriggered =
        currentTask.budgetConsumedCents < warningAtCents &&
        input.taskConsumedCents >= warningAtCents;
      const runRow = this.handle.db
        .update(taskRuns)
        .set({
          budgetElapsedMs: input.elapsedMs,
          budgetEstimatedCostCents: input.estimatedCostCents,
        })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!runRow) throw new Error("当前 Run 的执行令牌已经失效");
      const taskRow = this.handle.db
        .update(tasks)
        .set({ budgetConsumedCents: input.taskConsumedCents })
        .where(and(eq(tasks.id, currentTask.id), eq(tasks.status, "RUNNING")))
        .returning()
        .get();
      if (!taskRow) throw new Error("当前任务已经不再由此 Run 执行");
      if (warningTriggered) {
        this.insertRunEvent(runId, "run.budget.warning", "任务预算已达到预警线", {
          consumedCents: input.taskConsumedCents,
          hardLimitCents: currentTask.budgetHardLimitCents,
          warningPercent: currentTask.budgetWarningPercent,
        });
      }
      const events = [
        this.insertDomainEvent("run", runId, "run.budget_changed", {
          runId,
          consumedCents: input.taskConsumedCents,
          hardLimitCents: currentTask.budgetHardLimitCents,
          warning: warningTriggered,
        }),
      ];
      return {
        value: {
          task: mapTask(taskRow, this.requireProjectRow(taskRow.projectId).name),
          run: mapRun(runRow),
          warningTriggered,
        },
        events,
        replayed: false,
      };
    })();
  }

  pauseRunForBudget(
    runId: string,
    executionToken: string,
    summary: string,
    resultCommit?: string,
  ): EventfulResult<{ task: Task; run: TaskRun }> {
    return this.handle.sqlite.transaction(() => {
      const currentRun = this.requireRunRow(runId);
      if (currentRun.executionToken !== executionToken || currentRun.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (currentTask.status !== "RUNNING" || currentTask.latestRunId !== runId) {
        throw new Error("当前任务已经不再由此 Run 执行");
      }
      assertTaskTransition(currentTask.status, "BUDGET_PAUSED");
      const timestamp = now();
      const runRow = this.handle.db
        .update(taskRuns)
        .set({
          status: "BUDGET_PAUSED",
          summary,
          resultCommit: resultCommit ?? currentRun.resultCommit,
          processGroupId: null,
          finishedAt: timestamp,
        })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!runRow) throw new Error("当前 Run 的执行令牌已经失效");
      const taskRow = this.handle.db
        .update(tasks)
        .set({ status: "BUDGET_PAUSED", version: currentTask.version + 1, updatedAt: timestamp })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, currentTask.version),
            eq(tasks.status, "RUNNING"),
            eq(tasks.latestRunId, runId),
            isNull(tasks.deletedAt),
          ),
        )
        .returning()
        .get();
      if (!taskRow) throw new Error("当前任务已经不再由此 Run 执行");
      this.refreshWorkerActivity(timestamp);
      this.insertRunEvent(runId, "run.budget.paused", summary, {
        consumedCents: taskRow.budgetConsumedCents,
        hardLimitCents: taskRow.budgetHardLimitCents,
      });
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "RUNNING",
        to: "BUDGET_PAUSED",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.finished", {
        runId,
        outcome: "budget_paused",
      });
      return {
        value: {
          task: mapTask(taskRow, this.requireProjectRow(taskRow.projectId).name),
          run: mapRun(runRow),
        },
        events: [taskEvent, runEvent],
        replayed: false,
      };
    })();
  }

  queueManagedRetry(taskId: string): EventfulResult<Task> | null {
    const task = this.getTask(taskId);
    if (
      !task ||
      task.executionMode !== "MANAGED" ||
      task.status !== "FAILED" ||
      task.managedRetryCount > this.getManagedDeliverySettings().autoRetryLimit ||
      task.budget.consumedCents >= task.budget.hardLimitCents
    ) {
      return null;
    }
    const result = this.confirmTask(task.id, "managed-orchestrator", {
      expectedVersion: task.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: task.targetBranch,
    });
    if (task.latestRunId) {
      this.recordRunEvent(
        task.latestRunId,
        "run.managed_retry.queued",
        "托管模式已保存失败上下文并自动安排下一轮执行",
        { nextRevisionId: result.value.activeRevisionId },
      );
    }
    return result;
  }

  queueDueManagedRetries(readyBefore: string): EventfulResult<Task>[] {
    const candidates = this.handle.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "FAILED"),
          eq(tasks.executionMode, "MANAGED"),
          lte(tasks.updatedAt, readyBefore),
          isNull(tasks.deletedAt),
        ),
      )
      .all();
    return candidates.flatMap(({ id }) => {
      const result = this.queueManagedRetry(id);
      return result ? [result] : [];
    });
  }
}
