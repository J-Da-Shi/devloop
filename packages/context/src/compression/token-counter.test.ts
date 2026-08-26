import { describe, expect, it } from "vitest";
import { estimateTokens } from "./token-counter.js";

describe("estimateTokens", () => {
  it("纯 ASCII 按 length / 3.5 向上取整", () => {
    expect(estimateTokens("hello world")).toBe(Math.ceil(11 / 3.5));
  });
  it("纯 CJK 每字符 1.6 token", () => {
    expect(estimateTokens("你好世界")).toBe(Math.ceil(4 * 1.6));
  });
  it("混合按类别加权", () => {
    // 4 CJK * 1.6 + 6 ascii / 3.5 = 6.4 + 1.71 = 8.11 → 9
    expect(estimateTokens("你好世界 hello")).toBe(Math.ceil(4 * 1.6 + 6 / 3.5));
  });
  it("空串返回 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
