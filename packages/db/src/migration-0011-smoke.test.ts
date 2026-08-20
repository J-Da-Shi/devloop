import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./client.js";

const migrationsFolder = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "drizzle");

describe("迁移 0011 冒烟", () => {
  it("在空库上跑完全部迁移后能建出 context_scratchpad 表与索引", () => {
    const dir = mkdtempSync(join(tmpdir(), "devloop-db-0011-"));
    let handle: ReturnType<typeof openDatabase> | null = null;
    try {
      handle = openDatabase({
        filePath: join(dir, "test.db"),
        migrationsFolder,
      });
      const tables = handle.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='context_scratchpad'",
        )
        .all();
      expect(tables).toHaveLength(1);

      const indexes = handle.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_context_scratchpad_run'",
        )
        .all();
      expect(indexes).toHaveLength(1);
    } finally {
      handle?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
