import { describe, expect, it } from "vitest";
import { decideTriggerLevel } from "./budget-policy.js";

describe("decideTriggerLevel", () => {
  it("<= 60% 返回 pass", () => {
    expect(decideTriggerLevel({ currentTokens: 300, budgetTokens: 1000, llmReady: true })).toBe(
      "pass",
    );
    expect(decideTriggerLevel({ currentTokens: 600, budgetTokens: 1000, llmReady: true })).toBe(
      "pass",
    );
  });
  it("60%~90% 且 llm 就绪 返回 medium", () => {
    expect(decideTriggerLevel({ currentTokens: 750, budgetTokens: 1000, llmReady: true })).toBe(
      "medium",
    );
  });
  it("60%~90% 且 llm 未就绪 返回 weak", () => {
    expect(decideTriggerLevel({ currentTokens: 750, budgetTokens: 1000, llmReady: false })).toBe(
      "weak",
    );
  });
  it("> 90% 返回 strong 忽略 llm 就绪状态", () => {
    expect(decideTriggerLevel({ currentTokens: 950, budgetTokens: 1000, llmReady: false })).toBe(
      "strong",
    );
    expect(decideTriggerLevel({ currentTokens: 950, budgetTokens: 1000, llmReady: true })).toBe(
      "strong",
    );
  });
  it("budgetTokens <= 0 返回 strong 兜底", () => {
    expect(decideTriggerLevel({ currentTokens: 100, budgetTokens: 0, llmReady: true })).toBe(
      "strong",
    );
  });
});
