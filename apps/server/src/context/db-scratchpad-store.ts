import { estimateTokens, type ContentType, type ScratchpadStore } from "@devloop/context";
import type { DevLoopRepository } from "@devloop/db";

/**
 * 把 @devloop/context 的 ScratchpadStore 接口对接到 DevLoopRepository。
 * pipeline 在 MEDIUM 阶段调用 save，展开阶段调用 load，Run 结束调用 purgeByRun。
 */
export class DbScratchpadStore implements ScratchpadStore {
  constructor(private readonly repository: DevLoopRepository) {}

  async save(input: {
    runId: string;
    contentType: ContentType;
    text: string;
  }): Promise<{ key: string }> {
    return this.repository.saveScratchpad({
      runId: input.runId,
      contentType: input.contentType,
      contentText: input.text,
      originalTokens: estimateTokens(input.text),
    });
  }

  async load(key: string): Promise<{ text: string; contentType: ContentType } | null> {
    const row = this.repository.loadScratchpad(key);
    if (!row) return null;
    return { text: row.contentText, contentType: row.contentType as ContentType };
  }

  async purgeByRun(runId: string): Promise<void> {
    this.repository.purgeScratchpadByRun(runId);
  }

  async purgeOlderThan(millis: number): Promise<void> {
    this.repository.purgeScratchpadOlderThan(millis);
  }
}
