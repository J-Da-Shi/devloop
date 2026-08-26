import { randomUUID } from "node:crypto";
import {
  agentPlanSchema,
  agentVerificationSchema,
  assertTaskTransition,
  type AgentPlan,
  type AgentVerification,
  type RunSkillSnapshot,
  type RunStatus,
  type TaskRun,
} from "@devloop/shared";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { projects, taskRevisions, taskRuns, tasks } from "../database/schema.js";
import {
  buildRunInputHash,
  mapRun,
  mapTask,
  now,
  parseRunSkillSnapshot,
  parseTaskRevisionSpec,
} from "./repository-codecs.js";
import { TaskRepository } from "./task-repository.js";
import type { ClaimedTask, EventfulResult } from "./repository-types.js";

export class RunClaimRepository extends TaskRepository {
  claimNextTask(
    options: {
      readyBefore?: string;
      resolveRunner?: (runnerId: string) => { id: string; version: string | null };
      resolveRunnerVersion?: (runnerId: string) => string | null;
    } = {},
  ): EventfulResult<ClaimedTask> | null {
    const readyBefore = options.readyBefore ?? now();
    return this.handle.sqlite.transaction(() => {
      const selected = this.handle.db
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(
          and(
            eq(tasks.status, "READY"),
            isNull(tasks.deletedAt),
            lte(tasks.updatedAt, readyBefore),
          ),
        )
        .orderBy(desc(tasks.priority), tasks.createdAt)
        .get();
      const current = selected?.task;
      if (!current || !current.activeRevisionId) {
        return null;
      }

      const revision = this.handle.db
        .select()
        .from(taskRevisions)
        .where(eq(taskRevisions.id, current.activeRevisionId))
        .get();
      if (!revision) {
        throw new Error("任务的当前 Revision 不存在");
      }
      const revisionSpec = parseTaskRevisionSpec(revision.specJson);
      const project = this.requireProjectRow(current.projectId);
      const requestedRunner = project.runner;
      const resolvedRunner = options.resolveRunner?.(requestedRunner);
      const runner = resolvedRunner?.id ?? requestedRunner;
      const runnerVersion =
        resolvedRunner?.version ?? options.resolveRunnerVersion?.(runner) ?? null;
      assertTaskTransition(current.status, "RUNNING");
      const baseCommit =
        revision.baseStrategy === "LATEST_ACCEPTED"
          ? project.integrationCommit
          : revision.confirmedBaseCommit;
      const runId = randomUUID();
      const executionToken = randomUUID();
      const timestamp = now();
      const runInputHash = buildRunInputHash({
        taskRevisionId: revision.id,
        targetBranch: revision.targetBranch,
        baseCommit,
        runner,
        specHash: revision.specHash,
        skillSnapshot: [],
      });
      const runRow = this.handle.db
        .insert(taskRuns)
        .values({
          id: runId,
          taskId: current.id,
          taskRevisionId: revision.id,
          targetBranch: revision.targetBranch,
          runner,
          status: "CLAIMED",
          baseCommit,
          resultCommit: null,
          worktreePath: null,
          branchName: null,
          executionToken,
          processGroupId: null,
          runnerVersion: runner === "fake" ? "built-in" : runnerVersion,
          pushedAt: null,
          pushedCommit: null,
          runInputHash,
          skillSnapshotJson: null,
          planJson: null,
          verificationJson: null,
          summary: null,
          budgetEstimatedCostCents: 0,
          budgetElapsedMs: 0,
          budgetHardLimitCents: current.budgetHardLimitCents,
          budgetWarningAtCents: Math.ceil(
            (current.budgetHardLimitCents * current.budgetWarningPercent) / 100,
          ),
          budgetSource: "ELAPSED_TIME_ESTIMATE",
          startedAt: timestamp,
          finishedAt: null,
        })
        .returning()
        .get();
      const taskRow = this.handle.db
        .update(tasks)
        .set({
          status: "RUNNING",
          latestRunId: runId,
          managedRetryCount:
            current.executionMode === "MANAGED"
              ? current.managedRetryCount + 1
              : current.managedRetryCount,
          version: current.version + 1,
          updatedAt: timestamp,
        })
        .where(eq(tasks.id, current.id))
        .returning()
        .get();
      this.refreshWorkerActivity(timestamp);
      this.insertRunEvent(runId, "run.claimed", "Worker claimed the task", {});
      const taskEvent = this.insertDomainEvent("task", current.id, "task.status_changed", {
        taskId: current.id,
        from: "READY",
        to: "RUNNING",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.started", {
        runId,
        taskId: current.id,
      });
      return {
        value: {
          task: mapTask(taskRow, project.name),
          run: mapRun(runRow),
          taskType: revisionSpec.taskType,
          projectPath: project.path,
          projectDefaultBaseRef: project.defaultBaseRef,
          projectRepositoryUrl: project.repositoryUrl,
          projectRunner: runner,
          previewCommand: project.previewCommand,
          previewWorkingDirectory: project.previewWorkingDirectory,
          previewHealthPath: project.previewHealthPath,
          playwrightEnabled: project.playwrightEnabled,
          playwrightTestCommand: project.playwrightTestCommand,
          autoResolveConflicts: revisionSpec.autoResolveConflicts,
          executionMode: revisionSpec.executionMode,
          title: revisionSpec.title,
          goal: revisionSpec.goal,
          acceptanceCriteria: revisionSpec.acceptanceCriteria,
          reviewFeedback: revisionSpec.reviewFeedback,
          retryContext: revisionSpec.retryContext,
          continuationBaseCommit: revisionSpec.continuationBaseCommit,
          continuationResultCommit: revisionSpec.continuationResultCommit,
        },
        events: [taskEvent, runEvent],
        replayed: false,
      };
    })();
  }

  setRunSkillSnapshot(
    runId: string,
    executionToken: string,
    skillSnapshot: RunSkillSnapshot[],
  ): EventfulResult<TaskRun> {
    return this.handle.sqlite.transaction(() => {
      const current = this.requireRunRow(runId);
      if (current.executionToken !== executionToken || current.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失去 Skill 快照所有权");
      }
      if (current.skillSnapshotJson !== null) {
        throw new Error("当前 Run 的 Skill 快照已经固定");
      }
      const normalizedSnapshot = parseRunSkillSnapshot(JSON.stringify(skillSnapshot));
      if (normalizedSnapshot === null) {
        throw new Error("Run Skill 快照不能为空");
      }
      const revision = this.handle.db
        .select()
        .from(taskRevisions)
        .where(eq(taskRevisions.id, current.taskRevisionId))
        .get();
      if (!revision) {
        throw new Error("执行记录关联的 Revision 不存在");
      }
      const runInputHash = buildRunInputHash({
        taskRevisionId: revision.id,
        targetBranch: current.targetBranch,
        baseCommit: current.baseCommit,
        runner: current.runner,
        specHash: revision.specHash,
        skillSnapshot: normalizedSnapshot,
      });
      const row = this.handle.db
        .update(taskRuns)
        .set({
          skillSnapshotJson: JSON.stringify(normalizedSnapshot),
          runInputHash,
        })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.skillSnapshotJson),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!row) {
        throw new Error("当前 Run 的执行令牌已经失去 Skill 快照所有权");
      }
      this.insertRunEvent(
        runId,
        "run.skill_snapshot_recorded",
        `已固定 ${normalizedSnapshot.length} 个 Skill 执行快照`,
        { skills: normalizedSnapshot },
      );
      const event = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        status: row.status,
        message: "Skill 执行快照已固定",
      });
      return { value: mapRun(row), events: [event], replayed: false };
    })();
  }

  setRunWorkspace(
    runId: string,
    executionToken: string,
    input: { worktreePath: string; branchName: string },
  ): EventfulResult<TaskRun> {
    return this.handle.sqlite.transaction(() => {
      const row = this.handle.db
        .update(taskRuns)
        .set({ worktreePath: input.worktreePath, branchName: input.branchName })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!row) {
        throw new Error("当前 Run 的执行令牌已经失去 Worktree 所有权");
      }
      this.insertRunEvent(runId, "run.workspace_ready", "独立 Git Worktree 已准备完成", {
        worktreePath: input.worktreePath,
        branchName: input.branchName,
      });
      const event = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        status: row.status,
        message: "独立 Git Worktree 已准备完成",
      });
      return { value: mapRun(row), events: [event], replayed: false };
    })();
  }

  setRunProcessGroupId(runId: string, executionToken: string, processGroupId: number | null): void {
    if (processGroupId !== null && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)) {
      throw new Error("进程组 ID 无效");
    }
    const row = this.handle.db
      .update(taskRuns)
      .set({ processGroupId })
      .where(
        and(
          eq(taskRuns.id, runId),
          eq(taskRuns.executionToken, executionToken),
          isNull(taskRuns.finishedAt),
        ),
      )
      .returning({ id: taskRuns.id })
      .get();
    if (!row) {
      throw new Error("当前 Run 的执行令牌已经失效");
    }
  }

  setRunBaseCommit(
    runId: string,
    executionToken: string,
    input: { targetBranch: string; baseCommit: string },
  ): EventfulResult<TaskRun> {
    return this.handle.sqlite.transaction(() => {
      const current = this.requireRunRow(runId);
      if (current.executionToken !== executionToken || current.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失去基础 Commit 所有权");
      }
      const revision = this.handle.db
        .select()
        .from(taskRevisions)
        .where(eq(taskRevisions.id, current.taskRevisionId))
        .get();
      if (!revision) {
        throw new Error("执行记录关联的 Revision 不存在");
      }
      const runInputHash = buildRunInputHash({
        taskRevisionId: revision.id,
        targetBranch: input.targetBranch,
        baseCommit: input.baseCommit,
        runner: current.runner,
        specHash: revision.specHash,
        skillSnapshot: parseRunSkillSnapshot(current.skillSnapshotJson) ?? [],
      });
      const row = this.handle.db
        .update(taskRuns)
        .set({ targetBranch: input.targetBranch, baseCommit: input.baseCommit, runInputHash })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!row) {
        throw new Error("当前 Run 的执行令牌已经失去基础 Commit 所有权");
      }
      this.insertRunEvent(
        runId,
        "run.base_resolved",
        `执行基线已解析：${input.baseCommit.slice(0, 12)}`,
        { baseCommit: input.baseCommit, targetBranch: input.targetBranch },
      );
      const event = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        status: row.status,
        message: "目标分支执行基线已解析",
      });
      return { value: mapRun(row), events: [event], replayed: false };
    })();
  }

  setRunPhase(
    runId: string,
    executionToken: string,
    status: RunStatus,
    eventType: string,
    message: string,
    data?: Record<string, unknown>,
  ): EventfulResult<TaskRun> {
    return this.handle.sqlite.transaction(() => {
      const current = this.requireRunRow(runId);
      if (current.executionToken !== executionToken || current.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const row = this.handle.db
        .update(taskRuns)
        .set({ status })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!row) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      this.insertRunEvent(runId, eventType, message, data ? { status, ...data } : { status });
      const event = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        status,
        message,
      });
      return { value: mapRun(row), events: [event], replayed: false };
    })();
  }

  setRunPlan(runId: string, executionToken: string, plan: AgentPlan): EventfulResult<TaskRun> {
    return this.handle.sqlite.transaction(() => {
      const normalizedPlan = agentPlanSchema.parse(plan);
      const current = this.requireRunRow(runId);
      if (current.executionToken !== executionToken || current.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      if (current.planJson !== null) {
        throw new Error("当前 Run 的 Agent 计划已经固定");
      }
      const row = this.handle.db
        .update(taskRuns)
        .set({ planJson: JSON.stringify(normalizedPlan) })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.planJson),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!row) throw new Error("当前 Run 的执行令牌已经失效");
      this.insertRunEvent(runId, "run.agent.planning.completed", "规划 Agent 已生成执行计划", {
        role: "planner",
        plan: normalizedPlan,
      });
      const event = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        status: row.status,
        role: "planner",
        message: "规划 Agent 已完成",
      });
      return { value: mapRun(row), events: [event], replayed: false };
    })();
  }

  setRunVerification(
    runId: string,
    executionToken: string,
    verification: AgentVerification,
  ): EventfulResult<TaskRun> {
    return this.handle.sqlite.transaction(() => {
      const normalizedVerification = agentVerificationSchema.parse(verification);
      const current = this.requireRunRow(runId);
      if (current.executionToken !== executionToken || current.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const row = this.handle.db
        .update(taskRuns)
        .set({ verificationJson: JSON.stringify(normalizedVerification) })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!row) throw new Error("当前 Run 的执行令牌已经失效");
      this.insertRunEvent(
        runId,
        "run.agent.verification.completed",
        current.verificationJson === null
          ? "验收 Agent 已生成验收报告"
          : "验收 Agent 已更新验收报告",
        {
          role: "verifier",
          verification: normalizedVerification,
          updated: current.verificationJson !== null,
        },
      );
      const event = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        status: row.status,
        role: "verifier",
        message: "验收 Agent 已完成",
      });
      return { value: mapRun(row), events: [event], replayed: false };
    })();
  }
}
