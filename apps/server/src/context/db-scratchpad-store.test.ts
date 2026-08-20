import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, DevLoopRepository, type DatabaseHandle } from "@devloop/db";
import { DbScratchpadStore } from "./db-scratchpad-store.js";
import { createLlmCompressor } from "./llm-compressor-factory.js";

const migrationsFolder = fileURLToPath(new URL("../../../../packages/db/drizzle", import.meta.url));
const handles: DatabaseHandle[] = [];

const createRepositoryWithRun = () => {
  const handle = openDatabase({ filePath: ":memory:", migrationsFolder });
  handles.push(handle);
  const repo = new DevLoopRepository(handle);
  const project = repo.createProject({
    name: "db-scratchpad 测试",
    repositoryUrl: "git@example.com:team/x.git",
    repositoryPath: "/tmp/devloop-db-scratchpad",
    defaultBaseRef: "main",
    headCommit: "base",
  }).value;
  const draft = repo.createTask({
    projectId: project.id,
    targetBranch: "feature/x",
    title: "seed",
    goal: "seed",
    acceptanceCriteria: ["a"],
    priority: 80,
  }).value;
  repo.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const claim = repo.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  if (!claim) throw new Error("测试初始化失败：无法领取一条 task_run");
  return { repo, runId: claim.value.run.id };
};

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

describe("DbScratchpadStore", () => {
  it("透传 save / load / purgeByRun", async () => {
    const { repo, runId } = createRepositoryWithRun();
    const store = new DbScratchpadStore(repo);
    const { key } = await store.save({ runId, contentType: "TOOL_CALL", text: "hi" });
    expect(await store.load(key)).toEqual({ text: "hi", contentType: "TOOL_CALL" });
    await store.purgeByRun(runId);
    expect(await store.load(key)).toBeNull();
  });

  it("purgeOlderThan 透传", async () => {
    const { repo, runId } = createRepositoryWithRun();
    const store = new DbScratchpadStore(repo);
    await store.save({ runId, contentType: "TOOL_CALL", text: "old" });
    await store.purgeOlderThan(0); // 立即清理
    const rows = repo.loadScratchpad("sp_nope");
    expect(rows).toBeNull();
  });
});

describe("createLlmCompressor", () => {
  it("未配置 endpoint 时返回 Noop", () => {
    const c = createLlmCompressor({
      endpoint: null,
      apiKey: "x",
      model: "m",
      maxCallsPerRun: 3,
    });
    expect(c.isReady()).toBe(false);
  });

  it("未配置 apiKey 时返回 Noop", () => {
    const c = createLlmCompressor({
      endpoint: "https://x.example",
      apiKey: null,
      model: "m",
      maxCallsPerRun: 3,
    });
    expect(c.isReady()).toBe(false);
  });

  it("双配置时返回 OpenAI 兼容实现", () => {
    const c = createLlmCompressor({
      endpoint: "https://x.example",
      apiKey: "sk-x",
      model: "gpt-4o-mini",
      maxCallsPerRun: 3,
    });
    // 未 setCurrentTurn 时 gate 初始 ready = true
    expect(c.isReady()).toBe(true);
  });
});
