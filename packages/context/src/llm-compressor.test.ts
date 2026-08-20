import { describe, expect, it } from "vitest";
import { CooldownGate, NoopLlmCompressor } from "./llm-compressor.js";

describe("CooldownGate", () => {
  it("初始 ready，consume 后 N 轮不 ready", () => {
    const gate = new CooldownGate(5);
    expect(gate.isReady(0)).toBe(true);
    gate.consume(0);
    expect(gate.isReady(1)).toBe(false);
    expect(gate.isReady(4)).toBe(false);
    expect(gate.isReady(5)).toBe(true);
  });

  it("consume 在未就绪时返回 false，不改变状态", () => {
    const gate = new CooldownGate(3);
    gate.consume(0);
    expect(gate.consume(1)).toBe(false);
    expect(gate.isReady(3)).toBe(true);
  });
});

describe("NoopLlmCompressor", () => {
  it("isReady 永远 false", () => {
    expect(new NoopLlmCompressor().isReady()).toBe(false);
  });
  it("summarize 抛错", async () => {
    await expect(new NoopLlmCompressor().summarize("x", { targetTokens: 10 })).rejects.toThrow();
  });
});
