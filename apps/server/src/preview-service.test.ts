import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPreviewEnvironment, PreviewService } from "./preview-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PreviewService", () => {
  it("预览进程环境不会继承服务端密钥", () => {
    const previousSecret = process.env.OPENAI_API_KEY;
    const previousPublic = process.env.VITE_PUBLIC_NAME;
    process.env.OPENAI_API_KEY = "secret";
    process.env.VITE_PUBLIC_NAME = "visible";
    try {
      const environment = buildPreviewEnvironment({ PORT: "4318" });
      expect(environment.OPENAI_API_KEY).toBeUndefined();
      expect(environment.VITE_PUBLIC_NAME).toBe("visible");
      expect(environment.PORT).toBe("4318");
    } finally {
      if (previousSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousSecret;
      if (previousPublic === undefined) delete process.env.VITE_PUBLIC_NAME;
      else process.env.VITE_PUBLIC_NAME = previousPublic;
    }
  });

  it("同一 Run 并发启动只创建一个预览，并在停止后清理 Worktree", async () => {
    const root = join(tmpdir(), `devloop-preview-${crypto.randomUUID()}`);
    roots.push(root);
    const previewsRoot = join(root, "previews");
    const created: string[] = [];
    const removed: string[] = [];
    const gitService = {
      createDetachedWorktree: async (input: { worktreePath: string }) => {
        created.push(input.worktreePath);
        await mkdir(input.worktreePath, { recursive: true });
      },
      removeManagedWorktree: async (input: { worktreePath: string }) => {
        removed.push(input.worktreePath);
        await rm(input.worktreePath, { recursive: true, force: true });
      },
    };
    const service = new PreviewService(gitService as never, previewsRoot, 10_000);
    const script = [
      "const http = require('node:http')",
      "const server = http.createServer((_request, response) => response.end('ready'))",
      "server.listen(Number(process.env.PORT), '127.0.0.1')",
    ].join(";");
    const input = {
      runId: crypto.randomUUID(),
      repositoryPath: root,
      resultCommit: "result-commit",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      workingDirectory: ".",
      healthPath: "/",
    };

    const [first, second] = await Promise.all([service.start(input), service.start(input)]);
    expect(first.id).toBe(second.id);
    expect(created).toHaveLength(1);
    await expect(fetch(first.url)).resolves.toMatchObject({ status: 200 });

    await expect(service.stop(first.id)).resolves.toBe(true);
    expect(removed).toEqual(created);
    expect(service.get(first.id)).toBeNull();
    await service.close();
  });

  it("拒绝超出隔离 Worktree 的工作目录并执行清理", async () => {
    const root = join(tmpdir(), `devloop-preview-path-${crypto.randomUUID()}`);
    roots.push(root);
    const removed: string[] = [];
    const gitService = {
      createDetachedWorktree: async (input: { worktreePath: string }) => {
        await mkdir(input.worktreePath, { recursive: true });
      },
      removeManagedWorktree: async (input: { worktreePath: string }) => {
        removed.push(input.worktreePath);
        await rm(input.worktreePath, { recursive: true, force: true });
      },
    };
    const service = new PreviewService(gitService as never, join(root, "previews"), 1_000);

    await expect(
      service.start({
        runId: crypto.randomUUID(),
        repositoryPath: root,
        resultCommit: "result-commit",
        command: "unused",
        workingDirectory: "../outside",
        healthPath: "/",
      }),
    ).rejects.toThrow("不能超出任务结果 Worktree");
    expect(removed).toHaveLength(1);
  });
});
