import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleLlmCompressor } from "./llm-compressor-openai.js";

const okResponse = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("OpenAiCompatibleLlmCompressor", () => {
  it("成功路径：POST /chat/completions 并读取 message.content", async () => {
    const fetchImpl = vi.fn(async () => okResponse("摘要"));
    const c = new OpenAiCompatibleLlmCompressor({
      endpoint: "https://api.example.com",
      apiKey: "sk-x",
      model: "gpt-4o-mini",
      fetchImpl,
      cooldownRounds: 2,
    });
    c.setCurrentTurn(0);
    const out = await c.summarize("原文很长", { targetTokens: 100, hint: "错误堆栈" });
    expect(out).toBe("摘要");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/chat/completions");
    expect(init).toMatchObject({ method: "POST" });
  });

  it("冷却期 isReady=false", async () => {
    const c = new OpenAiCompatibleLlmCompressor({
      endpoint: "e",
      apiKey: "k",
      model: "m",
      fetchImpl: async () => okResponse("a"),
      cooldownRounds: 3,
    });
    c.setCurrentTurn(0);
    expect(c.isReady()).toBe(true);
    c.cooldown();
    c.setCurrentTurn(1);
    expect(c.isReady()).toBe(false);
    c.setCurrentTurn(3);
    expect(c.isReady()).toBe(true);
  });

  it("超过 maxCallsPerRun 后 isReady=false，直到 resetRun", async () => {
    const c = new OpenAiCompatibleLlmCompressor({
      endpoint: "e",
      apiKey: "k",
      model: "m",
      fetchImpl: async () => okResponse("a"),
      cooldownRounds: 1,
      maxCallsPerRun: 2,
    });
    c.setCurrentTurn(0);
    c.cooldown();
    c.setCurrentTurn(1);
    c.cooldown();
    c.setCurrentTurn(2);
    expect(c.isReady()).toBe(false);
    c.resetRun();
    expect(c.isReady()).toBe(true);
  });

  it("HTTP 非 2xx 抛错", async () => {
    const c = new OpenAiCompatibleLlmCompressor({
      endpoint: "e",
      apiKey: "k",
      model: "m",
      fetchImpl: async () => new Response("boom", { status: 500 }),
    });
    c.setCurrentTurn(0);
    await expect(c.summarize("x", { targetTokens: 10 })).rejects.toThrow(/HTTP 500/);
  });

  it("返回内容为空时抛错", async () => {
    const c = new OpenAiCompatibleLlmCompressor({
      endpoint: "e",
      apiKey: "k",
      model: "m",
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    });
    c.setCurrentTurn(0);
    await expect(c.summarize("x", { targetTokens: 10 })).rejects.toThrow(/内容为空/);
  });
});
