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

  it("远程目标分支已前进时拒绝旧结果，并允许无冲突对齐后推送", async () => {
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

    let resolverCalled = false;
    const reconciled = await service.reconcileCommitConflicts(
      {
        repositoryPath: managedPath,
        targetBranch: "main",
        targetCommit: peerCommit,
        baseCommit,
        resultCommit,
      },
      async () => {
        resolverCalled = true;
      },
    );

    expect(resolverCalled).toBe(false);
    expect(reconciled).toMatchObject({
      status: "clean",
      targetCommit: peerCommit,
      resolutions: [],
    });
    expect(reconciled.resultCommit).not.toBe(resultCommit);
    await expect(
      execa("git", ["-C", managedPath, "rev-parse", `${reconciled.resultCommit}^`]),
    ).resolves.toMatchObject({ stdout: peerCommit });
    await expect(
      service.pushResult({
        repositoryPath: managedPath,
        targetBranch: "main",
        baseCommit: peerCommit,
        resultCommit: reconciled.resultCommit,
      }),
    ).resolves.toMatchObject({
      status: "pushed",
      previousCommit: peerCommit,
      currentCommit: reconciled.resultCommit,
    });
    await expect(
      execa("git", ["--git-dir", remotePath, "rev-parse", "refs/heads/main"]),
    ).resolves.toMatchObject({ stdout: reconciled.resultCommit });
  });
});
