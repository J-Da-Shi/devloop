import { describe, expect, it, vi } from "vitest";
import {
  MemoryScratchpadStore,
  OpenAiCompatibleLlmCompressor,
} from "@devloop/context";
import { buildTaskPrompt } from "@devloop/runners";
import type { RunnerInput } from "@devloop/runners";

const baseInput = (overrides: Partial<RunnerInput> = {}): RunnerInput => ({
  runId: "r1",
  taskId: "t1",
  title: "标题",
  goal: "目标",
  acceptanceCriteria: ["AC"],
  skills: [],
  worktreePath: null,
  outputSchemaPath: null,
  signal: new AbortController().signal,
  ...overrides,
});

describe("LLM 压缩器启用时的端到端行为", () => {
  it("配置端点后 setCurrentTurn(0) 让 gate 就绪，isReady=true", () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "摘要" } }] })),
    );
    const llm = new OpenAiCompatibleLlmCompressor({
      endpoint: "https://api.example.com/v1",
      apiKey: "sk-x",
      model: "gpt-4o-mini",
      fetchImpl,
      cooldownRounds: 5,
    });
    llm.setCurrentTurn(0);
    expect(llm.isReady()).toBe(true);
  });

  it("Prompt 生成流程不因启用 LLM 崩溃（不强制断言 fetch 被调，看 pipeline 是否顺利完成）", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "简短摘要" } }] })),
    );
    const llm = new OpenAiCompatibleLlmCompressor({
      endpoint: "https://api.example.com/v1",
      apiKey: "sk-x",
      model: "gpt-4o-mini",
      fetchImpl,
      cooldownRounds: 5,
    });
    llm.setCurrentTurn(0);

    const scratchpad = new MemoryScratchpadStore();
    const bigSkill = {
      id: "s",
      name: "big",
      description: "d",
      version: 1,
      contentHash: "h",
      content: "长".repeat(10_000),
    };
    const prompt = await buildTaskPrompt(
      baseInput({
        skills: [bigSkill],
        contextBudget: 1_500,
        contextPipeline: { scratchpad, llm, runId: "r1" },
      }),
      "{}",
    );
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("consume 后进入冷却，isReady=false 直到 rounds 后", () => {
    const llm = new OpenAiCompatibleLlmCompressor({
      endpoint: "e",
      apiKey: "k",
      model: "m",
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "a" } }] })),
      cooldownRounds: 3,
    });
    llm.setCurrentTurn(0);
    llm.cooldown();
    llm.setCurrentTurn(1);
    expect(llm.isReady()).toBe(false);
    llm.setCurrentTurn(3);
    expect(llm.isReady()).toBe(true);
  });
});
