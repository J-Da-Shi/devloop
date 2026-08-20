import { createHash } from "node:crypto";
import { eq, lt, sql } from "drizzle-orm";
import { contextScratchpad } from "../schema.js";
import { DeviceRepository } from "./device-repository.js";

export interface ScratchpadRow {
  key: string;
  runId: string;
  contentType: string;
  contentText: string;
  originalTokens: number;
  sizeBytes: number;
  createdAt: number;
}

export interface SaveScratchpadInput {
  runId: string;
  contentType: string;
  contentText: string;
  originalTokens: number;
  now?: number;
}

const MAX_CONTENT_BYTES = 1_048_576; // 1 MB

export class ScratchpadRepository extends DeviceRepository {
  saveScratchpad(input: SaveScratchpadInput): { key: string } {
    const sizeBytes = Buffer.byteLength(input.contentText, "utf8");
    if (sizeBytes > MAX_CONTENT_BYTES) {
      throw new Error("scratchpad 单条 content 超过 1 MB 上限");
    }
    const now = input.now ?? Date.now();
    return this.handle.sqlite.transaction(() => {
      const row = this.handle.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(contextScratchpad)
        .where(eq(contextScratchpad.runId, input.runId))
        .get();
      const seq = (row?.count ?? 0) + 1;
      const hash = createHash("sha256").update(input.contentText).digest("hex").slice(0, 8);
      const key = `sp_${input.runId}_${seq}_${hash}`;
      this.handle.db
        .insert(contextScratchpad)
        .values({
          key,
          runId: input.runId,
          contentType: input.contentType,
          contentText: input.contentText,
          originalTokens: input.originalTokens,
          sizeBytes,
          createdAt: now,
        })
        .run();
      return { key };
    })();
  }

  loadScratchpad(key: string): ScratchpadRow | null {
    const row = this.handle.db
      .select()
      .from(contextScratchpad)
      .where(eq(contextScratchpad.key, key))
      .get();
    return row ?? null;
  }

  purgeScratchpadByRun(runId: string): void {
    this.handle.db.delete(contextScratchpad).where(eq(contextScratchpad.runId, runId)).run();
  }

  purgeScratchpadOlderThan(millis: number, now = Date.now()): number {
    const threshold = now - millis;
    const result = this.handle.db
      .delete(contextScratchpad)
      .where(lt(contextScratchpad.createdAt, threshold))
      .run();
    return Number(result.changes ?? 0);
  }
}
