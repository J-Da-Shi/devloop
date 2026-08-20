import { estimateTokens } from "../token-counter.js";
import type { Compressor } from "./index.js";

const headTail = (text: string, budget: number): string => {
  if (text.length <= budget) return text;
  const half = Math.floor(budget / 2);
  return `${text.slice(0, half)}\n…（已省略 ${text.length - budget} 字符）…\n${text.slice(-half)}`;
};

/**
 * AGENT_REASONING：WEAK 头尾截断；MEDIUM 写 ref；STRONG 弃。
 */
export const agentReasoningCompressor: Compressor = {
  type: "AGENT_REASONING",
  async compress(fragment, level, ctx) {
    if (level === "STRONG") return null;
    if (level === "MEDIUM") {
      const { key } = await ctx.scratchpad.save({
        runId: ctx.runId,
        contentType: "AGENT_REASONING",
        text: fragment.text,
      });
      const placeholder = `[REF:${key}]`;
      return {
        ...fragment,
        text: placeholder,
        currentTokens: estimateTokens(placeholder),
        compressionLevel: "MEDIUM",
        metadata: { ...fragment.metadata, scratchpadRef: key },
      };
    }
    const truncated = headTail(fragment.text, Math.max(1000, Math.floor(fragment.text.length * 0.4)));
    return {
      ...fragment,
      text: truncated,
      currentTokens: estimateTokens(truncated),
      compressionLevel: "WEAK",
    };
  },
};
