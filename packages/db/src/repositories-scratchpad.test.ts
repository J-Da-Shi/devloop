import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "./client.js";
import { DevLoopRepository } from "./repositories.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const handles: DatabaseHandle[] = [];

interface SeededRun {
  runId: string;
}

/**
 * 创建一个开箱即用的仓储 + 播种一个可用的 task_run 行。
 * 借用现有 createProject/createTask/confirmTask/claimNextTask 完成播种，
 * 避免手写 raw SQL 与真实 schema 脱节。
 */
const createRepositoryWithRun = (): {
  repo: DevLoopRepository;
  handle: DatabaseHandle;
  seed: SeededRun;
} => {
  const handle = openDatabase({ filePath: ":memory:", migrationsFolder });
  handles.push(handle);
  const repo = new DevLoopRepository(handle);
  const project = repo.createProject({
    name: "scratchpad 测试项目",
    repositoryUrl: "git@example.com:team/scratchpad.git",
    repositoryPath: "/tmp/devloop-scratchpad-test",
    defaultBaseRef: "main",
    headCommit: "base-commit",
  }).value;
  const draft = repo.createTask({
    projectId: project.id,
    targetBranch: "feature/scratchpad",
    title: "触发一次 run 以便播种 scratchpad 外键",
    goal: "只为拿到一条 task_runs 行",
    acceptanceCriteria: ["无实际目标"],
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
  return { repo, handle, seed: { runId: claim.value.run.id } };
};

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
});

describe("ScratchpadRepository.saveScratchpad", () => {
  it("写入并返回可读的 key，且 loadScratchpad 能取回原文", () => {
    const { repo, seed } = createRepositoryWithRun();
    const { key } = repo.saveScratchpad({
      runId: seed.runId,
      contentType: "TOOL_RESULT_LARGE",
      contentText: "很长的原文",
      originalTokens: 1234,
      now: 1_700_000_000_000,
    });
    expect(key).toMatch(new RegExp(`^sp_${seed.runId}_1_[0-9a-f]{8}$`));

    const loaded = repo.loadScratchpad(key);
    expect(loaded).not.toBeNull();
    expect(loaded!.contentText).toBe("很长的原文");
    expect(loaded!.contentType).toBe("TOOL_RESULT_LARGE");
    expect(loaded!.originalTokens).toBe(1234);
    expect(loaded!.sizeBytes).toBe(Buffer.byteLength("很长的原文", "utf8"));
    expect(loaded!.createdAt).toBe(1_700_000_000_000);
  });

  it("同 run 多次写入时序号自增", () => {
    const { repo, seed } = createRepositoryWithRun();
    const first = repo.saveScratchpad({
      runId: seed.runId,
      contentType: "TOOL_CALL",
      contentText: "a",
      originalTokens: 1,
    });
    const second = repo.saveScratchpad({
      runId: seed.runId,
      contentType: "TOOL_CALL",
      contentText: "b",
      originalTokens: 1,
    });
    expect(first.key).toMatch(new RegExp(`^sp_${seed.runId}_1_`));
    expect(second.key).toMatch(new RegExp(`^sp_${seed.runId}_2_`));
  });
});

describe("ScratchpadRepository.purgeScratchpadByRun", () => {
  it("按 runId 清理该 run 名下的全部条目", () => {
    const { repo, handle, seed } = createRepositoryWithRun();
    repo.saveScratchpad({
      runId: seed.runId,
      contentType: "TOOL_CALL",
      contentText: "a",
      originalTokens: 1,
    });
    repo.saveScratchpad({
      runId: seed.runId,
      contentType: "TOOL_CALL",
      contentText: "b",
      originalTokens: 1,
    });
    repo.purgeScratchpadByRun(seed.runId);
    const rows = handle.sqlite
      .prepare("SELECT COUNT(*) as n FROM context_scratchpad WHERE run_id = ?")
      .get(seed.runId) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("task_runs 被删除时通过外键级联清理 scratchpad", () => {
    const { repo, handle, seed } = createRepositoryWithRun();
    repo.saveScratchpad({
      runId: seed.runId,
      contentType: "TOOL_CALL",
      contentText: "a",
      originalTokens: 1,
    });
    handle.sqlite.prepare("DELETE FROM task_runs WHERE id = ?").run(seed.runId);
    const rows = handle.sqlite
      .prepare("SELECT COUNT(*) as n FROM context_scratchpad WHERE run_id = ?")
      .get(seed.runId) as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("ScratchpadRepository.purgeScratchpadOlderThan", () => {
  it("按创建时间清理并返回受影响条数", () => {
    const { repo, seed } = createRepositoryWithRun();
    const now = 1_700_000_000_000;
    repo.saveScratchpad({
      runId: seed.runId,
      contentType: "TOOL_CALL",
      contentText: "old",
      originalTokens: 1,
      now: now - 10_000,
    });
    repo.saveScratchpad({
      runId: seed.runId,
      contentType: "TOOL_CALL",
      contentText: "new",
      originalTokens: 1,
      now,
    });
    const affected = repo.purgeScratchpadOlderThan(5_000, now);
    expect(affected).toBe(1);
  });
});

describe("ScratchpadRepository 单条 1 MB 上限", () => {
  it("拒绝 > 1 MB 的 content", () => {
    const { repo, seed } = createRepositoryWithRun();
    const huge = "x".repeat(1_048_577);
    expect(() =>
      repo.saveScratchpad({
        runId: seed.runId,
        contentType: "TOOL_CALL",
        contentText: huge,
        originalTokens: 1,
      }),
    ).toThrow(/1 MB/);
  });
});
