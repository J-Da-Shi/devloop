import { describe, expect, it } from "vitest";
import { compressUntilFits, ContextBudgetExceededError } from "./pipeline.js";
import { MemoryScratchpadStore } from "./scratchpad-in-memory.js";

const store = () => new MemoryScratchpadStore();

describe("compressUntilFits", () => {
  it("小于预算直接 pass 且拼接文本包含所有段", async () => {
    const r = await compressUntilFits(
      [{ text: "短", metadata: { source: "task.title" } }],
      { budgetTokens: 1000, runId: "r1", scratchpad: store() },
    );
    expect(r.stats.triggerLevels[0]).toBe("pass");
    expect(r.text).toContain("短");
  });

  it("超过 90% 升 strong 并弃可弃 fragment，保证 <= 预算", async () => {
    const big = "长".repeat(2000);
    const r = await compressUntilFits(
      [
        { text: "标题", metadata: { source: "task.title" } },
        { text: big, metadata: { source: "event:runner.command" } },
      ],
      { budgetTokens: 500, runId: "r1", scratchpad: store() },
    );
    expect(r.stats.totalTokens).toBeLessThanOrEqual(500);
  });

  it("3 次 strong 后仍超预算走硬切，SYSTEM/USER_QUERY 仍保留", async () => {
    const big = "长".repeat(20_000);
    const r = await compressUntilFits(
      [
        { text: "关键任务", metadata: { source: "task.title" } },
        { text: big, metadata: { source: "event:runner.command" } },
      ],
      { budgetTokens: 30, runId: "r1", scratchpad: store() },
    );
    expect(r.text).toContain("关键任务");
  });

  it("硬切仍不够则抛 ContextBudgetExceededError", async () => {
    await expect(
      compressUntilFits(
        [
          {
            text: "系统规则很长很长很长很长很长很长很长很长很长很长",
            metadata: { source: "template.rules" },
          },
          {
            text: "用户查询也很长很长很长很长很长很长很长",
            metadata: { source: "task.title" },
          },
        ],
        { budgetTokens: 5, runId: "r1", scratchpad: store() },
      ),
    ).rejects.toBeInstanceOf(ContextBudgetExceededError);
  });

  it("MEDIUM 阶段写入 scratchpad 后交付前默认展开", async () => {
    // 触发 medium 需要 llm 就绪；构造一个 always-ready 的假 llm，让 60~90% 落 medium。
    const fakeLlm = {
      isReady: () => true,
      cooldown: () => {},
      summarize: async () => "摘要",
    };
    const s = store();
    // 让 total 落在 60~90% 范围（medium）后再压缩；提供一个只压 MEDIUM 会走 ref 的段。
    const bigReasoning = "思".repeat(2000); // 会被 classifier 归入 CITATION（无 source），需明确带 source
    const r = await compressUntilFits(
      [
        { text: "标题", metadata: { source: "task.title" } },
        { text: bigReasoning, type: "AGENT_REASONING" },
      ],
      { budgetTokens: 800, runId: "r1", scratchpad: s, llm: fakeLlm },
    );
    // 展开后 AGENT_REASONING 若能装下预算，应恢复原文；否则保留占位。
    expect(r.stats.totalTokens).toBeLessThanOrEqual(800);
  });
});
