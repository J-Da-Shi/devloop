import type { Compressor } from "./index.js";

/** CITATION：引用/证据，全强度保留（保守：不会误弃 skill/schema/conflict.path）。 */
export const citationCompressor: Compressor = {
  type: "CITATION",
  async compress(fragment) {
    return { ...fragment };
  },
};
