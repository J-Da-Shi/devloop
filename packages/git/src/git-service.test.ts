import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

  it("三方应用发生冲突时不修改当前项目", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-git-apply-conflict-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const worktreePath = join(root, "worktrees", "run-1");
    await execa("git", ["init", "--initial-branch=main", repositoryPath]);
    await writeFile(join(repositoryPath, "README.md"), "计数=1\n");
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
      branchName: "devloop/run/conflict-test",
      baseCommit: baseCommit.trim(),
    });
    await writeFile(join(worktreePath, "README.md"), "计数=100\n");
    const resultCommit = await service.commitWorktree({
      worktreePath,
      message: "DevLoop: 冲突测试",
    });

    await writeFile(join(repositoryPath, "README.md"), "计数=200\n");
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
      "主项目修改同一行",
    ]);
    const { stdout: previousCommit } = await execa("git", [
      "-C",
      repositoryPath,
      "rev-parse",
      "HEAD",
    ]);

    await expect(
      service.applyCommitToWorkingTree({
        repositoryPath,
        targetBranch: "main",
        baseCommit: baseCommit.trim(),
        resultCommit,
      }),
    ).rejects.toMatchObject({ code: "APPLY_CONFLICT" });
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("计数=200\n");
    await expect(execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).resolves.toMatchObject({
      stdout: previousCommit.trim(),
    });
    await expect(
      execa("git", ["-C", repositoryPath, "status", "--porcelain"]),
    ).resolves.toMatchObject({ stdout: "" });
  });
});

describe("GitService 远程仓库", () => {
  it("规范化 SSH 仓库地址并拒绝非 SSH 地址", () => {
    const service = new GitService();

    expect(service.normalizeRepositoryUrl(" git@GitHub.COM:team/project.git/ ")).toBe(
      "git@github.com:team/project.git",
    );
    expect(service.normalizeRepositoryUrl("ssh://git@GitHub.COM/team/project.git/")).toBe(
      "ssh://git@github.com/team/project.git",
    );
    expect(() => service.normalizeRepositoryUrl("https://github.com/team/project.git")).toThrow(
      "首版仅支持 SSH Git 地址",
    );
  });

  it("把结果推送到新远程分支，并把重复推送识别为已完成", async () => {
    const { root, remotePath, managedPath, baseCommit } = await createRemoteFixture(
      "devloop-git-remote-create-",
    );
    const worktreePath = join(root, "worktrees", "run-create");
    const service = new GitService();
    const base = await service.resolveRemoteTargetBase({
      repositoryPath: managedPath,
      targetBranch: "feature/devloop-result",
      fallbackRef: "main",
    });
    expect(base).toEqual({
      targetBranch: "feature/devloop-result",
      baseCommit,
      branchExists: false,
    });

    await service.createWorktree({
      repositoryPath: managedPath,
      worktreePath,
      branchName: "devloop/run/remote-create",
      baseCommit,
    });
    await writeFile(join(worktreePath, "RESULT.md"), "DevLoop 远程执行结果\n");
    const resultCommit = await service.commitWorktree({
      worktreePath,
      message: "DevLoop: 推送新远程分支",
    });

    await expect(
      service.pushResult({
        repositoryPath: managedPath,
        targetBranch: "feature/devloop-result",
        baseCommit,
        resultCommit,
      }),
    ).resolves.toEqual({
      status: "pushed",
      branch: "feature/devloop-result",
      previousCommit: null,
      currentCommit: resultCommit,
      branchCreated: true,
    });
    await expect(
      execa("git", ["--git-dir", remotePath, "rev-parse", "refs/heads/feature/devloop-result"]),
    ).resolves.toMatchObject({ stdout: resultCommit });

    await expect(
      service.pushResult({
        repositoryPath: managedPath,
        targetBranch: "feature/devloop-result",
        baseCommit,
        resultCommit,
      }),
    ).resolves.toEqual({
      status: "already_pushed",
      branch: "feature/devloop-result",
      previousCommit: resultCommit,
      currentCommit: resultCommit,
      branchCreated: false,
    });

    const peerPath = join(root, "peer-after-result");
    await execa("git", ["clone", remotePath, peerPath]);
    await execa("git", ["-C", peerPath, "checkout", "feature/devloop-result"]);
    await writeFile(join(peerPath, "FOLLOW_UP.md"), "结果推送后的远端提交\n");
    const laterCommit = await commitAll(peerPath, "结果后的远端提交");
    await execa("git", ["-C", peerPath, "push", "origin", "feature/devloop-result"]);

    await expect(
      service.pushResult({
        repositoryPath: managedPath,
        targetBranch: "feature/devloop-result",
        baseCommit,
        resultCommit,
      }),
    ).resolves.toEqual({
      status: "already_pushed",
      branch: "feature/devloop-result",
      previousCommit: laterCommit,
      currentCommit: laterCommit,
      branchCreated: false,
    });
  });

  it("远程目标分支已前进时拒绝强制覆盖", async () => {
    const { root, remotePath, managedPath, baseCommit } = await createRemoteFixture(
      "devloop-git-remote-drift-",
    );
    const worktreePath = join(root, "worktrees", "run-drift");
    const peerPath = join(root, "peer");
    const service = new GitService();
    await service.createWorktree({
      repositoryPath: managedPath,
      worktreePath,
      branchName: "devloop/run/remote-drift",
      baseCommit,
    });
    await writeFile(join(worktreePath, "RESULT.md"), "等待推送的结果\n");
    const resultCommit = await service.commitWorktree({
      worktreePath,
      message: "DevLoop: 生成待推送结果",
    });

    await execa("git", ["clone", remotePath, peerPath]);
    await writeFile(join(peerPath, "PEER.md"), "远端新增提交\n");
    const peerCommit = await commitAll(peerPath, "远端分支继续开发");
    await execa("git", ["-C", peerPath, "push", "origin", "main"]);

    await expect(
      service.pushResult({
        repositoryPath: managedPath,
        targetBranch: "main",
        baseCommit,
        resultCommit,
      }),
    ).rejects.toMatchObject({ code: "REMOTE_PUSH_REJECTED" });
    await expect(
      execa("git", ["--git-dir", remotePath, "rev-parse", "refs/heads/main"]),
    ).resolves.toMatchObject({ stdout: peerCommit });
  });
});
