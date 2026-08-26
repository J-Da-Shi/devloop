import { estimateTokens } from "../token-counter.js";
import type { Compressor } from "./index.js";

const headTail = (text: string, budget: number): string => {
  if (text.length <= budget) return text;
  const half = Math.floor(budget / 2);
  return `${text.slice(0, half)}\n…（错误栈中段省略 ${text.length - budget} 字符）…\n${text.slice(-half)}`;
};

/**
 * ERROR_TRACE：WEAK 头 1000 + 尾 1000；MEDIUM 走 ref；STRONG 依 ageTurns 决定弃或截断。
 */
export const errorTraceCompressor: Compressor = {
  type: "ERROR_TRACE",
  async compress(fragment, level, ctx) {
    if (level === "STRONG") {
      if ((fragment.metadata.ageTurns ?? 0) >= 2) return null;
      const truncated = headTail(fragment.text, 2000);
      return {
        ...fragment,
        text: truncated,
        currentTokens: estimateTokens(truncated),
        compressionLevel: "STRONG",
      };
    }
    if (level === "MEDIUM") {
      const { key } = await ctx.scratchpad.save({
        runId: ctx.runId,
        contentType: "ERROR_TRACE",
        text: fragment.text,
      });
      const placeholder = `[ERROR REF:${key}]`;
      return {
        ...fragment,
        text: placeholder,
        currentTokens: estimateTokens(placeholder),
        compressionLevel: "MEDIUM",
        metadata: { ...fragment.metadata, scratchpadRef: key },
      };
    }
    const truncated = headTail(fragment.text, 2000);
    return {
      ...fragment,
      text: truncated,
      currentTokens: estimateTokens(truncated),
      compressionLevel: "WEAK",
    };
  },
};
