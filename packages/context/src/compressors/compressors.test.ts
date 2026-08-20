import { describe, expect, it } from "vitest";
import { getCompressor } from "./index.js";
import { MemoryScratchpadStore } from "../scratchpad-in-memory.js";
import type { CompressionContext } from "./index.js";
import type { ContentType, Fragment } from "../types.js";

const buildCtx = (): CompressionContext => ({
  scratchpad: new MemoryScratchpadStore(),
  llm: null,
  runId: "r1",
  logger: () => {},
});

const makeFragment = (type: ContentType, text: string, extraMeta = {}): Fragment => ({
  id: "f",
  type,
  text,
  originalTokens: text.length,
  currentTokens: text.length,
  compressionLevel: "NONE",
  droppable: false,
  metadata: { ...extraMeta },
});

describe("SYSTEM / USER_QUERY / CITATION 三种保留型", () => {
  it("SYSTEM 全强度保留原文", async () => {
    const c = getCompressor("SYSTEM");
    for (const level of ["WEAK", "MEDIUM", "STRONG"] as const) {
      const out = await c.compress(makeFragment("SYSTEM", "系统"), level, buildCtx());
      expect(out?.text).toBe("系统");
    }
  });

  it("USER_QUERY WEAK/MEDIUM 保留；STRONG 摘要不弃", async () => {
    const c = getCompressor("USER_QUERY");
    const long = "标题".repeat(1000);
    for (const level of ["WEAK", "MEDIUM"] as const) {
      const out = await c.compress(makeFragment("USER_QUERY", long), level, buildCtx());
      expect(out?.text).toBe(long);
    }
    const out = await c.compress(makeFragment("USER_QUERY", long), "STRONG", buildCtx());
    expect(out).not.toBeNull();
    expect(out!.text.length).toBeLessThan(long.length);
    expect(out!.compressionLevel).toBe("STRONG");
  });

  it("CITATION 全强度保留原文", async () => {
    const c = getCompressor("CITATION");
    for (const level of ["WEAK", "MEDIUM", "STRONG"] as const) {
      const out = await c.compress(makeFragment("CITATION", "引用"), level, buildCtx());
      expect(out?.text).toBe("引用");
    }
  });
});

describe("AGENT_REASONING", () => {
  it("WEAK 头尾截断", async () => {
    const c = getCompressor("AGENT_REASONING");
    const long = "思".repeat(2000);
    const out = await c.compress(makeFragment("AGENT_REASONING", long), "WEAK", buildCtx());
    expect(out).not.toBeNull();
    expect(out!.text.length).toBeLessThan(long.length);
    expect(out!.compressionLevel).toBe("WEAK");
  });
  it("MEDIUM 走 ref 写入 scratchpad", async () => {
    const c = getCompressor("AGENT_REASONING");
    const ctx = buildCtx();
    const out = await c.compress(
      makeFragment("AGENT_REASONING", "思考".repeat(500)),
      "MEDIUM",
      ctx,
    );
    expect(out!.metadata.scratchpadRef).toMatch(/^sp_r1_/);
    expect(out!.compressionLevel).toBe("MEDIUM");
    const loaded = await ctx.scratchpad.load(out!.metadata.scratchpadRef!);
    expect(loaded).not.toBeNull();
  });
  it("STRONG 弃", async () => {
    const c = getCompressor("AGENT_REASONING");
    const out = await c.compress(makeFragment("AGENT_REASONING", "x"), "STRONG", buildCtx());
    expect(out).toBeNull();
  });
});

describe("SUB_ANSWER STRONG 用规则型头尾（无 LLM 情况）", () => {
  it("STRONG 保留头尾摘要", async () => {
    const c = getCompressor("SUB_ANSWER");
    const long = "答".repeat(2000);
    const out = await c.compress(makeFragment("SUB_ANSWER", long), "STRONG", buildCtx());
    expect(out).not.toBeNull();
    expect(out!.text.length).toBeLessThan(long.length);
  });
});

describe("TOOL_RESULT_SMALL", () => {
  it("MEDIUM 头 500 + 尾 500", async () => {
    const c = getCompressor("TOOL_RESULT_SMALL");
    const long = "a".repeat(3000);
    const out = await c.compress(makeFragment("TOOL_RESULT_SMALL", long), "MEDIUM", buildCtx());
    expect(out!.text.length).toBeLessThan(long.length);
    expect(out!.text.startsWith("a")).toBe(true);
    expect(out!.text.endsWith("a")).toBe(true);
  });
  it("STRONG 摘要为一句", async () => {
    const c = getCompressor("TOOL_RESULT_SMALL");
    const out = await c.compress(makeFragment("TOOL_RESULT_SMALL", "长内容"), "STRONG", buildCtx());
    expect(out!.text.length).toBeLessThan(50);
  });
});

describe("TOOL_CALL", () => {
  it("WEAK 摘要长参数为占位", async () => {
    const c = getCompressor("TOOL_CALL");
    const frag = makeFragment("TOOL_CALL", JSON.stringify({ cmd: "ls", args: "x".repeat(2000) }));
    const out = await c.compress(frag, "WEAK", buildCtx());
    expect(out!.text).toContain("<omitted");
  });
  it("MEDIUM 无 scratchpadRef 时自动创建", async () => {
    const c = getCompressor("TOOL_CALL");
    const out = await c.compress(makeFragment("TOOL_CALL", "cmd"), "MEDIUM", buildCtx());
    expect(out!.metadata.scratchpadRef).toMatch(/^sp_/);
  });
  it("MEDIUM 已有 scratchpadRef 时直接复用不再写入", async () => {
    const c = getCompressor("TOOL_CALL");
    const ctx = buildCtx();
    const frag = makeFragment("TOOL_CALL", "cmd", {
      scratchpadRef: "sp_r1_1_deadbeef",
    });
    const out = await c.compress(frag, "MEDIUM", ctx);
    expect(out!.text).toContain("sp_r1_1_deadbeef");
    // 未写入 scratchpad
    expect(await ctx.scratchpad.load("sp_r1_1_deadbeef")).toBeNull();
  });
  it("STRONG 弃", async () => {
    const c = getCompressor("TOOL_CALL");
    expect(await c.compress(makeFragment("TOOL_CALL", "x"), "STRONG", buildCtx())).toBeNull();
  });
});

describe("TOOL_RESULT_LARGE", () => {
  it("WEAK 头 2000 + 尾 500", async () => {
    const c = getCompressor("TOOL_RESULT_LARGE");
    const long = "a".repeat(5000);
    const out = await c.compress(makeFragment("TOOL_RESULT_LARGE", long), "WEAK", buildCtx());
    expect(out!.text.length).toBeLessThan(long.length);
  });
  it("MEDIUM 使用 metadata.scratchpadRef 若存在", async () => {
    const c = getCompressor("TOOL_RESULT_LARGE");
    const frag = makeFragment("TOOL_RESULT_LARGE", "big", {
      scratchpadRef: "sp_r1_9_deadbeef",
    });
    const out = await c.compress(frag, "MEDIUM", buildCtx());
    expect(out!.text).toContain("sp_r1_9_deadbeef");
  });
  it("STRONG 弃", async () => {
    const c = getCompressor("TOOL_RESULT_LARGE");
    expect(
      await c.compress(makeFragment("TOOL_RESULT_LARGE", "x"), "STRONG", buildCtx()),
    ).toBeNull();
  });
});

describe("ERROR_TRACE", () => {
  it("STRONG 且 ageTurns >= 2 弃", async () => {
    const c = getCompressor("ERROR_TRACE");
    const frag = makeFragment("ERROR_TRACE", "e", { ageTurns: 2 });
    expect(await c.compress(frag, "STRONG", buildCtx())).toBeNull();
  });
  it("STRONG 且 ageTurns < 2 保留头尾", async () => {
    const c = getCompressor("ERROR_TRACE");
    const long = "err".repeat(2000);
    const frag = makeFragment("ERROR_TRACE", long, { ageTurns: 0 });
    const out = await c.compress(frag, "STRONG", buildCtx());
    expect(out).not.toBeNull();
    expect(out!.text.length).toBeLessThan(long.length);
  });
  it("MEDIUM 走 ref", async () => {
    const c = getCompressor("ERROR_TRACE");
    const out = await c.compress(makeFragment("ERROR_TRACE", "err"), "MEDIUM", buildCtx());
    expect(out!.metadata.scratchpadRef).toMatch(/^sp_/);
  });
});
