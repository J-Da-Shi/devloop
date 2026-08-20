import { estimateTokens } from "../token-counter.js";
import type { Compressor } from "./index.js";

/**
 * TOOL_RESULT_SMALL：WEAK 保留；MEDIUM 头 500 + 尾 500；STRONG 一句摘要。
 */
export const toolResultSmallCompressor: Compressor = {
  type: "TOOL_RESULT_SMALL",
  async compress(fragment, level) {
    if (level === "STRONG") {
      const summary = `工具结果 ${fragment.metadata.source ?? "未知来源"}（原长 ${fragment.text.length} 字符）`;
      return {
        ...fragment,
        text: summary,
        currentTokens: estimateTokens(summary),
        compressionLevel: "STRONG",
      };
    }
    if (level === "MEDIUM") {
      const head = fragment.text.slice(0, 500);
      const tail = fragment.text.slice(-500);
      const merged =
        fragment.text.length <= 1000
          ? fragment.text
          : `${head}\n…（省略 ${fragment.text.length - 1000} 字符）…\n${tail}`;
      return {
        ...fragment,
        text: merged,
        currentTokens: estimateTokens(merged),
        compressionLevel: "MEDIUM",
      };
    }
    return { ...fragment };
  },
};
