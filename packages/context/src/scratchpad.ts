import type { ContentType } from "./types.js";

export interface ScratchpadStore {
  /** 保存一条内容，返回内部 key（供 Fragment 展开时按 key 查询原文）。 */
  save(input: { runId: string; contentType: ContentType; text: string }): Promise<{ key: string }>;
  /** 按 key 读取原文与内容类型；不存在返回 null。 */
  load(key: string): Promise<{ text: string; contentType: ContentType } | null>;
  /** 按 runId 清理该 run 名下的全部记录（run 结束后调用）。 */
  purgeByRun(runId: string): Promise<void>;
  /** 清理创建时间早于 (Date.now() - millis) 的记录，用于启动时执行一次。 */
  purgeOlderThan(millis: number): Promise<void>;
}
