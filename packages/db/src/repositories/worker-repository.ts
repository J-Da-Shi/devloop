import {
  type DomainEvent,
  type WorkerState,
  workerConcurrencyMax,
  workerConcurrencyMin,
} from "@devloop/shared";
import { eq, gt, isNull } from "drizzle-orm";
import { domainEvents, taskRuns, workerState } from "../schema.js";
import { mapDomainEvent, now } from "./repository-codecs.js";
import { RunRecordsRepository } from "./run-records-repository.js";
import type { EventfulResult } from "./repository-types.js";

export class WorkerRepository extends RunRecordsRepository {
  getWorkerState(): WorkerState {
    const row = this.handle.db
      .select()
      .from(workerState)
      .where(eq(workerState.id, "primary"))
      .get();
    if (!row) {
      throw new Error("Worker state not initialized");
    }
    const activeRunIds = this.handle.db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(isNull(taskRuns.finishedAt))
      .orderBy(taskRuns.startedAt)
      .all()
      .map((run) => run.id);
    return {
      status: row.status,
      heartbeatAt: row.heartbeatAt,
      activeRunId: activeRunIds[0] ?? null,
      activeRunIds,
      concurrencyLimit: row.concurrencyLimit,
      version: row.version,
    };
  }

  setWorkerStatus(status: WorkerState["status"]): EventfulResult<WorkerState> {
    return this.handle.sqlite.transaction(() => {
      const current = this.getWorkerState();
      const timestamp = now();
      const row = this.handle.db
        .update(workerState)
        .set({ status, heartbeatAt: timestamp, version: current.version + 1 })
        .where(eq(workerState.id, "primary"))
        .returning()
        .get();
      if (!row) {
        throw new Error("Worker state not initialized");
      }
      const event = this.insertDomainEvent("worker", "primary", "worker.status_changed", {
        status,
      });
      return { value: this.getWorkerState(), events: [event], replayed: false };
    })();
  }

  setWorkerConcurrency(concurrencyLimit: number): EventfulResult<WorkerState> {
    if (
      !Number.isSafeInteger(concurrencyLimit) ||
      concurrencyLimit < workerConcurrencyMin ||
      concurrencyLimit > workerConcurrencyMax
    ) {
      throw new Error(
        `Worker 并发数必须是 ${workerConcurrencyMin}-${workerConcurrencyMax} 之间的整数`,
      );
    }
    return this.handle.sqlite.transaction(() => {
      const current = this.getWorkerState();
      const timestamp = now();
      const row = this.handle.db
        .update(workerState)
        .set({
          concurrencyLimit,
          heartbeatAt: timestamp,
          version: current.version + 1,
        })
        .where(eq(workerState.id, "primary"))
        .returning()
        .get();
      if (!row) {
        throw new Error("Worker state not initialized");
      }
      const event = this.insertDomainEvent("worker", "primary", "worker.concurrency_changed", {
        concurrencyLimit,
      });
      return { value: this.getWorkerState(), events: [event], replayed: false };
    })();
  }

  heartbeat(): void {
    this.handle.db
      .update(workerState)
      .set({ heartbeatAt: now() })
      .where(eq(workerState.id, "primary"))
      .run();
  }

  listDomainEvents(afterId = 0, limit = 200): DomainEvent[] {
    return this.handle.db
      .select()
      .from(domainEvents)
      .where(gt(domainEvents.id, afterId))
      .orderBy(domainEvents.id)
      .limit(limit)
      .all()
      .map(mapDomainEvent);
  }
}
