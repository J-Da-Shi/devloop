import type { CompressionLevel, ContentType, Fragment } from "../types.js";
import type { ScratchpadStore } from "../scratchpad.js";
import type { LlmCompressor } from "../llm-compressor.js";
import { systemCompressor } from "./system.js";
import { userQueryCompressor } from "./user-query.js";
import { citationCompressor } from "./citation.js";
import { agentReasoningCompressor } from "./agent-reasoning.js";
import { subAnswerCompressor } from "./sub-answer.js";
import { toolResultSmallCompressor } from "./tool-result-small.js";
import { toolCallCompressor } from "./tool-call.js";
import { toolResultLargeCompressor } from "./tool-result-large.js";
import { errorTraceCompressor } from "./error-trace.js";

export interface CompressionContext {
  scratchpad: ScratchpadStore;
  llm: LlmCompressor | null;
  runId: string;
  logger: (event: string, payload: Record<string, unknown>) => void;
}

export interface Compressor {
  readonly type: ContentType;
  compress(
    fragment: Fragment,
    level: CompressionLevel,
    ctx: CompressionContext,
  ): Promise<Fragment | null>;
}

const registry: Partial<Record<ContentType, Compressor>> = {
  SYSTEM: systemCompressor,
  USER_QUERY: userQueryCompressor,
  CITATION: citationCompressor,
  AGENT_REASONING: agentReasoningCompressor,
  SUB_ANSWER: subAnswerCompressor,
  TOOL_RESULT_SMALL: toolResultSmallCompressor,
  TOOL_CALL: toolCallCompressor,
  TOOL_RESULT_LARGE: toolResultLargeCompressor,
  ERROR_TRACE: errorTraceCompressor,
};

export const getCompressor = (type: ContentType): Compressor => {
  const c = registry[type];
  if (!c) throw new Error(`compressor 未注册：${type}`);
  return c;
};

export const registerCompressor = (c: Compressor): void => {
  registry[c.type] = c;
};
