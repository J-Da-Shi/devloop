import type { Compressor } from "./index.js";

/** SYSTEM 段：全强度保留，不修改。 */
export const systemCompressor: Compressor = {
  type: "SYSTEM",
  async compress(fragment) {
    return { ...fragment };
  },
};
