import { describe, expect, it } from "vitest";
import {
  approveRunInputSchema,
  createTaskInputSchema,
  resolveRunConflictsInputSchema,
  runConflictAgentResolutionSchema,
  updateTaskInputSchema,
} from "./schemas.js";

const command = {
  expectedVersion: 3,
  idempotencyKey: "2d29a851-94c7-4c79-a58b-87ad6aa4241e",
};

describe("createTaskInputSchema", () => {
  const input = {
    projectId: "2d29a851-94c7-4c79-a58b-87ad6aa4241e",
    targetBranch: "main",
    title: "自动解决冲突",
    goal: "验证任务配置默认值",
    acceptanceCriteria: ["默认开启"],
    priority: 50,
  };

  it("默认开启自动解决冲突，同时允许用户关闭", () => {
    expect(createTaskInputSchema.parse(input).autoResolveConflicts).toBe(true);
    expect(
      createTaskInputSchema.parse({ ...input, autoResolveConflicts: false }).autoResolveConflicts,
    ).toBe(false);
  });

  it("默认创建代码开发任务，并接受互联网研究类型", () => {
    expect(createTaskInputSchema.parse(input).taskType).toBe("DEVELOPMENT");
    expect(createTaskInputSchema.parse({ ...input, taskType: "RESEARCH" }).taskType).toBe(
      "RESEARCH",
    );
    expect(
      updateTaskInputSchema.parse({
        taskType: "RESEARCH",
        ...command,
      }).taskType,
    ).toBe("RESEARCH");
  });
});

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

describe("resolveRunConflictsInputSchema", () => {
  it("要求固定目标 Commit，并接受持久化的 Agent 建议", () => {
    expect(
      resolveRunConflictsInputSchema.parse({
        ...command,
        expectedTargetCommit: "b".repeat(40),
      }),
    ).toMatchObject({ expectedTargetCommit: "b".repeat(40) });
    expect(
      runConflictAgentResolutionSchema.parse({
        targetCommit: "b".repeat(40),
        resolutions: [{ path: "src/app.ts", strategy: "content", content: "resolved\n" }],
        summary: "Agent 已解决冲突",
        completedAt: "2026-08-16T10:00:00.000Z",
      }),
    ).toMatchObject({ summary: "Agent 已解决冲突" });
  });
});
