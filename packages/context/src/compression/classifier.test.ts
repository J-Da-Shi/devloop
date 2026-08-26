import { describe, expect, it } from "vitest";
import { classifyFragment } from "./classifier.js";

describe("classifyFragment 启发式", () => {
  it("已带 type 时保持不变", async () => {
    const r = await classifyFragment({ text: "任意", type: "USER_QUERY" });
    expect(r.type).toBe("USER_QUERY");
    expect(r.confidence).toBe(1);
  });

  it("source = task.title 落 USER_QUERY", async () => {
    const r = await classifyFragment({ text: "标题", metadata: { source: "task.title" } });
    expect(r.type).toBe("USER_QUERY");
    expect(r.droppable).toBe(false);
  });

  it("source = skill 落 CITATION", async () => {
    const r = await classifyFragment({ text: "s", metadata: { source: "skill" } });
    expect(r.type).toBe("CITATION");
  });

  it("source = template.rules 落 SYSTEM", async () => {
    const r = await classifyFragment({ text: "r", metadata: { source: "template.rules" } });
    expect(r.type).toBe("SYSTEM");
  });

  it("event:run.playwright.failed 落 ERROR_TRACE", async () => {
    const r = await classifyFragment({
      text: "e",
      metadata: { source: "event:run.playwright.failed" },
    });
    expect(r.type).toBe("ERROR_TRACE");
    expect(r.droppable).toBe(true);
  });

  it("event:runner.command 长度 < 512 token 落 TOOL_RESULT_SMALL", async () => {
    const r = await classifyFragment({
      text: "cmd output",
      metadata: { source: "event:runner.command" },
    });
    expect(r.type).toBe("TOOL_RESULT_SMALL");
  });

  it("event:runner.command 长度 > 512 token 落 TOOL_RESULT_LARGE", async () => {
    const r = await classifyFragment({
      text: "x".repeat(4000),
      metadata: { source: "event:runner.command" },
    });
    expect(r.type).toBe("TOOL_RESULT_LARGE");
  });

  it("event:run.playwright.completed 落 SUB_ANSWER", async () => {
    const r = await classifyFragment({
      text: "ok",
      metadata: { source: "event:run.playwright.completed" },
    });
    expect(r.type).toBe("SUB_ANSWER");
  });

  it("event:runner.preparing 落 TOOL_RESULT_SMALL", async () => {
    const r = await classifyFragment({
      text: "starting",
      metadata: { source: "event:runner.preparing" },
    });
    expect(r.type).toBe("TOOL_RESULT_SMALL");
  });

  it("event:runner.fallback 落 ERROR_TRACE", async () => {
    const r = await classifyFragment({
      text: "fallback",
      metadata: { source: "event:runner.fallback" },
    });
    expect(r.type).toBe("ERROR_TRACE");
  });

  it("event 中未知类型回落 TOOL_RESULT_SMALL", async () => {
    const r = await classifyFragment({
      text: "unknown event",
      metadata: { source: "event:some.random.event" },
    });
    expect(r.type).toBe("TOOL_RESULT_SMALL");
  });

  it("无 source 且未启用 LLM 时回落 CITATION", async () => {
    const r = await classifyFragment({ text: "u" });
    expect(r.type).toBe("CITATION");
    expect(r.confidence).toBeLessThan(0.5);
  });
});
