import { randomUUID } from "node:crypto";
import { assertTaskTransition, type Task, type TaskRun } from "@devloop/shared";
import { and, eq, isNull } from "drizzle-orm";
import { taskRuns, tasks } from "../schema.js";
import { mapRun, mapTask, now } from "./repository-codecs.js";
import { RunClaimRepository } from "./run-claim-repository.js";
import type { EventfulResult } from "./repository-types.js";

export class RunCompletionRepository extends RunClaimRepository {
  completeRun(
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
      assertTaskTransition(currentTask.status, "REVIEW");
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const runRow = this.handle.db
        .update(taskRuns)
        .set({
          status: "SUCCEEDED",
          summary,
          resultCommit: resultCommit ?? currentRun.baseCommit,
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
      if (!runRow) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const taskRow = this.handle.db
        .update(tasks)
        .set({
          status: "REVIEW",
          version: currentTask.version + 1,
          updatedAt: timestamp,
        })
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
      if (!taskRow) {
        throw new Error("当前任务已经不再由此 Run 执行");
      }
      this.refreshWorkerActivity(timestamp);
      this.insertRunEvent(runId, "run.finished", "审核结果包已准备完成", { summary });
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "RUNNING",
        to: "REVIEW",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.finished", {
        runId,
        outcome: "succeeded",
      });
      return {
        value: { task: mapTask(taskRow, project.name), run: mapRun(runRow) },
        events: [taskEvent, runEvent],
        replayed: false,
      };
    })();
  }

  failRun(
    runId: string,
    executionToken: string,
    errorMessage: string,
    resultCommit?: string,
  ): EventfulResult<{ task: Task; run: TaskRun }> {
    return this.finishUnsuccessfulRun(runId, executionToken, "FAILED", errorMessage, resultCommit);
  }

  blockRun(
    runId: string,
    executionToken: string,
    reason: string,
    resultCommit?: string,
  ): EventfulResult<{ task: Task; run: TaskRun }> {
    return this.finishUnsuccessfulRun(runId, executionToken, "BLOCKED", reason, resultCommit);
  }

  cancelRunningTask(
    taskId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<{ task: Task; run: TaskRun }> {
    return this.executeIdempotent(deviceId, idempotencyKey, "task.cancel", expectedVersion, () => {
      const currentTask = this.requireTaskRow(taskId);
      if (currentTask.status !== "RUNNING" || !currentTask.latestRunId) {
        throw new Error("只有执行中的任务可以取消");
      }
      this.assertVersion(currentTask.version, expectedVersion);
      const currentRun = this.requireRunRow(currentTask.latestRunId);
      if (currentRun.taskId !== currentTask.id || currentRun.finishedAt !== null) {
        throw new Error("当前执行已经变化，请刷新后重试");
      }
      assertTaskTransition(currentTask.status, "CANCELLED");
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const runRow = this.handle.db
        .update(taskRuns)
        .set({
          status: "CANCELLED",
          summary: "执行已由用户取消，Worktree 和运行日志已保留。",
          executionToken: randomUUID(),
          processGroupId: null,
          finishedAt: timestamp,
        })
        .where(
          and(
            eq(taskRuns.id, currentRun.id),
            eq(taskRuns.executionToken, currentRun.executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!runRow) {
        throw new Error("当前执行已经变化，请刷新后重试");
      }
      const taskRow = this.handle.db
        .update(tasks)
        .set({
          status: "CANCELLED",
          version: currentTask.version + 1,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, expectedVersion),
            eq(tasks.status, "RUNNING"),
            isNull(tasks.deletedAt),
          ),
        )
        .returning()
        .get();
      if (!taskRow) {
        throw new Error("当前执行已经变化，请刷新后重试");
      }
      this.refreshWorkerActivity(timestamp);
      this.insertRunEvent(currentRun.id, "run.cancelled", "执行已由用户取消", {
        deviceId,
      });
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "RUNNING",
        to: "CANCELLED",
      });
      const runEvent = this.insertDomainEvent("run", currentRun.id, "run.finished", {
        runId: currentRun.id,
        outcome: "cancelled",
      });
      return {
        value: { task: mapTask(taskRow, project.name), run: mapRun(runRow) },
        events: [taskEvent, runEvent],
      };
    });
  }

  private finishUnsuccessfulRun(
    runId: string,
    executionToken: string,
    status: "FAILED" | "BLOCKED",
    summary: string,
    resultCommit: string | undefined,
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
      assertTaskTransition(currentTask.status, status);
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const runRow = this.handle.db
        .update(taskRuns)
        .set({
          status,
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
      if (!runRow) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const taskRow = this.handle.db
        .update(tasks)
        .set({ status, version: currentTask.version + 1, updatedAt: timestamp })
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
      if (!taskRow) {
        throw new Error("当前任务已经不再由此 Run 执行");
      }
      this.refreshWorkerActivity(timestamp);
      this.insertRunEvent(runId, `run.${status.toLowerCase()}`, summary, {});
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "RUNNING",
        to: status,
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.finished", {
        runId,
        outcome: status.toLowerCase(),
      });
      return {
        value: { task: mapTask(taskRow, project.name), run: mapRun(runRow) },
        events: [taskEvent, runEvent],
        replayed: false,
      };
    })();
  }
}
