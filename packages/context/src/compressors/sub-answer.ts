import { estimateTokens } from "../token-counter.js";
import type { Compressor } from "./index.js";

const headTail = (text: string, budget: number): string => {
  if (text.length <= budget) return text;
  const half = Math.floor(budget / 2);
  return `${text.slice(0, half)}\n…（子答案摘要，省略 ${text.length - budget} 字符）…\n${text.slice(-half)}`;
};

/**
 * SUB_ANSWER：WEAK/MEDIUM 保留；STRONG 走 LLM 摘要（失败则头尾截断）；不弃。
 */
export const subAnswerCompressor: Compressor = {
  type: "SUB_ANSWER",
  async compress(fragment, level, ctx) {
    if (level === "STRONG") {
      if (ctx.llm && ctx.llm.isReady()) {
        try {
          const summary = await ctx.llm.summarize(fragment.text, {
            targetTokens: Math.max(200, Math.floor(fragment.originalTokens * 0.3)),
            hint: "子问题答案，保留结论与来源",
          });
          ctx.llm.cooldown();
          return {
            ...fragment,
            text: summary,
            currentTokens: estimateTokens(summary),
            compressionLevel: "STRONG",
          };
        } catch (err) {
          ctx.logger("context.compress.llm_failed", { fragmentId: fragment.id, err: String(err) });
        }
      }
      const truncated = headTail(fragment.text, Math.max(400, Math.floor(fragment.text.length * 0.3)));
      return {
        ...fragment,
        text: truncated,
        currentTokens: estimateTokens(truncated),
        compressionLevel: "STRONG",
      };
    }
    return { ...fragment };
  },
};
