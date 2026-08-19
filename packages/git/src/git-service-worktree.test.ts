import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "./git-service.js";

const temporaryDirectories: string[] = [];

const commitAll = async (repositoryPath: string, message: string): Promise<string> => {
  await execa("git", ["-C", repositoryPath, "add", "--all"]);
  await execa("git", [
    "-c",
    "user.name=DevLoop Test",
    "-c",
    "user.email=devloop-test@local",
    "-c",
    "commit.gpgSign=false",
    "-C",
    repositoryPath,
    "commit",
    "-m",
    message,
  ]);
  const { stdout } = await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
  return stdout.trim();
};

const createRemoteFixture = async (prefix: string) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const remotePath = join(root, "remote.git");
  const seedPath = join(root, "seed");
  const managedPath = join(root, "managed");
  await execa("git", ["init", "--bare", remotePath]);
  await execa("git", ["init", "--initial-branch=main", seedPath]);
  await writeFile(join(seedPath, "README.md"), "远程仓库初始内容\n");
  const baseCommit = await commitAll(seedPath, "初始化远程仓库");
  await execa("git", ["-C", seedPath, "remote", "add", "origin", remotePath]);
  await execa("git", ["-C", seedPath, "push", "-u", "origin", "main"]);
  await execa("git", ["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await execa("git", ["clone", "--no-checkout", "--origin", "origin", remotePath, managedPath]);
  return { root, remotePath, seedPath, managedPath, baseCommit };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("GitService Worktree", () => {
  it("AbortSignal 会终止 Git 进程组并返回 AbortError", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-git-cancel-"));
    temporaryDirectories.push(root);
    const executablePath = join(root, "hanging-git.mjs");
    await writeFile(
      executablePath,
      `#!/usr/bin/env node
setInterval(() => undefined, 1000);
await new Promise(() => undefined);
`,
    );
    await chmod(executablePath, 0o755);
    const controller = new AbortController();
    const processGroupIds: Array<number | null> = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const service = new GitService(executablePath);

    const fetching = service.fetchRepository(root, {
      signal: controller.signal,
      onProcessGroupId: (processGroupId) => {
        processGroupIds.push(processGroupId);
        if (processGroupId !== null) markStarted();
      },
    });
    await started;
    expect(processGroupIds[0]).toEqual(expect.any(Number));

    controller.abort();

    await expect(fetching).rejects.toMatchObject({ name: "AbortError" });
    expect(processGroupIds.at(-1)).toBeNull();
  });

  it("只接受处于分支上的 Git 仓库根目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-git-inspect-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const nestedPath = join(repositoryPath, "nested");
    await execa("git", ["init", "--initial-branch=main", repositoryPath]);
    await mkdir(nestedPath);
    await writeFile(join(repositoryPath, "README.md"), "本地项目\n");
    const headCommit = await commitAll(repositoryPath, "初始化本地项目");
    const service = new GitService();

    await expect(service.inspectRepository(repositoryPath)).resolves.toEqual({
      path: await realpath(repositoryPath),
      branch: "main",
      headCommit,
    });
    await expect(service.inspectRepository(nestedPath)).rejects.toMatchObject({
      code: "REPOSITORY_NOT_ROOT",
    });

    await execa("git", ["-C", repositoryPath, "checkout", "--detach", headCommit]);
    await expect(service.inspectRepository(repositoryPath)).rejects.toMatchObject({
      code: "DETACHED_HEAD",
    });
  });

  it("解析目标分支时兼容 HEAD 并拒绝完整引用名", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-git-resolve-target-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    await execa("git", ["init", "--initial-branch=main", repositoryPath]);
    await writeFile(join(repositoryPath, "README.md"), "初始内容\n");
    await execa("git", ["-C", repositoryPath, "add", "README.md"]);
    await execa("git", [
      "-c",
      "user.name=DevLoop Test",
      "-c",
      "user.email=devloop-test@local",
      "-C",
      repositoryPath,
      "commit",
      "-m",
      "初始提交",
    ]);
    const { stdout: headCommit } = await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
    const service = new GitService();

    await expect(
      service.resolveTargetBase({
        repositoryPath,
        targetBranch: "HEAD",
        fallbackRef: "HEAD",
      }),
    ).resolves.toEqual({
      targetBranch: "main",
      baseCommit: headCommit.trim(),
      branchExists: true,
    });
    await expect(
      service.resolveTargetBase({
        repositoryPath,
        targetBranch: "refs/heads/main",
        fallbackRef: "main",
      }),
    ).rejects.toMatchObject({ code: "INVALID_BRANCH" });
  });

  it("目标分支不存在时从运行基线自动创建并写入结果", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-git-create-target-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const worktreePath = join(root, "worktrees", "run-1");
    await execa("git", ["init", "--initial-branch=main", repositoryPath]);
    await writeFile(join(repositoryPath, "README.md"), "初始内容\n");
    await execa("git", ["-C", repositoryPath, "add", "README.md"]);
    await execa("git", [
      "-c",
      "user.name=DevLoop Test",
      "-c",
      "user.email=devloop-test@local",
      "-C",
      repositoryPath,
      "commit",
      "-m",
      "初始提交",
    ]);
    const { stdout: baseCommit } = await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
    const service = new GitService();
    await service.createWorktree({
      repositoryPath,
      worktreePath,
      branchName: "devloop/run/create-target",
      baseCommit: baseCommit.trim(),
    });
    await writeFile(join(worktreePath, "README.md"), "目标分支内容\n");
    const resultCommit = await service.commitWorktree({
      worktreePath,
      message: "DevLoop: 创建目标分支",
    });

    const resolved = await service.resolveTargetBase({
      repositoryPath,
      targetBranch: "feature/new-target",
      fallbackRef: "main",
    });
    expect(resolved).toEqual({
      targetBranch: "feature/new-target",
      baseCommit: baseCommit.trim(),
      branchExists: false,
    });

    const application = await service.applyCommitToWorkingTree({
      repositoryPath,
      targetBranch: "feature/new-target",
      baseCommit: resolved.baseCommit,
      resultCommit,
    });

    expect(application).toEqual({
      status: "applied",
      branch: "feature/new-target",
      previousCommit: baseCommit.trim(),
      currentCommit: resultCommit,
      branchCreated: true,
      workingTreeUpdated: false,
    });
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("初始内容\n");
    await expect(
      execa("git", ["-C", repositoryPath, "show", "feature/new-target:README.md"]),
    ).resolves.toMatchObject({ stdout: "目标分支内容" });
  });

  it("已有目标分支未检出时只更新分支引用", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-git-update-target-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const worktreePath = join(root, "worktrees", "run-1");
    await execa("git", ["init", "--initial-branch=main", repositoryPath]);
    await writeFile(join(repositoryPath, "README.md"), "初始内容\n");
    await execa("git", ["-C", repositoryPath, "add", "README.md"]);
    await execa("git", [
      "-c",
      "user.name=DevLoop Test",
      "-c",
      "user.email=devloop-test@local",
      "-C",
      repositoryPath,
      "commit",
      "-m",
      "初始提交",
    ]);
    const { stdout: baseCommit } = await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
    await execa("git", ["-C", repositoryPath, "branch", "feature/existing", baseCommit.trim()]);
    const service = new GitService();
    await service.createWorktree({
      repositoryPath,
      worktreePath,
      branchName: "devloop/run/update-target",
      baseCommit: baseCommit.trim(),
    });
    await writeFile(join(worktreePath, "README.md"), "已有目标分支的新内容\n");
    const resultCommit = await service.commitWorktree({
      worktreePath,
      message: "DevLoop: 更新已有目标分支",
    });

    const application = await service.applyCommitToWorkingTree({
      repositoryPath,
      targetBranch: "feature/existing",
      baseCommit: baseCommit.trim(),
      resultCommit,
    });

    expect(application).toMatchObject({
      status: "applied",
      branch: "feature/existing",
      branchCreated: false,
      workingTreeUpdated: false,
      currentCommit: resultCommit,
    });
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("初始内容\n");
    await expect(
      execa("git", ["-C", repositoryPath, "show", "feature/existing:README.md"]),
    ).resolves.toMatchObject({ stdout: "已有目标分支的新内容" });
  });

  it("创建独立工作树并提交 Codex 产生的修改", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-git-service-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const worktreePath = join(root, "worktrees", "run-1");
    await execa("git", ["init", "--initial-branch=main", repositoryPath]);
    await writeFile(join(repositoryPath, "README.md"), "初始内容\n");
    await execa("git", ["-C", repositoryPath, "add", "README.md"]);
    await execa("git", [
      "-c",
      "user.name=DevLoop Test",
      "-c",
      "user.email=devloop-test@local",
      "-C",
      repositoryPath,
      "commit",
      "-m",
      "初始提交",
    ]);
    const { stdout: baseCommit } = await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
    const service = new GitService();

    await service.createWorktree({
      repositoryPath,
      worktreePath,
      branchName: "devloop/run/test",
      baseCommit: baseCommit.trim(),
    });
    await writeFile(join(worktreePath, "README.md"), "Codex 修改后的内容\n");
    const resultCommit = await service.commitWorktree({
      worktreePath,
      message: "DevLoop: 测试任务",
    });

    expect(resultCommit).not.toBe(baseCommit.trim());
    expect(await readFile(join(worktreePath, "README.md"), "utf8")).toBe("Codex 修改后的内容\n");
    const { stdout: committedContent } = await execa("git", [
      "-C",
      repositoryPath,
      "show",
      `${resultCommit}:README.md`,
    ]);
    expect(committedContent).toBe("Codex 修改后的内容");

    const application = await service.applyCommitToWorkingTree({
      repositoryPath,
      targetBranch: "main",
      baseCommit: baseCommit.trim(),
      resultCommit,
    });
    expect(application).toMatchObject({
      status: "applied",
      branch: "main",
      previousCommit: baseCommit.trim(),
      currentCommit: resultCommit,
    });
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("Codex 修改后的内容\n");
    await expect(
      service.applyCommitToWorkingTree({
        repositoryPath,
        targetBranch: "main",
        baseCommit: baseCommit.trim(),
        resultCommit,
      }),
    ).resolves.toMatchObject({ status: "already_applied", currentCommit: resultCommit });
  });

  it("当前项目存在未提交内容时拒绝覆盖", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-git-apply-dirty-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const worktreePath = join(root, "worktrees", "run-1");
    await execa("git", ["init", "--initial-branch=main", repositoryPath]);
    await writeFile(join(repositoryPath, "README.md"), "初始内容\n");
    await execa("git", ["-C", repositoryPath, "add", "README.md"]);
    await execa("git", [
      "-c",
      "user.name=DevLoop Test",
      "-c",
      "user.email=devloop-test@local",
      "-C",
      repositoryPath,
      "commit",
      "-m",
      "初始提交",
    ]);
    const { stdout: baseCommit } = await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
    const service = new GitService();
    await service.createWorktree({
      repositoryPath,
      worktreePath,
      branchName: "devloop/run/dirty-test",
      baseCommit: baseCommit.trim(),
    });
    await writeFile(join(worktreePath, "README.md"), "Codex 修改后的内容\n");
    const resultCommit = await service.commitWorktree({
      worktreePath,
      message: "DevLoop: 脏工作区测试",
    });
    await writeFile(join(repositoryPath, "README.md"), "本地未提交内容\n");

    await expect(
      service.applyCommitToWorkingTree({
        repositoryPath,
        targetBranch: "main",
        baseCommit: baseCommit.trim(),
        resultCommit,
      }),
    ).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("本地未提交内容\n");
  });

  it("当前分支已经前进时只写回本次结果涉及的文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-git-apply-diverged-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const worktreePath = join(root, "worktrees", "run-1");
    await execa("git", ["init", "--initial-branch=main", repositoryPath]);
    await writeFile(join(repositoryPath, "README.md"), "初始内容\n");
    await execa("git", ["-C", repositoryPath, "add", "README.md"]);
    await execa("git", [
      "-c",
      "user.name=DevLoop Test",
      "-c",
      "user.email=devloop-test@local",
      "-C",
      repositoryPath,
      "commit",
      "-m",
      "初始提交",
    ]);
    const { stdout: baseCommit } = await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
    const service = new GitService();
    await service.createWorktree({
      repositoryPath,
      worktreePath,
      branchName: "devloop/run/diverged-test",
      baseCommit: baseCommit.trim(),
    });
    await writeFile(join(worktreePath, "README.md"), "Codex 修改后的内容\n");
    await writeFile(join(worktreePath, "AGENT.txt"), "Agent 新文件\n");
    const resultCommit = await service.commitWorktree({
      worktreePath,
      message: "DevLoop: 分叉写回测试",
    });

    await writeFile(join(repositoryPath, "LOCAL.txt"), "主项目后续内容\n");
    await execa("git", ["-C", repositoryPath, "add", "LOCAL.txt"]);
    await execa("git", [
      "-c",
      "user.name=DevLoop Test",
      "-c",
      "user.email=devloop-test@local",
      "-C",
      repositoryPath,
      "commit",
      "-m",
      "主项目继续开发",
    ]);
    const { stdout: previousCommit } = await execa("git", [
      "-C",
      repositoryPath,
      "rev-parse",
      "HEAD",
    ]);

    const application = await service.applyCommitToWorkingTree({
      repositoryPath,
      targetBranch: "main",
      baseCommit: baseCommit.trim(),
      resultCommit,
    });

    expect(application).toMatchObject({
      status: "applied",
      branch: "main",
      previousCommit: previousCommit.trim(),
    });
    expect(application.currentCommit).not.toBe(previousCommit.trim());
    expect(application.currentCommit).not.toBe(resultCommit);
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("Codex 修改后的内容\n");
    expect(await readFile(join(repositoryPath, "AGENT.txt"), "utf8")).toBe("Agent 新文件\n");
    expect(await readFile(join(repositoryPath, "LOCAL.txt"), "utf8")).toBe("主项目后续内容\n");
    await expect(
      service.applyCommitToWorkingTree({
        repositoryPath,
        targetBranch: "main",
        baseCommit: baseCommit.trim(),
        resultCommit,
      }),
    ).resolves.toMatchObject({
      status: "already_applied",
      currentCommit: application.currentCommit,
    });
  });

  it("当前分支修改了同一文件的其他区域时保留双方改动", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-git-apply-merge-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const worktreePath = join(root, "worktrees", "run-1");
    await execa("git", ["init", "--initial-branch=main", repositoryPath]);
    await writeFile(join(repositoryPath, "settings.txt"), "标题=初始\n\n计数=1\n");
    await execa("git", ["-C", repositoryPath, "add", "settings.txt"]);
    await execa("git", [
      "-c",
      "user.name=DevLoop Test",
      "-c",
      "user.email=devloop-test@local",
      "-C",
      repositoryPath,
      "commit",
      "-m",
      "初始提交",
    ]);
    const { stdout: baseCommit } = await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
    const service = new GitService();
    await service.createWorktree({
      repositoryPath,
      worktreePath,
      branchName: "devloop/run/merge-test",
      baseCommit: baseCommit.trim(),
    });
    await writeFile(join(worktreePath, "settings.txt"), "标题=初始\n\n计数=100\n");
    const resultCommit = await service.commitWorktree({
      worktreePath,
      message: "DevLoop: 同文件合并测试",
    });

    await writeFile(join(repositoryPath, "settings.txt"), "标题=主项目新版\n\n计数=1\n");
    await execa("git", ["-C", repositoryPath, "add", "settings.txt"]);
    await execa("git", [
      "-c",
      "user.name=DevLoop Test",
      "-c",
      "user.email=devloop-test@local",
      "-C",
      repositoryPath,
      "commit",
      "-m",
      "更新标题",
    ]);

    await expect(
      service.previewCommitConflicts({
        repositoryPath,
        targetBranch: "main",
        baseCommit: baseCommit.trim(),
        resultCommit,
      }),
    ).resolves.toMatchObject({
      status: "clean",
      targetBranch: "main",
      files: [],
    });

    await service.applyCommitToWorkingTree({
      repositoryPath,
      targetBranch: "main",
      baseCommit: baseCommit.trim(),
      resultCommit,
    });

    expect(await readFile(join(repositoryPath, "settings.txt"), "utf8")).toBe(
      "标题=主项目新版\n\n计数=100\n",
    );
  });
});
