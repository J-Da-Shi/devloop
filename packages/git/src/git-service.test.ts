import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "./git-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("GitService Worktree", () => {
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
      service.applyCommitToWorkingTree({ repositoryPath, resultCommit }),
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
      service.applyCommitToWorkingTree({ repositoryPath, resultCommit }),
    ).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("本地未提交内容\n");
  });
});
