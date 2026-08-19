import { randomUUID } from "node:crypto";
import {
  assertTaskTransition,
  type CreateTaskInput,
  type Task,
  type TaskType,
} from "@devloop/shared";
import { and, desc, eq, isNull, max } from "drizzle-orm";
import { projects, reviewDecisions, taskRevisions, taskRuns, tasks } from "../schema.js";
import {
  hash,
  mapTask,
  now,
  parseStringArray,
  parseTaskRevisionSpec,
} from "./repository-codecs.js";
import { SkillRepository } from "./skill-repository.js";
import type { ConfirmTaskInput, EventfulResult, UpdateDraftTaskInput } from "./repository-types.js";

export class TaskRepository extends SkillRepository {
  listTasks(): Task[] {
    return this.handle.db
      .select({ task: tasks, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(isNull(tasks.deletedAt))
      .orderBy(desc(tasks.updatedAt))
      .all()
      .map(({ task, projectName }) => mapTask(task, projectName));
  }

  getTask(taskId: string): Task | null {
    const row = this.handle.db
      .select({ task: tasks, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
      .get();
    return row ? mapTask(row.task, row.projectName) : null;
  }

  getTaskIncludingDeleted(taskId: string): Task | null {
    const row = this.handle.db
      .select({ task: tasks, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(eq(tasks.id, taskId))
      .get();
    return row ? mapTask(row.task, row.projectName) : null;
  }

  createTask(
    input: Omit<CreateTaskInput, "autoResolveConflicts" | "taskType"> & {
      autoResolveConflicts?: boolean;
      taskType?: TaskType;
    },
  ): EventfulResult<Task> {
    const id = randomUUID();
    const timestamp = now();

    return this.handle.sqlite.transaction(() => {
      const project = this.handle.db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .get();
      if (!project) {
        throw new Error("项目不存在");
      }

      const row = this.handle.db
        .insert(tasks)
        .values({
          id,
          projectId: input.projectId,
          taskType: input.taskType ?? "DEVELOPMENT",
          targetBranch: input.targetBranch,
          autoResolveConflicts: input.autoResolveConflicts ?? true,
          title: input.title,
          goal: input.goal,
          acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria),
          status: "DRAFT",
          priority: input.priority,
          activeRevisionId: null,
          latestRunId: null,
          deletedAt: null,
          deletedByDeviceId: null,
          version: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get();
      const event = this.insertDomainEvent("task", id, "task.created", { taskId: id });
      return { value: mapTask(row, project.name), events: [event], replayed: false };
    })();
  }

  updateDraftTask(
    taskId: string,
    deviceId: string,
    input: UpdateDraftTaskInput,
  ): EventfulResult<Task> {
    return this.executeIdempotent(
      deviceId,
      input.idempotencyKey,
      "task.update",
      input.expectedVersion,
      () => {
        const current = this.requireTaskRow(taskId);
        if (current.status !== "DRAFT") {
          throw new Error("只有草稿任务可以编辑");
        }
        this.assertVersion(current.version, input.expectedVersion);
        const timestamp = now();
        const project = this.requireProjectRow(current.projectId);
        const row = this.handle.db
          .update(tasks)
          .set({
            taskType: input.taskType ?? current.taskType,
            targetBranch: input.targetBranch ?? current.targetBranch,
            autoResolveConflicts: input.autoResolveConflicts ?? current.autoResolveConflicts,
            title: input.title ?? current.title,
            goal: input.goal ?? current.goal,
            acceptanceCriteriaJson:
              input.acceptanceCriteria === undefined
                ? current.acceptanceCriteriaJson
                : JSON.stringify(input.acceptanceCriteria),
            priority: input.priority ?? current.priority,
            version: current.version + 1,
            updatedAt: timestamp,
          })
          .where(and(eq(tasks.id, taskId), eq(tasks.version, input.expectedVersion)))
          .returning()
          .get();
        const event = this.insertDomainEvent("task", taskId, "task.updated", {
          taskId,
          version: row.version,
        });
        return { value: mapTask(row, project.name), events: [event] };
      },
    );
  }

  confirmTask(taskId: string, deviceId: string, input: ConfirmTaskInput): EventfulResult<Task> {
    return this.executeIdempotent(
      deviceId,
      input.idempotencyKey,
      "task.confirm",
      input.expectedVersion,
      () => {
        const current = this.requireTaskRow(taskId);
        assertTaskTransition(current.status, "READY");
        this.assertVersion(current.version, input.expectedVersion);
        const project = this.requireProjectRow(current.projectId);
        const revisionNumber =
          (this.handle.db
            .select({ value: max(taskRevisions.revision) })
            .from(taskRevisions)
            .where(eq(taskRevisions.taskId, taskId))
            .get()?.value ?? 0) + 1;
        const timestamp = now();
        const revisionId = randomUUID();
        const previousRevision = current.activeRevisionId
          ? this.handle.db
              .select()
              .from(taskRevisions)
              .where(eq(taskRevisions.id, current.activeRevisionId))
              .get()
          : null;
        const previousSpec = previousRevision
          ? parseTaskRevisionSpec(previousRevision.specJson)
          : null;
        const latestRun = current.latestRunId
          ? this.handle.db.select().from(taskRuns).where(eq(taskRuns.id, current.latestRunId)).get()
          : null;
        const latestReviewDecision = latestRun
          ? this.handle.db
              .select()
              .from(reviewDecisions)
              .where(eq(reviewDecisions.runId, latestRun.id))
              .orderBy(desc(reviewDecisions.createdAt))
              .get()
          : null;
        const continuesAcceptedRevision = Boolean(
          latestRun &&
          latestRun.status === "SUCCEEDED" &&
          latestRun.taskRevisionId === current.activeRevisionId &&
          latestReviewDecision?.decision === "APPROVED",
        );
        const continuesDevelopmentRevision =
          current.taskType === "DEVELOPMENT" && previousSpec?.taskType === "DEVELOPMENT";
        const retryableLatestRun =
          latestRun &&
          latestRun.taskRevisionId === current.activeRevisionId &&
          (latestRun.status === "FAILED" || latestRun.status === "BLOCKED")
            ? latestRun
            : null;
        const retryContext = retryableLatestRun ? this.buildRetryContext(retryableLatestRun) : null;
        const resumesFailedDevelopmentCheckpoint = Boolean(
          retryableLatestRun &&
          continuesDevelopmentRevision &&
          retryableLatestRun.baseCommit &&
          retryableLatestRun.resultCommit,
        );
        const continuationBaseCommit =
          continuesAcceptedRevision || !continuesDevelopmentRevision
            ? null
            : resumesFailedDevelopmentCheckpoint
              ? retryableLatestRun!.baseCommit
              : (previousSpec?.continuationBaseCommit ?? null);
        const continuationResultCommit =
          continuesAcceptedRevision || !continuesDevelopmentRevision
            ? null
            : resumesFailedDevelopmentCheckpoint
              ? retryableLatestRun!.resultCommit
              : (previousSpec?.continuationResultCommit ?? null);
        const baseStrategy = continuationResultCommit ? "PINNED" : input.baseStrategy;
        const baseRef = continuationResultCommit ?? current.targetBranch;
        const spec = {
          taskType: current.taskType,
          title: current.title,
          goal: current.goal,
          acceptanceCriteria: parseStringArray(current.acceptanceCriteriaJson),
          reviewFeedback: continuesAcceptedRevision ? null : (previousSpec?.reviewFeedback ?? null),
          autoResolveConflicts: current.autoResolveConflicts,
          retryContext,
          continuationBaseCommit,
          continuationResultCommit,
          baseStrategy,
          baseRef,
          targetBranch: current.targetBranch,
        };
        const specJson = JSON.stringify(spec);
        this.handle.db
          .insert(taskRevisions)
          .values({
            id: revisionId,
            taskId,
            revision: revisionNumber,
            specJson,
            specHash: hash(specJson),
            targetBranch: current.targetBranch,
            baseRef,
            baseStrategy,
            confirmedBaseCommit: continuationResultCommit ?? project.integrationCommit,
            createdFrom: current.activeRevisionId ?? "draft",
            createdByDeviceId: deviceId,
            confirmedAt: timestamp,
          })
          .run();
        const row = this.handle.db
          .update(tasks)
          .set({
            status: "READY",
            activeRevisionId: revisionId,
            version: current.version + 1,
            updatedAt: timestamp,
          })
          .where(and(eq(tasks.id, taskId), eq(tasks.version, input.expectedVersion)))
          .returning()
          .get();
        const event = this.insertDomainEvent("task", taskId, "task.status_changed", {
          taskId,
          from: current.status,
          to: "READY",
        });
        return { value: mapTask(row, project.name), events: [event] };
      },
    );
  }

  autoQueueTask(taskId: string, deviceId: string): EventfulResult<Task> | null {
    const current = this.requireTaskRow(taskId);
    if (current.status !== "DRAFT" || current.priority !== 100) {
      return null;
    }
    return this.confirmTask(taskId, deviceId, {
      expectedVersion: current.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: current.targetBranch,
    });
  }

  unconfirmTask(
    taskId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<Task> {
    return this.executeIdempotent(
      deviceId,
      idempotencyKey,
      "task.unconfirm",
      expectedVersion,
      () => {
        const current = this.requireTaskRow(taskId);
        assertTaskTransition(current.status, "DRAFT");
        this.assertVersion(current.version, expectedVersion);
        const project = this.requireProjectRow(current.projectId);
        const row = this.handle.db
          .update(tasks)
          .set({ status: "DRAFT", version: current.version + 1, updatedAt: now() })
          .where(and(eq(tasks.id, taskId), eq(tasks.version, expectedVersion)))
          .returning()
          .get();
        const event = this.insertDomainEvent("task", taskId, "task.status_changed", {
          taskId,
          from: current.status,
          to: "DRAFT",
        });
        return { value: mapTask(row, project.name), events: [event] };
      },
    );
  }

  continueCompletedTask(
    taskId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<Task> {
    return this.executeIdempotent(
      deviceId,
      idempotencyKey,
      "task.continue",
      expectedVersion,
      () => {
        const current = this.requireTaskRow(taskId);
        if (current.status !== "COMPLETED") {
          throw new Error("只有已完成任务可以继续迭代");
        }
        assertTaskTransition(current.status, "DRAFT");
        this.assertVersion(current.version, expectedVersion);
        if (!current.latestRunId || !current.activeRevisionId) {
          throw new Error("已完成任务缺少最近执行或 Revision");
        }
        const latestRun = this.requireRunRow(current.latestRunId);
        const reviewDecision = this.handle.db
          .select()
          .from(reviewDecisions)
          .where(eq(reviewDecisions.runId, latestRun.id))
          .orderBy(desc(reviewDecisions.createdAt))
          .get();
        if (
          latestRun.status !== "SUCCEEDED" ||
          latestRun.taskRevisionId !== current.activeRevisionId ||
          reviewDecision?.decision !== "APPROVED"
        ) {
          throw new Error("已完成任务缺少可继续迭代的审核结果");
        }
        const project = this.requireProjectRow(current.projectId);
        const timestamp = now();
        const row = this.handle.db
          .update(tasks)
          .set({ status: "DRAFT", version: current.version + 1, updatedAt: timestamp })
          .where(
            and(
              eq(tasks.id, taskId),
              eq(tasks.version, expectedVersion),
              eq(tasks.status, "COMPLETED"),
              isNull(tasks.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!row) {
          throw new Error("Version conflict: 已完成任务状态已发生变化");
        }
        const event = this.insertDomainEvent("task", taskId, "task.status_changed", {
          taskId,
          from: "COMPLETED",
          to: "DRAFT",
          continuedFromRunId: latestRun.id,
          continuedFromRevisionId: latestRun.taskRevisionId,
        });
        return { value: mapTask(row, project.name), events: [event] };
      },
    );
  }

  deleteTask(
    taskId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<Task> {
    return this.executeIdempotent(deviceId, idempotencyKey, "task.delete", expectedVersion, () => {
      const current = this.requireTaskRow(taskId);
      if (current.status === "RUNNING") {
        throw new Error("执行中的任务不能删除，请先取消执行");
      }
      this.assertVersion(current.version, expectedVersion);
      const project = this.requireProjectRow(current.projectId);
      const timestamp = now();
      const row = this.handle.db
        .update(tasks)
        .set({
          deletedAt: timestamp,
          deletedByDeviceId: deviceId,
          version: current.version + 1,
          updatedAt: timestamp,
        })
        .where(
          and(eq(tasks.id, taskId), eq(tasks.version, expectedVersion), isNull(tasks.deletedAt)),
        )
        .returning()
        .get();
      if (!row) {
        throw new Error("Version conflict: 任务已被其他设备修改");
      }
      const event = this.insertDomainEvent("task", taskId, "task.deleted", {
        taskId,
        deletedAt: timestamp,
        deletedByDeviceId: deviceId,
      });
      return { value: mapTask(row, project.name), events: [event] };
    });
  }
}
