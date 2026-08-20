import { estimateTokens } from "../token-counter.js";
import type { Compressor } from "./index.js";

/** 把 JSON 里超过 200 字符的字符串值替换成占位。 */
const summariseArgs = (text: string): string =>
  text.replace(/"([^"]{200,})"/g, (_m, val: string) => `"<omitted ${val.length} chars>"`);

/**
 * TOOL_CALL：WEAK 参数摘要；MEDIUM 走 ref（复用 metadata.scratchpadRef 或新建）；STRONG 弃。
 */
export const toolCallCompressor: Compressor = {
  type: "TOOL_CALL",
  async compress(fragment, level, ctx) {
    if (level === "STRONG") return null;
    if (level === "MEDIUM") {
      let key = fragment.metadata.scratchpadRef;
      if (!key) {
        ({ key } = await ctx.scratchpad.save({
          runId: ctx.runId,
          contentType: "TOOL_CALL",
          text: fragment.text,
        }));
      }
      const placeholder = `[TOOL_CALL REF:${key}]`;
      return {
        ...fragment,
        text: placeholder,
        currentTokens: estimateTokens(placeholder),
        compressionLevel: "MEDIUM",
        metadata: { ...fragment.metadata, scratchpadRef: key },
      };
    }
    const summarised = summariseArgs(fragment.text);
    return {
      ...fragment,
      text: summarised,
      currentTokens: estimateTokens(summarised),
      compressionLevel: "WEAK",
    };
  },
};
