import { describe, expect, it } from "vitest";
import { MemoryScratchpadStore } from "./scratchpad-in-memory.js";

describe("MemoryScratchpadStore", () => {
  it("save 后 load 能取回原文与类型", async () => {
    const store = new MemoryScratchpadStore();
    const { key } = await store.save({ runId: "r1", contentType: "TOOL_CALL", text: "hi" });
    const row = await store.load(key);
    expect(row).toEqual({ text: "hi", contentType: "TOOL_CALL" });
  });

  it("purgeByRun 清 run 相关全部条目", async () => {
    const store = new MemoryScratchpadStore();
    const a = await store.save({ runId: "r1", contentType: "TOOL_CALL", text: "a" });
    const b = await store.save({ runId: "r2", contentType: "TOOL_CALL", text: "b" });
    await store.purgeByRun("r1");
    expect(await store.load(a.key)).toBeNull();
    expect(await store.load(b.key)).not.toBeNull();
  });

  it("同 runId 的写入序号自增", async () => {
    const store = new MemoryScratchpadStore();
    const first = await store.save({ runId: "r1", contentType: "TOOL_CALL", text: "a" });
    const second = await store.save({ runId: "r1", contentType: "TOOL_CALL", text: "b" });
    expect(first.key).toMatch(/^sp_r1_1_/);
    expect(second.key).toMatch(/^sp_r1_2_/);
  });

  it("load 不存在的 key 返回 null", async () => {
    const store = new MemoryScratchpadStore();
    expect(await store.load("sp_nope_1_deadbeef")).toBeNull();
  });
});
