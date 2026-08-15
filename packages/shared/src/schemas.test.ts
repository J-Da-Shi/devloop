import { describe, expect, it } from "vitest";
import { approveRunInputSchema } from "./schemas.js";

const command = {
  expectedVersion: 3,
  idempotencyKey: "2d29a851-94c7-4c79-a58b-87ad6aa4241e",
};

describe("approveRunInputSchema", () => {
  it("接受目标 Commit 和多种冲突解决策略", () => {
    expect(
      approveRunInputSchema.parse({
        ...command,
        expectedTargetCommit: "a".repeat(40),
        conflictResolutions: [
          { path: "src/app.ts", strategy: "content", content: "resolved\n" },
          { path: "public/logo.png", strategy: "result" },
        ],
      }),
    ).toMatchObject({ expectedTargetCommit: "a".repeat(40) });
  });

  it("拒绝同一个文件的重复解决结果", () => {
    const result = approveRunInputSchema.safeParse({
      ...command,
      conflictResolutions: [
        { path: "src/app.ts", strategy: "target" },
        { path: "src/app.ts", strategy: "result" },
      ],
    });

    expect(result.success).toBe(false);
  });
});
