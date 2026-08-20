import { randomUUID } from "node:crypto";
import type { DomainEvent, RetryContext, RunEvent } from "@devloop/shared";
import { and, desc, eq, isNull, max } from "drizzle-orm";
import type { DatabaseHandle } from "../client.js";
import {
  domainEvents,
  projects,
  remoteCommands,
  runEvents,
  skillVersions,
  skills,
  taskRuns,
  tasks,
  workerState,
  type ProjectRow,
  type SkillRow,
  type SkillVersionRow,
  type TaskRow,
  type TaskRunRow,
} from "../schema.js";
import {
  mapDomainEvent,
  mapRunEvent,
  now,
  retryContextLimits,
} from "./repository-codecs.js";
import type { EventfulResult } from "./repository-types.js";

export class RepositoryBase {
  public constructor(protected readonly handle: DatabaseHandle) {}

  protected executeIdempotent<T>(
    deviceId: string,
    idempotencyKey: string,
    commandType: string,
    expectedVersion: number,
    action: () => { value: T; events: DomainEvent[] },
  ): EventfulResult<T> {
    return this.handle.sqlite.transaction(() => {
      const existing = this.handle.db
        .select()
        .from(remoteCommands)
        .where(
          and(
            eq(remoteCommands.deviceId, deviceId),
            eq(remoteCommands.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
      if (existing) {
        return {
          value: JSON.parse(existing.resultJson) as T,
          events: [],
          replayed: true,
        };
      }
      const result = action();
      this.handle.db
        .insert(remoteCommands)
        .values({
          id: randomUUID(),
          deviceId,
          idempotencyKey,
          commandType,
          expectedVersion,
          status: "SUCCEEDED",
          resultJson: JSON.stringify(result.value),
          createdAt: now(),
        })
        .run();
      return { ...result, replayed: false };
    })();
  }

  protected requireTaskRow(taskId: string): TaskRow {
    const row = this.handle.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
      .get();
    if (!row) {
      throw new Error("任务不存在");
    }
    return row;
  }

  protected requireProjectRow(projectId: string): ProjectRow {
    const row = this.handle.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) {
      throw new Error("项目不存在");
    }
    return row;
  }

  protected requireRunRow(runId: string): TaskRunRow {
    const row = this.handle.db.select().from(taskRuns).where(eq(taskRuns.id, runId)).get();
    if (!row) {
      throw new Error("执行记录不存在");
    }
    return row;
  }

  protected requireSkillRow(skillId: string): SkillRow {
    const row = this.handle.db.select().from(skills).where(eq(skills.id, skillId)).get();
    if (!row) {
      throw new Error("Skill not found");
    }
    return row;
  }

  protected requireSkillVersionRow(versionId: string): SkillVersionRow {
    const row = this.handle.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.id, versionId))
      .get();
    if (!row) {
      throw new Error("Skill version not found");
    }
    return row;
  }

  protected assertVersion(current: number, expected: number): void {
    if (current !== expected) {
      throw new Error(`Version conflict: expected ${expected}, current ${current}`);
    }
  }

  protected insertDomainEvent(
    aggregateType: DomainEvent["aggregateType"],
    aggregateId: string,
    type: string,
    payload: Record<string, unknown>,
  ): DomainEvent {
    const row = this.handle.db
      .insert(domainEvents)
      .values({
        aggregateType,
        aggregateId,
        type,
        payloadJson: JSON.stringify(payload),
        createdAt: now(),
      })
      .returning()
      .get();
    return mapDomainEvent(row);
  }

  protected insertRunEvent(
    runId: string,
    type: string,
    message: string,
    payload: Record<string, unknown>,
  ): RunEvent {
    const sequence =
      (this.handle.db
        .select({ value: max(runEvents.sequence) })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get()?.value ?? 0) + 1;
    const row = this.handle.db
      .insert(runEvents)
      .values({
        id: randomUUID(),
        runId,
        sequence,
        type,
        message,
        payloadJson: JSON.stringify(payload),
        createdAt: now(),
      })
      .returning()
      .get();
    return mapRunEvent(row);
  }

  protected buildRetryContext(run: TaskRunRow): RetryContext {
    if (run.status !== "FAILED" && run.status !== "BLOCKED") {
      throw new Error("只有失败或阻塞的执行记录可以生成重试上下文");
    }
    // 事件条数上限仍保留（避免历史累积无限增长），但单条 message 与 summary 都不再机械截断，
    // 交由 @devloop/context 的 pipeline 按预算和类型统一压缩（PR4）。
    const events = this.handle.db
      .select({
        type: runEvents.type,
        message: runEvents.message,
        createdAt: runEvents.createdAt,
      })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(desc(runEvents.sequence))
      .limit(retryContextLimits.eventCount)
      .all()
      .reverse()
      .map((event) => ({
        type: event.type,
        message: event.message,
        createdAt: event.createdAt,
      }));
    return {
      sourceRunId: run.id,
      sourceStatus: run.status,
      sourceRunner: run.runner,
      sourceFinishedAt: run.finishedAt ?? run.startedAt,
      summary: run.summary ?? "上一轮未记录失败摘要，请根据下方执行日志继续排查。",
      baseCommit: run.baseCommit,
      resultCommit: run.resultCommit,
      events,
    };
  }

  protected refreshWorkerActivity(timestamp: string): void {
    const activeRun = this.handle.db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(isNull(taskRuns.finishedAt))
      .orderBy(taskRuns.startedAt)
      .get();
    const current = this.handle.db
      .select({ version: workerState.version })
      .from(workerState)
      .where(eq(workerState.id, "primary"))
      .get();
    if (!current) {
      throw new Error("Worker state not initialized");
    }
    this.handle.db
      .update(workerState)
      .set({
        activeRunId: activeRun?.id ?? null,
        heartbeatAt: timestamp,
        version: current.version + 1,
      })
      .where(eq(workerState.id, "primary"))
      .run();
  }
}

export type RepositoryConstructor<T extends RepositoryBase = RepositoryBase> = new (
  handle: DatabaseHandle,
) => T;
