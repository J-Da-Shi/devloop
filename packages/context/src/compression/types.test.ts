import { describe, expect, it } from "vitest";
import { CONTENT_TYPES, COMPRESSION_LEVELS } from "./types.js";

describe("types", () => {
  it("枚举 9 种 ContentType", () => {
    expect(CONTENT_TYPES).toEqual([
      "SYSTEM",
      "USER_QUERY",
      "AGENT_REASONING",
      "TOOL_CALL",
      "TOOL_RESULT_SMALL",
      "TOOL_RESULT_LARGE",
      "SUB_ANSWER",
      "CITATION",
      "ERROR_TRACE",
    ]);
  });
  it("枚举 4 种 CompressionLevel", () => {
    expect(COMPRESSION_LEVELS).toEqual(["NONE", "WEAK", "MEDIUM", "STRONG"]);
  });
});
