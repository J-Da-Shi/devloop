import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPreviewEnvironment,
  detectPreviewConfig,
  findPreviewDependencyInstallation,
  PreviewService,
} from "./preview-service.js";

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

  it("从预览工作目录向上识别最近的依赖锁文件", async () => {
    const root = join(tmpdir(), `devloop-preview-dependencies-${crypto.randomUUID()}`);
    roots.push(root);
    const webDirectory = join(root, "apps", "web");
    await mkdir(webDirectory, { recursive: true });
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(webDirectory, "package-lock.json"), "{}\n");

    await expect(findPreviewDependencyInstallation(root, webDirectory)).resolves.toEqual({
      command: "npm ci",
      workingDirectory: webDirectory,
      lockfile: "package-lock.json",
    });
  });

  it("自动识别嵌套 Vite Web 项目的启动配置", async () => {
    const root = join(tmpdir(), `devloop-preview-detection-${crypto.randomUUID()}`);
    roots.push(root);
    const webDirectory = join(root, "apps", "web");
    await mkdir(webDirectory, { recursive: true });
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "workspace-root",
        scripts: { dev: "concurrently 'pnpm --filter web dev' 'pnpm --filter server dev'" },
      }),
    );
    await writeFile(
      join(webDirectory, "package.json"),
      JSON.stringify({
        name: "web",
        scripts: { dev: "vite" },
        devDependencies: { vite: "latest" },
      }),
    );

    await expect(detectPreviewConfig(root)).resolves.toEqual({
      source: "detected",
      command: "pnpm run dev -- --host 127.0.0.1 --port {{port}}",
      workingDirectory: "apps/web",
      healthPath: "/",
    });
  });

  it("不会仅因安装前端依赖而猜测非 Web 启动脚本", async () => {
    const root = join(tmpdir(), `devloop-preview-ambiguous-${crypto.randomUUID()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "ambiguous-project",
        scripts: { dev: "tsx src/server.ts" },
        devDependencies: { vite: "latest" },
      }),
    );

    await expect(detectPreviewConfig(root)).resolves.toBeNull();
  });

  it("启动预览前会在隔离 Worktree 中安装锁定依赖", async () => {
    const root = join(tmpdir(), `devloop-preview-install-${crypto.randomUUID()}`);
    roots.push(root);
    const previewsRoot = join(root, "previews");
    const removed: string[] = [];
    const installMarker = ".preview-dependencies-installed";
    const installScript = `require('node:fs').writeFileSync(${JSON.stringify(
      installMarker,
    )}, 'installed')`;
    const gitService = {
      createDetachedWorktree: async (input: { worktreePath: string }) => {
        await mkdir(input.worktreePath, { recursive: true });
        await writeFile(
          join(input.worktreePath, "package.json"),
          JSON.stringify({
            name: "preview-install-fixture",
            version: "1.0.0",
            private: true,
            scripts: {
              preinstall: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(installScript)}`,
            },
          }),
        );
        await writeFile(
          join(input.worktreePath, "package-lock.json"),
          JSON.stringify({
            name: "preview-install-fixture",
            version: "1.0.0",
            lockfileVersion: 3,
            requires: true,
            packages: { "": { name: "preview-install-fixture", version: "1.0.0" } },
          }),
        );
      },
      removeManagedWorktree: async (input: { worktreePath: string }) => {
        removed.push(input.worktreePath);
        await rm(input.worktreePath, { recursive: true, force: true });
      },
    };
    const service = new PreviewService(gitService as never, previewsRoot, 10_000, 10_000);
    const script = [
      "const http = require('node:http')",
      "const server = http.createServer((_request, response) => response.end('ready'))",
      "server.listen(Number(process.env.PORT), '127.0.0.1')",
    ].join(";");

    const preview = await service.start({
      runId: crypto.randomUUID(),
      repositoryPath: root,
      resultCommit: "result-commit",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      workingDirectory: ".",
      healthPath: "/",
    });

    try {
      await expect(readFile(join(preview.workingDirectory, installMarker), "utf8")).resolves.toBe(
        "installed",
      );
    } finally {
      await service.stop(preview.id);
    }
    expect(removed).toHaveLength(1);
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
