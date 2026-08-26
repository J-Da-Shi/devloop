import { estimateTokens } from "../token-counter.js";
import type { Compressor } from "./index.js";

/**
 * TOOL_RESULT_LARGE：WEAK 头 2000 + 尾 500；MEDIUM 走 ref；STRONG 弃。
 */
export const toolResultLargeCompressor: Compressor = {
  type: "TOOL_RESULT_LARGE",
  async compress(fragment, level, ctx) {
    if (level === "STRONG") return null;
    if (level === "MEDIUM") {
      let key = fragment.metadata.scratchpadRef;
      if (!key) {
        ({ key } = await ctx.scratchpad.save({
          runId: ctx.runId,
          contentType: "TOOL_RESULT_LARGE",
          text: fragment.text,
        }));
      }
      const placeholder = `[TOOL_RESULT REF:${key}]`;
      return {
        ...fragment,
        text: placeholder,
        currentTokens: estimateTokens(placeholder),
        compressionLevel: "MEDIUM",
        metadata: { ...fragment.metadata, scratchpadRef: key },
      };
    }
    // WEAK
    if (fragment.text.length <= 2500) return { ...fragment };
    const head = fragment.text.slice(0, 2000);
    const tail = fragment.text.slice(-500);
    const merged = `${head}\n…（省略 ${fragment.text.length - 2500} 字符）…\n${tail}`;
    return {
      ...fragment,
      text: merged,
      currentTokens: estimateTokens(merged),
      compressionLevel: "WEAK",
    };
  },
};
