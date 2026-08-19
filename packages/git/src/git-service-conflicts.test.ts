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

  const preview = await service.previewCommitConflicts({
    repositoryPath,
    targetBranch: "main",
    baseCommit: baseCommit.trim(),
    resultCommit,
  });
  expect(preview).toMatchObject({
    status: "conflicted",
    targetBranch: "main",
    targetCommit: previousCommit.trim(),
    message: "本次结果与目标分支 main 存在 1 个冲突文件。",
  });
  expect(preview.files).toHaveLength(1);
  expect(preview.files[0]).toMatchObject({
    path: "README.md",
    isBinary: false,
    targetExists: true,
    resultExists: true,
  });
  expect(preview.files[0]?.patch).toContain("<<<<<<<");
  expect(preview.files[0]?.patch).toContain("=======");
  expect(preview.files[0]?.patch).toContain(">>>>>>>");
  expect(preview.files[0]?.content).toContain("<<<<<<<");
  expect(preview.files[0]?.content).toContain("计数=200");
  expect(preview.files[0]?.content).toContain("计数=100");
  expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("计数=200\n");
  await expect(
    execa("git", ["-C", repositoryPath, "status", "--porcelain"]),
  ).resolves.toMatchObject({ stdout: "" });

  await expect(
    service.generateConflictResolutions(
      {
        repositoryPath,
        targetBranch: "main",
        baseCommit: baseCommit.trim(),
        resultCommit,
        expectedTargetCommit: previousCommit.trim(),
      },
      async () => undefined,
    ),
  ).rejects.toMatchObject({ code: "APPLY_CONFLICT" });

  const agentResolution = await service.generateConflictResolutions(
    {
      repositoryPath,
      targetBranch: "main",
      baseCommit: baseCommit.trim(),
      resultCommit,
      expectedTargetCommit: previousCommit.trim(),
    },
    async ({ worktreePath: conflictWorktree, files }) => {
      expect(files.map((file) => file.path)).toEqual(["README.md"]);
      await writeFile(join(conflictWorktree, "README.md"), "计数=300\n");
    },
  );
  expect(agentResolution).toEqual({
    targetCommit: previousCommit.trim(),
    resolutions: [{ path: "README.md", strategy: "content", content: "计数=300\n" }],
  });
  expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("计数=200\n");

  const reconciled = await service.reconcileCommitConflicts(
    {
      repositoryPath,
      targetBranch: "main",
      targetCommit: previousCommit.trim(),
      baseCommit: baseCommit.trim(),
      resultCommit,
    },
    async ({ worktreePath: conflictWorktree }) => {
      await writeFile(join(conflictWorktree, "README.md"), "计数=350\n");
    },
  );
  expect(reconciled).toMatchObject({
    status: "resolved",
    targetCommit: previousCommit.trim(),
    resolutions: [{ path: "README.md", strategy: "content", content: "计数=350\n" }],
  });
  await expect(
    execa("git", ["-C", repositoryPath, "show", `${reconciled.resultCommit}:README.md`]),
  ).resolves.toMatchObject({ stdout: "计数=350" });
  await expect(
    execa("git", ["-C", repositoryPath, "rev-parse", `${reconciled.resultCommit}^`]),
  ).resolves.toMatchObject({ stdout: previousCommit.trim() });
  await service.moveWorktreeToCommit({
    worktreePath,
    expectedCommit: resultCommit,
    targetCommit: reconciled.resultCommit,
  });
  await expect(execa("git", ["-C", worktreePath, "rev-parse", "HEAD"])).resolves.toMatchObject({
    stdout: reconciled.resultCommit,
  });

  await execa("git", ["-C", repositoryPath, "branch", "target-resolution", previousCommit.trim()]);
  const targetResolution = await service.applyCommitToWorkingTree({
    repositoryPath,
    targetBranch: "target-resolution",
    baseCommit: baseCommit.trim(),
    resultCommit,
    expectedTargetCommit: previousCommit.trim(),
    conflictResolutions: [{ path: "README.md", strategy: "target" }],
  });
  expect(targetResolution).toMatchObject({
    status: "applied",
    branch: "target-resolution",
    previousCommit: previousCommit.trim(),
    workingTreeUpdated: false,
  });
  expect(targetResolution.currentCommit).not.toBe(previousCommit.trim());
  await expect(
    execa("git", ["-C", repositoryPath, "show", "target-resolution:README.md"]),
  ).resolves.toMatchObject({ stdout: "计数=200" });

  await expect(
    service.applyCommitToWorkingTree({
      repositoryPath,
      targetBranch: "main",
      baseCommit: baseCommit.trim(),
      resultCommit,
    }),
  ).rejects.toMatchObject({ code: "APPLY_CONFLICT" });
  await expect(
    service.applyCommitToWorkingTree({
      repositoryPath,
      targetBranch: "main",
      baseCommit: baseCommit.trim(),
      resultCommit,
      expectedTargetCommit: previousCommit.trim(),
      conflictResolutions: [
        {
          path: "README.md",
          strategy: "content",
          content: preview.files[0]?.content ?? "",
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "APPLY_CONFLICT" });
  await expect(
    service.applyCommitToWorkingTree({
      repositoryPath,
      targetBranch: "main",
      baseCommit: baseCommit.trim(),
      resultCommit,
      expectedTargetCommit: "0".repeat(40),
      conflictResolutions: [{ path: "README.md", strategy: "content", content: "计数=300\n" }],
    }),
  ).rejects.toMatchObject({ code: "TARGET_BRANCH_CHANGED" });
  expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("计数=200\n");
  await expect(execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).resolves.toMatchObject({
    stdout: previousCommit.trim(),
  });
  await expect(
    execa("git", ["-C", repositoryPath, "status", "--porcelain"]),
  ).resolves.toMatchObject({ stdout: "" });

  await expect(
    service.applyCommitToWorkingTree({
      repositoryPath,
      targetBranch: "main",
      baseCommit: baseCommit.trim(),
      resultCommit,
      expectedTargetCommit: previousCommit.trim(),
      conflictResolutions: agentResolution.resolutions,
    }),
  ).resolves.toMatchObject({ status: "applied", branch: "main", workingTreeUpdated: true });
  expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("计数=300\n");
  await expect(
    execa("git", ["-C", repositoryPath, "status", "--porcelain"]),
  ).resolves.toMatchObject({ stdout: "" });
});
