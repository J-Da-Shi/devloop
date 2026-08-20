import { describe, expect, it } from "vitest";
import { contextScratchpad } from "./schema.js";

describe("contextScratchpad schema", () => {
  it("暴露预期列", () => {
    const columns = Object.keys(contextScratchpad).sort();
    expect(columns).toEqual(
      [
        "key",
        "runId",
        "contentType",
        "contentText",
        "originalTokens",
        "sizeBytes",
        "createdAt",
      ].sort(),
    );
  });
});
