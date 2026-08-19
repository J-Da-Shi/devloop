import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { GitRepositoryService } from "./git-repository-service.js";
import { parseNameStatusZ, parseNumstatZ, pathExists } from "./git-base-service.js";
import type {
  CommitWorktreeInput,
  CreateDetachedWorktreeInput,
  CreateWorktreeInput,
  GetRunFilePatchInput,
  ListRunChangedFilesInput,
  MoveWorktreeToCommitInput,
  RemoveManagedWorktreeInput,
} from "./git-types.js";
import type { RunChangedFile, RunFilePatch } from "./git-types.js";
import { GitApplyError } from "./git-types.js";

export class GitWorktreeService extends GitRepositoryService {
  async createWorktree(input: CreateWorktreeInput): Promise<void> {
    input.signal?.throwIfAborted();
    const repositoryPath = await realpath(input.repositoryPath);
    await mkdir(dirname(input.worktreePath), { recursive: true });
    if (await pathExists(input.worktreePath)) throw new Error("目标 Worktree 路径已经存在");
    await this.executeForRun(
      [
        "-C",
        repositoryPath,
        "worktree",
        "add",
        "-b",
        input.branchName,
        input.worktreePath,
        input.baseCommit,
      ],
      input,
    );
  }

  async createDetachedWorktree(input: CreateDetachedWorktreeInput): Promise<void> {
    input.signal?.throwIfAborted();
    const repositoryPath = await realpath(input.repositoryPath);
    await mkdir(dirname(input.worktreePath), { recursive: true });
    if (await pathExists(input.worktreePath)) throw new Error("目标 Worktree 路径已经存在");
    await this.executeForRun(
      ["-C", repositoryPath, "worktree", "add", "--detach", input.worktreePath, input.commit],
      input,
    );
  }

  async removeManagedWorktree(input: RemoveManagedWorktreeInput): Promise<void> {
    const managedRoot = resolve(input.managedRoot);
    const worktreePath = resolve(input.worktreePath);
    const relativePath = relative(managedRoot, worktreePath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath))
      throw new Error("拒绝清理受管预览目录之外的 Worktree");
    const repositoryPath = await realpath(input.repositoryPath);
    await execa(
      this.executable,
      ["-C", repositoryPath, "worktree", "remove", "--force", worktreePath],
      { reject: false },
    );
    await rm(worktreePath, { recursive: true, force: true });
    await execa(this.executable, ["-C", repositoryPath, "worktree", "prune"], { reject: false });
  }

  async commitWorktree(input: CommitWorktreeInput): Promise<string> {
    input.signal?.throwIfAborted();
    const worktreePath = await realpath(input.worktreePath);
    const { stdout: status } = await this.executeForRun(
      ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"],
      input,
    );
    if (status.trim()) {
      await this.executeForRun(["-C", worktreePath, "add", "--all"], input);
      await this.executeForRun(
        [
          "-c",
          "user.name=DevLoop",
          "-c",
          "user.email=devloop@local",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-C",
          worktreePath,
          "commit",
          "--no-verify",
          "-m",
          input.message,
        ],
        input,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
    }
    const { stdout: resultCommit } = await this.executeForRun(
      ["-C", worktreePath, "rev-parse", "HEAD"],
      input,
    );
    return resultCommit.trim();
  }

  async moveWorktreeToCommit(input: MoveWorktreeToCommitInput): Promise<void> {
    const worktreePath = await realpath(input.worktreePath);
    const [{ stdout: currentCommit }, { stdout: status }, targetCheck] = await Promise.all([
      execa(this.executable, ["-C", worktreePath, "rev-parse", "HEAD"]),
      execa(this.executable, [
        "-C",
        worktreePath,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      execa(
        this.executable,
        ["-C", worktreePath, "cat-file", "-e", `${input.targetCommit}^{commit}`],
        { reject: false },
      ),
    ]);
    if (currentCommit.trim() !== input.expectedCommit)
      throw new GitApplyError(
        "TARGET_BRANCH_CHANGED",
        "Run Worktree 的结果 Commit 已发生变化，拒绝覆盖 Codex 结果。",
      );
    if (status.trim())
      throw new GitApplyError(
        "WORKTREE_DIRTY",
        "Run Worktree 在冲突解决后出现未提交修改，拒绝切换到已解决结果。",
      );
    if (targetCheck.exitCode !== 0)
      throw new GitApplyError("RESULT_COMMIT_MISSING", "自动解决后的结果 Commit 已不存在。");
    await execa(this.executable, ["-C", worktreePath, "reset", "--hard", input.targetCommit]);
  }

  async listRunChangedFiles(input: ListRunChangedFilesInput): Promise<RunChangedFile[]> {
    if (input.baseCommit === input.resultCommit) return [];
    const repositoryPath = await realpath(input.repositoryPath);
    const range = `${input.baseCommit}..${input.resultCommit}`;
    const [{ stdout: numstatOutput }, { stdout: nameStatusOutput }] = await Promise.all([
      execa(this.executable, ["-C", repositoryPath, "diff", "--numstat", "-z", range]),
      execa(this.executable, ["-C", repositoryPath, "diff", "--name-status", "-z", range]),
    ]);
    const numstat = parseNumstatZ(numstatOutput);
    return parseNameStatusZ(nameStatusOutput).map((entry) => {
      const stat = numstat.get(entry.path);
      return {
        path: entry.path,
        status: entry.status,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        isBinary: stat?.isBinary ?? false,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      };
    });
  }

  async getRunFilePatch(input: GetRunFilePatchInput): Promise<RunFilePatch> {
    if (input.baseCommit === input.resultCommit) return { patch: "", isBinary: false };
    const repositoryPath = await realpath(input.repositoryPath);
    const range = `${input.baseCommit}..${input.resultCommit}`;
    const { stdout: numstatOutput } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "diff",
      "--numstat",
      "-z",
      range,
      "--",
      input.path,
    ]);
    if (parseNumstatZ(numstatOutput).get(input.path)?.isBinary)
      return { patch: "", isBinary: true };
    const { stdout: patch } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "diff",
      range,
      "--",
      input.path,
    ]);
    return { patch, isBinary: false };
  }
}
