import { createHash } from "node:crypto";
import type { ContentType } from "./types.js";
import type { ScratchpadStore } from "./scratchpad.js";

interface Row {
  runId: string;
  contentType: ContentType;
  text: string;
  createdAt: number;
}

/**
 * 仅供单元测试使用的内存实现。生产环境用 apps/server 提供的 DbScratchpadStore。
 */
export class MemoryScratchpadStore implements ScratchpadStore {
  private readonly rows = new Map<string, Row>();
  private readonly counters = new Map<string, number>();

  async save(input: {
    runId: string;
    contentType: ContentType;
    text: string;
  }): Promise<{ key: string }> {
    const seq = (this.counters.get(input.runId) ?? 0) + 1;
    this.counters.set(input.runId, seq);
    const hash = createHash("sha256").update(input.text).digest("hex").slice(0, 8);
    const key = `sp_${input.runId}_${seq}_${hash}`;
    this.rows.set(key, {
      runId: input.runId,
      contentType: input.contentType,
      text: input.text,
      createdAt: Date.now(),
    });
    return { key };
  }

  async load(key: string): Promise<{ text: string; contentType: ContentType } | null> {
    const row = this.rows.get(key);
    if (!row) return null;
    return { text: row.text, contentType: row.contentType };
  }

  async purgeByRun(runId: string): Promise<void> {
    for (const [key, row] of this.rows) {
      if (row.runId === runId) this.rows.delete(key);
    }
    this.counters.delete(runId);
  }

  async purgeOlderThan(millis: number): Promise<void> {
    const threshold = Date.now() - millis;
    for (const [key, row] of this.rows) {
      if (row.createdAt < threshold) this.rows.delete(key);
    }
  }
}
