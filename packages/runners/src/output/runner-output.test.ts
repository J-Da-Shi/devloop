import { describe, expect, it } from "vitest";
import { agentPlanSchema, agentVerificationSchema } from "@devloop/shared";
import { buildRepairPrompt, sanitizeEventData } from "./runner-output.js";

describe("sanitizeEventData", () => {
  it("完整保留超长字符串、大数组和深层对象", () => {
    const longText = "日志".repeat(5_000);
    const items = Array.from({ length: 150 }, (_, index) => ({ index, text: longText }));
    let nested: unknown = { value: longText };
    for (let level = 0; level < 12; level += 1) nested = { level, nested };

    const sanitized = sanitizeEventData({ longText, items, nested }, (value) => value) as {
      longText: string;
      items: Array<{ index: number; text: string }>;
      nested: unknown;
    };

    expect(sanitized.longText).toBe(longText);
    expect(sanitized.items).toHaveLength(150);
    expect(sanitized.items.at(-1)).toEqual({ index: 149, text: longText });
    expect(sanitized.nested).toEqual(nested);
  });
});

describe("Runner 结构化输出", () => {
  it("修复提示保留完整无效输出与校验错误", () => {
    const invalidOutput = "无效输出".repeat(10_000);
    const validationError = "校验错误".repeat(3_000);
    const prompt = buildRepairPrompt("{}", invalidOutput, validationError, (value) => value);

    expect(prompt).toContain(invalidOutput);
    expect(prompt).toContain(validationError);
  });

  it("规划和验收结果不限制内容长度与数组数量", () => {
    const longText = "结果内容".repeat(3_000);
    expect(
      agentPlanSchema.safeParse({
        summary: longText,
        steps: Array.from({ length: 120 }, (_, index) => ({
          id: `step-${index}`,
          description: longText,
          files: Array.from({ length: 120 }, (__, fileIndex) => `src/${index}-${fileIndex}.ts`),
          verification: longText,
        })),
        acceptanceCriteria: Array.from({ length: 120 }, () => longText),
        assumptions: Array.from({ length: 120 }, () => longText),
        risks: Array.from({ length: 120 }, () => longText),
      }).success,
    ).toBe(true);
    expect(
      agentVerificationSchema.safeParse({
        status: "passed",
        summary: longText,
        criteria: Array.from({ length: 120 }, () => ({
          criterion: longText,
          status: "passed",
          evidence: longText,
        })),
        checks: Array.from({ length: 120 }, () => ({
          command: longText,
          status: "passed",
          evidence: longText,
        })),
        issues: Array.from({ length: 120 }, () => longText),
      }).success,
    ).toBe(true);
  });
});
