import { estimateTokens } from "./token-counter.js";
import { DEFAULT_DROPPABLE_TYPES, type ContentType, type FragmentSpec } from "./types.js";

export interface ClassifierResult {
  type: ContentType;
  confidence: number;
  droppable: boolean;
  reason: string;
}

const SIZE_BOUNDARY_TOKENS = 512;

const droppableByType = (type: ContentType): boolean => DEFAULT_DROPPABLE_TYPES.includes(type);

const wrap = (type: ContentType, confidence: number, reason: string): ClassifierResult => ({
  type,
  confidence,
  droppable: droppableByType(type),
  reason,
});

/**
 * 启发式分类器：
 * - 优先看 spec.type 是否显式指定。
 * - 其次按 metadata.source 前缀/关键字命中固定规则。
 * - 未命中回落到 CITATION（保守：CITATION 全强度保留，不会误弃关键信息）。
 *
 * 参数 opts.llm 目前是占位（当 pipeline 触发 medium/strong 时可以传入 LLM
 * 兜底分类器，本 MVP 未启用；调用方不用传）。
 */
export const classifyFragment = async (
  spec: FragmentSpec,
  _opts?: { llm?: unknown | null },
): Promise<ClassifierResult> => {
  if (spec.type) return wrap(spec.type, 1, "explicit");

  const source = spec.metadata?.source;
  if (source) {
    if (source.startsWith("template.")) return wrap("SYSTEM", 1, `rule:${source}`);
    if (
      source === "task.title" ||
      source === "task.goal" ||
      source === "task.acceptance" ||
      source === "review.feedback"
    ) {
      return wrap("USER_QUERY", 1, `rule:${source}`);
    }
    if (source === "skill" || source === "output.schema" || source === "conflict.path") {
      return wrap("CITATION", 1, `rule:${source}`);
    }
    if (source.startsWith("event:")) {
      const eventType = source.slice("event:".length);
      if (eventType === "runner.fallback" || eventType.endsWith(".failed")) {
        return wrap("ERROR_TRACE", 0.95, `rule:${eventType}`);
      }
      if (
        eventType === "runner.agent" ||
        eventType === "runner.command" ||
        eventType === "runner.review" ||
        eventType === "runner.verifying"
      ) {
        const tokens = estimateTokens(spec.text);
        return wrap(
          tokens > SIZE_BOUNDARY_TOKENS ? "TOOL_RESULT_LARGE" : "TOOL_RESULT_SMALL",
          0.9,
          `rule:${eventType} size=${tokens}`,
        );
      }
      if (
        eventType === "run.playwright.completed" ||
        eventType === "run.conflict_check.completed" ||
        eventType === "run.conflict_resolution.completed"
      ) {
        return wrap("SUB_ANSWER", 0.9, `rule:${eventType}`);
      }
      if (
        eventType.startsWith("run.preview.") ||
        eventType.startsWith("run.continuation.") ||
        eventType === "runner.preparing"
      ) {
        return wrap("TOOL_RESULT_SMALL", 0.8, `rule:${eventType}`);
      }
      return wrap("TOOL_RESULT_SMALL", 0.6, "rule:event-fallback");
    }
  }
  return wrap("CITATION", 0.3, "fallback:unknown-source");
};
