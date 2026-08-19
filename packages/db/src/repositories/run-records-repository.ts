import { randomUUID } from "node:crypto";
import type { ReviewDecision, RunArtifact, RunEvent, TaskRevision, TaskRun } from "@devloop/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { artifacts, reviewDecisions, runEvents, taskRevisions, taskRuns } from "../schema.js";
import {
  mapArtifact,
  mapReviewDecision,
  mapRun,
  mapRunEvent,
  mapTaskRevision,
  now,
} from "./repository-codecs.js";
import { RunReviewRepository } from "./run-review-repository.js";
import type { EventfulResult, StoredRunArtifact } from "./repository-types.js";

export class RunRecordsRepository extends RunReviewRepository {
  getRun(runId: string): TaskRun | null {
    const row = this.handle.db.select().from(taskRuns).where(eq(taskRuns.id, runId)).get();
    return row ? mapRun(row) : null;
  }

  getTaskRevision(revisionId: string): TaskRevision | null {
    const row = this.handle.db
      .select()
      .from(taskRevisions)
      .where(eq(taskRevisions.id, revisionId))
      .get();
    return row ? mapTaskRevision(row) : null;
  }

  getRunReviewDecision(runId: string): ReviewDecision | null {
    const row = this.handle.db
      .select()
      .from(reviewDecisions)
      .where(eq(reviewDecisions.runId, runId))
      .orderBy(desc(reviewDecisions.createdAt))
      .get();
    return row ? mapReviewDecision(row) : null;
  }

  getRunProcessGroupId(runId: string): number | null {
    const row = this.handle.db
      .select({ processGroupId: taskRuns.processGroupId })
      .from(taskRuns)
      .where(eq(taskRuns.id, runId))
      .get();
    return row?.processGroupId ?? null;
  }

  listRuns(limit = 50): TaskRun[] {
    return this.handle.db
      .select()
      .from(taskRuns)
      .orderBy(desc(taskRuns.startedAt))
      .limit(limit)
      .all()
      .map(mapRun);
  }

  listActiveRuns(): TaskRun[] {
    return this.handle.db
      .select()
      .from(taskRuns)
      .where(isNull(taskRuns.finishedAt))
      .orderBy(taskRuns.startedAt)
      .all()
      .map(mapRun);
  }

  getRunEvents(runId: string): RunEvent[] {
    return this.handle.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(runEvents.sequence)
      .all()
      .map(mapRunEvent);
  }

  createRunArtifact(input: {
    runId: string;
    kind: string;
    storagePath: string;
    size: number;
    checksum: string;
  }): RunArtifact {
    this.requireRunRow(input.runId);
    const row = this.handle.db
      .insert(artifacts)
      .values({
        id: randomUUID(),
        runId: input.runId,
        kind: input.kind,
        path: input.storagePath,
        size: input.size,
        checksum: input.checksum,
        createdAt: now(),
      })
      .returning()
      .get();
    return mapArtifact(row);
  }

  listRunArtifacts(runId: string): RunArtifact[] {
    return this.handle.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(artifacts.createdAt)
      .all()
      .map(mapArtifact);
  }

  getRunArtifact(runId: string, artifactId: string): StoredRunArtifact | null {
    const row = this.handle.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.runId, runId)))
      .get();
    return row ? { artifact: mapArtifact(row), storagePath: row.path } : null;
  }

  recordRunEvent(
    runId: string,
    type: string,
    message: string,
    payload: Record<string, unknown>,
  ): EventfulResult<RunEvent> {
    return this.handle.sqlite.transaction(() => {
      this.requireRunRow(runId);
      const runEvent = this.insertRunEvent(runId, type, message, payload);
      const domainEvent = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        eventType: type,
      });
      return { value: runEvent, events: [domainEvent], replayed: false };
    })();
  }
}
