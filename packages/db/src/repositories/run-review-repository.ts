import { randomUUID } from "node:crypto";
import {
  assertTaskTransition,
  type RunApplicationResult,
  type RunPublishResult,
  type Task,
} from "@devloop/shared";
import { and, eq, isNull, max } from "drizzle-orm";
import {
  projects,
  remoteCommands,
  reviewDecisions,
  taskRevisions,
  taskRuns,
  tasks,
} from "../schema.js";
import { hash, mapTask, now } from "./repository-codecs.js";
import { RunCompletionRepository } from "./run-completion-repository.js";
import type {
  AppliedRunApproval,
  EventfulResult,
  PublishedRunApproval,
  ResearchRunApproval,
  RunApplicationContext,
  RunApprovalContext,
  RunApprovalResult,
  RunPublishContext,
} from "./repository-types.js";

export class RunReviewRepository extends RunCompletionRepository {
  getRunApprovalContext(runId: string, expectedVersion: number): RunApprovalContext {
    const currentRun = this.requireRunRow(runId);
    const currentTask = this.requireTaskRow(currentRun.taskId);
    if (currentRun.status !== "SUCCEEDED" || currentTask.status !== "REVIEW") {
      throw new Error("只有审核中的成功执行可以通过");
    }
    if (currentTask.latestRunId !== runId) {
      throw new Error("只有任务最近一次成功执行可以通过");
    }
    this.assertVersion(currentTask.version, expectedVersion);
    if (currentTask.taskType === "RESEARCH") {
      if (!currentRun.summary) {
        throw new Error("研究执行缺少可审核的总结");
      }
      return { type: "research", context: { summary: currentRun.summary } };
    }
    if (!currentRun.baseCommit || !currentRun.resultCommit) {
      throw new Error("执行记录缺少完整的 Git 结果范围");
    }
    const project = this.requireProjectRow(currentTask.projectId);
    if (project.repositoryUrl) {
      return {
        type: "remote",
        context: {
          repositoryPath: project.path,
          targetBranch: currentRun.targetBranch,
          baseCommit: currentRun.baseCommit,
          resultCommit: currentRun.resultCommit,
        },
      };
    }
    return {
      type: "local",
      context: {
        projectPath: project.path,
        targetBranch: currentRun.targetBranch,
        baseCommit: currentRun.baseCommit,
        resultCommit: currentRun.resultCommit,
      },
    };
  }

  getRunPublishContext(runId: string, expectedVersion: number): RunPublishContext {
    const approval = this.getRunApprovalContext(runId, expectedVersion);
    if (approval.type !== "remote") {
      throw new Error("本地项目的执行结果不能推送到远程仓库");
    }
    return approval.context;
  }

  getRunApprovalReplay(deviceId: string, idempotencyKey: string): RunApprovalResult | null {
    const command = this.handle.db
      .select()
      .from(remoteCommands)
      .where(
        and(
          eq(remoteCommands.deviceId, deviceId),
          eq(remoteCommands.idempotencyKey, idempotencyKey),
          eq(remoteCommands.commandType, "run.approve"),
        ),
      )
      .get();
    return command ? (JSON.parse(command.resultJson) as RunApprovalResult) : null;
  }

  approveResearchRun(
    runId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<ResearchRunApproval> {
    return this.executeIdempotent(deviceId, idempotencyKey, "run.approve", expectedVersion, () => {
      const currentRun = this.requireRunRow(runId);
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (
        currentTask.taskType !== "RESEARCH" ||
        currentRun.status !== "SUCCEEDED" ||
        currentTask.status !== "REVIEW" ||
        currentTask.latestRunId !== runId ||
        !currentRun.summary
      ) {
        throw new Error("只有待审核的最新研究总结可以通过");
      }
      assertTaskTransition(currentTask.status, "COMPLETED");
      this.assertVersion(currentTask.version, expectedVersion);
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const taskRow = this.handle.db
        .update(tasks)
        .set({ status: "COMPLETED", version: currentTask.version + 1, updatedAt: timestamp })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, expectedVersion),
            eq(tasks.status, "REVIEW"),
            isNull(tasks.deletedAt),
          ),
        )
        .returning()
        .get();
      if (!taskRow) {
        throw new Error("Version conflict: 研究任务审核状态已发生变化");
      }
      this.handle.db
        .insert(reviewDecisions)
        .values({
          id: randomUUID(),
          runId,
          decision: "APPROVED",
          feedback: null,
          deviceId,
          createdAt: timestamp,
        })
        .run();
      this.insertRunEvent(runId, "run.research_approved", "研究总结已通过审核", {});
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "REVIEW",
        to: "COMPLETED",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.finished", {
        runId,
        outcome: "accepted",
        taskType: "RESEARCH",
      });
      return {
        value: {
          task: mapTask(taskRow, project.name),
          research: { status: "accepted", summary: currentRun.summary },
        },
        events: [taskEvent, runEvent],
      };
    });
  }

  approvePublishedRun(
    runId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
    publication: RunPublishResult,
  ): EventfulResult<PublishedRunApproval> {
    return this.executeIdempotent(deviceId, idempotencyKey, "run.approve", expectedVersion, () => {
      const currentRun = this.requireRunRow(runId);
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (currentRun.status !== "SUCCEEDED") {
        throw new Error("只有成功执行可以通过审核");
      }
      assertTaskTransition(currentTask.status, "COMPLETED");
      this.assertVersion(currentTask.version, expectedVersion);
      if (
        !currentRun.resultCommit ||
        publication.branch !== currentRun.targetBranch ||
        (publication.status === "pushed" && publication.currentCommit !== currentRun.resultCommit)
      ) {
        throw new Error("远程推送结果与当前 Run 的结果 Commit 不一致");
      }
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      this.handle.db
        .update(taskRuns)
        .set({ pushedAt: timestamp, pushedCommit: publication.currentCommit })
        .where(eq(taskRuns.id, runId))
        .run();
      const taskRow = this.handle.db
        .update(tasks)
        .set({ status: "COMPLETED", version: currentTask.version + 1, updatedAt: timestamp })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, expectedVersion),
            eq(tasks.status, "REVIEW"),
          ),
        )
        .returning()
        .get();
      if (!taskRow) {
        throw new Error("Version conflict: 任务审核状态已发生变化");
      }
      const projectRow = this.handle.db
        .update(projects)
        .set({
          integrationCommit: publication.currentCommit,
          lastFetchedAt: timestamp,
          version: project.version + 1,
          updatedAt: timestamp,
        })
        .where(and(eq(projects.id, project.id), eq(projects.version, project.version)))
        .returning()
        .get();
      if (!projectRow) {
        throw new Error("Version conflict: 项目同步状态已发生变化");
      }
      this.handle.db
        .insert(reviewDecisions)
        .values({
          id: randomUUID(),
          runId,
          decision: "APPROVED",
          feedback: null,
          deviceId,
          createdAt: timestamp,
        })
        .run();
      this.insertRunEvent(
        runId,
        "run.pushed",
        publication.status === "already_pushed"
          ? `远程分支 ${publication.branch} 已包含本次结果`
          : `本次结果已推送到远程分支 ${publication.branch}`,
        { ...publication },
      );
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "REVIEW",
        to: "COMPLETED",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.pushed", {
        runId,
        ...publication,
      });
      return {
        value: { task: mapTask(taskRow, project.name), publication },
        events: [taskEvent, runEvent],
      };
    });
  }

  approveAppliedRun(
    runId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
    application: RunApplicationResult,
  ): EventfulResult<AppliedRunApproval> {
    return this.executeIdempotent(deviceId, idempotencyKey, "run.approve", expectedVersion, () => {
      const currentRun = this.requireRunRow(runId);
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (currentRun.status !== "SUCCEEDED" || currentTask.latestRunId !== runId) {
        throw new Error("只有任务最近一次成功执行可以通过审核");
      }
      assertTaskTransition(currentTask.status, "COMPLETED");
      this.assertVersion(currentTask.version, expectedVersion);
      const project = this.requireProjectRow(currentTask.projectId);
      if (project.repositoryUrl) {
        throw new Error("远程项目必须推送结果后才能通过审核");
      }
      if (
        (currentRun.targetBranch !== "HEAD" && application.branch !== currentRun.targetBranch) ||
        !application.currentCommit
      ) {
        throw new Error("本地写回结果与当前 Run 不一致");
      }
      const timestamp = now();
      const taskRow = this.handle.db
        .update(tasks)
        .set({ status: "COMPLETED", version: currentTask.version + 1, updatedAt: timestamp })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, expectedVersion),
            eq(tasks.status, "REVIEW"),
          ),
        )
        .returning()
        .get();
      if (!taskRow) {
        throw new Error("Version conflict: 任务审核状态已发生变化");
      }
      const projectRow = this.handle.db
        .update(projects)
        .set({
          integrationCommit: application.currentCommit,
          version: project.version + 1,
          updatedAt: timestamp,
        })
        .where(and(eq(projects.id, project.id), eq(projects.version, project.version)))
        .returning()
        .get();
      if (!projectRow) {
        throw new Error("Version conflict: 项目同步状态已发生变化");
      }
      this.handle.db
        .insert(reviewDecisions)
        .values({
          id: randomUUID(),
          runId,
          decision: "APPROVED",
          feedback: null,
          deviceId,
          createdAt: timestamp,
        })
        .run();
      const message =
        application.status === "already_applied"
          ? `本地分支 ${application.branch} 已包含本次结果`
          : application.workingTreeUpdated
            ? `本次结果已写入本地分支 ${application.branch} 和当前工作目录`
            : `本次结果已写入本地分支 ${application.branch}`;
      this.insertRunEvent(runId, "run.applied", message, { ...application });
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "REVIEW",
        to: "COMPLETED",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.applied", {
        runId,
        ...application,
      });
      return {
        value: { task: mapTask(taskRow, project.name), application },
        events: [taskEvent, runEvent],
      };
    });
  }

  getRunApplicationContext(runId: string, expectedVersion: number): RunApplicationContext {
    const currentRun = this.requireRunRow(runId);
    const currentTask = this.requireTaskRow(currentRun.taskId);
    if (currentRun.status !== "SUCCEEDED") {
      throw new Error("Only successful runs can be applied");
    }
    if (currentTask.status !== "COMPLETED" || currentTask.latestRunId !== runId) {
      throw new Error("Only the approved latest run can be applied");
    }
    this.assertVersion(currentTask.version, expectedVersion);
    const approval = this.handle.db
      .select()
      .from(reviewDecisions)
      .where(and(eq(reviewDecisions.runId, runId), eq(reviewDecisions.decision, "APPROVED")))
      .get();
    if (!approval) {
      throw new Error("Only approved runs can be applied");
    }
    if (!currentRun.baseCommit || !currentRun.resultCommit) {
      throw new Error("Approved run has no complete Git result range");
    }
    const project = this.requireProjectRow(currentTask.projectId);
    return {
      projectPath: project.path,
      targetBranch: currentRun.targetBranch,
      baseCommit: currentRun.baseCommit,
      resultCommit: currentRun.resultCommit,
    };
  }

  recordRunApplication(
    runId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
    application: RunApplicationResult,
  ): EventfulResult<RunApplicationResult> {
    return this.executeIdempotent(
      deviceId,
      idempotencyKey,
      "run.apply_to_project",
      expectedVersion,
      () => {
        this.getRunApplicationContext(runId, expectedVersion);
        const message =
          application.status === "applied"
            ? application.branchCreated
              ? `目标分支 ${application.branch} 已创建并写入本次结果`
              : `本次结果已写入目标分支 ${application.branch}`
            : `目标分支 ${application.branch} 已包含本次结果`;
        this.insertRunEvent(runId, "run.applied", message, { ...application });
        const event = this.insertDomainEvent("run", runId, "run.applied", {
          runId,
          ...application,
        });
        return { value: application, events: [event] };
      },
    );
  }

  rejectRun(
    runId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
    feedback: string,
  ): EventfulResult<Task> {
    return this.executeIdempotent(deviceId, idempotencyKey, "run.reject", expectedVersion, () => {
      const currentRun = this.requireRunRow(runId);
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (
        currentRun.status !== "SUCCEEDED" ||
        currentTask.status !== "REVIEW" ||
        currentTask.latestRunId !== runId
      ) {
        throw new Error("只有任务最近一次成功执行可以驳回");
      }
      assertTaskTransition(currentTask.status, "READY");
      this.assertVersion(currentTask.version, expectedVersion);
      const currentRevision = this.handle.db
        .select()
        .from(taskRevisions)
        .where(eq(taskRevisions.id, currentRun.taskRevisionId))
        .get();
      if (!currentRevision) {
        throw new Error("执行记录关联的 Revision 不存在");
      }
      const researchTask = currentTask.taskType === "RESEARCH";
      if (!researchTask && (!currentRun.baseCommit || !currentRun.resultCommit)) {
        throw new Error("执行记录缺少连续迭代所需的基础或结果 Commit");
      }
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const revisionNumber =
        (this.handle.db
          .select({ value: max(taskRevisions.revision) })
          .from(taskRevisions)
          .where(eq(taskRevisions.taskId, currentTask.id))
          .get()?.value ?? 0) + 1;
      const revisionId = randomUUID();
      const previousSpec = JSON.parse(currentRevision.specJson) as Record<string, unknown>;
      const nextBaseRef = researchTask ? currentRevision.baseRef : currentRun.resultCommit!;
      const nextBaseStrategy = researchTask ? currentRevision.baseStrategy : "PINNED";
      const nextConfirmedBaseCommit = researchTask
        ? currentRevision.confirmedBaseCommit
        : currentRun.resultCommit!;
      const specJson = JSON.stringify({
        ...previousSpec,
        reviewFeedback: feedback,
        continuationBaseCommit: researchTask ? null : currentRun.baseCommit,
        continuationResultCommit: researchTask ? null : currentRun.resultCommit,
        baseStrategy: nextBaseStrategy,
        baseRef: nextBaseRef,
      });
      this.handle.db
        .insert(taskRevisions)
        .values({
          id: revisionId,
          taskId: currentTask.id,
          revision: revisionNumber,
          specJson,
          specHash: hash(specJson),
          targetBranch: currentRevision.targetBranch,
          baseRef: nextBaseRef,
          baseStrategy: nextBaseStrategy,
          confirmedBaseCommit: nextConfirmedBaseCommit,
          createdFrom: currentRevision.id,
          createdByDeviceId: deviceId,
          confirmedAt: timestamp,
        })
        .run();
      const taskRow = this.handle.db
        .update(tasks)
        .set({
          status: "READY",
          activeRevisionId: revisionId,
          version: currentTask.version + 1,
          updatedAt: timestamp,
        })
        .where(eq(tasks.id, currentTask.id))
        .returning()
        .get();
      this.handle.db
        .insert(reviewDecisions)
        .values({
          id: randomUUID(),
          runId,
          decision: "REJECTED",
          feedback,
          deviceId,
          createdAt: timestamp,
        })
        .run();
      this.insertRunEvent(runId, "run.rejected", `审核已驳回：${feedback}`, {
        feedback,
        nextRevisionId: revisionId,
      });
      const event = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "REVIEW",
        to: "READY",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.rejected", {
        runId,
        feedback,
        nextRevisionId: revisionId,
      });
      return { value: mapTask(taskRow, project.name), events: [event, runEvent] };
    });
  }
}
