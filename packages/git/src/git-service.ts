import { access, mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { execa } from "execa";
import type { RunApplicationResult } from "@devloop/shared";

export interface GitRepositoryInfo {
  path: string;
  branch: string;
  headCommit: string;
}

export interface GitCapabilities {
  available: boolean;
  version: string | null;
  executablePath: string | null;
  error: string | null;
}

export interface CreateWorktreeInput {
  repositoryPath: string;
  worktreePath: string;
  branchName: string;
  baseCommit: string;
}

export interface CommitWorktreeInput {
  worktreePath: string;
  message: string;
}

export interface ApplyCommitInput {
  repositoryPath: string;
  resultCommit: string;
}

export type GitApplyErrorCode =
  | "WORKTREE_DIRTY"
  | "DETACHED_HEAD"
  | "RESULT_COMMIT_MISSING"
  | "NON_FAST_FORWARD"
  | "APPLY_FAILED";

export class GitApplyError extends Error {
  public constructor(
    public readonly code: GitApplyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitApplyError";
  }
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

export class GitService {
  public constructor(private readonly executable = "git") {}

  async detectCapabilities(): Promise<GitCapabilities> {
    try {
      const [{ stdout: version }, { stdout: executablePath }] = await Promise.all([
        execa(this.executable, ["--version"]),
        execa("/usr/bin/which", [this.executable]),
      ]);

      return {
        available: true,
        version: version.trim(),
        executablePath: executablePath.trim(),
        error: null,
      };
    } catch (error) {
      return {
        available: false,
        version: null,
        executablePath: null,
        error: error instanceof Error ? error.message : "Git is unavailable",
      };
    }
  }

  async inspectRepository(inputPath: string): Promise<GitRepositoryInfo> {
    const repositoryPath = await realpath(inputPath);
    const [{ stdout: topLevel }, { stdout: branch }, { stdout: headCommit }] = await Promise.all([
      execa(this.executable, ["-C", repositoryPath, "rev-parse", "--show-toplevel"]),
      execa(this.executable, ["-C", repositoryPath, "branch", "--show-current"]),
      execa(this.executable, ["-C", repositoryPath, "rev-parse", "HEAD"]),
    ]);

    if ((await realpath(topLevel.trim())) !== repositoryPath) {
      throw new Error("Only repository roots can be registered");
    }

    return {
      path: repositoryPath,
      branch: branch.trim() || "HEAD",
      headCommit: headCommit.trim(),
    };
  }

  async getStatus(repositoryPath: string): Promise<string> {
    const { stdout } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "status",
      "--short",
      "--branch",
    ]);
    return stdout;
  }

  async createWorktree(input: CreateWorktreeInput): Promise<void> {
    const repositoryPath = await realpath(input.repositoryPath);
    await mkdir(dirname(input.worktreePath), { recursive: true });
    if (await pathExists(input.worktreePath)) {
      throw new Error("目标 Worktree 路径已经存在");
    }

    await execa(this.executable, [
      "-C",
      repositoryPath,
      "worktree",
      "add",
      "-b",
      input.branchName,
      input.worktreePath,
      input.baseCommit,
    ]);
  }

  async commitWorktree(input: CommitWorktreeInput): Promise<string> {
    const worktreePath = await realpath(input.worktreePath);
    const { stdout: status } = await execa(this.executable, [
      "-C",
      worktreePath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.trim()) {
      await execa(this.executable, ["-C", worktreePath, "add", "--all"]);
      await execa(
        this.executable,
        [
          "-c",
          "user.name=DevLoop",
          "-c",
          "user.email=devloop@local",
          "-c",
          "commit.gpgSign=false",
          "-C",
          worktreePath,
          "commit",
          "-m",
          input.message,
        ],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
    }

    const { stdout: resultCommit } = await execa(this.executable, [
      "-C",
      worktreePath,
      "rev-parse",
      "HEAD",
    ]);
    return resultCommit.trim();
  }

  async applyCommitToWorkingTree(input: ApplyCommitInput): Promise<RunApplicationResult> {
    const repositoryPath = await realpath(input.repositoryPath);
    const [{ stdout: branchOutput }, { stdout: headOutput }, commitCheck] = await Promise.all([
      execa(this.executable, ["-C", repositoryPath, "branch", "--show-current"]),
      execa(this.executable, ["-C", repositoryPath, "rev-parse", "HEAD"]),
      execa(
        this.executable,
        ["-C", repositoryPath, "cat-file", "-e", `${input.resultCommit}^{commit}`],
        { reject: false },
      ),
    ]);
    const branch = branchOutput.trim();
    const previousCommit = headOutput.trim();
    if (!branch) {
      throw new GitApplyError(
        "DETACHED_HEAD",
        "当前项目处于 detached HEAD，请先切换到需要更新的本地分支。",
      );
    }
    if (commitCheck.exitCode !== 0) {
      throw new GitApplyError(
        "RESULT_COMMIT_MISSING",
        "结果 Commit 在当前项目中不存在，无法应用到工作目录。",
      );
    }
    if (await this.isAncestor(repositoryPath, input.resultCommit, previousCommit)) {
      return {
        status: "already_applied",
        branch,
        previousCommit,
        currentCommit: previousCommit,
      };
    }
    if (!(await this.isAncestor(repositoryPath, previousCommit, input.resultCommit))) {
      throw new GitApplyError(
        "NON_FAST_FORWARD",
        "当前分支与结果 Commit 已产生分叉，无法安全快进，请先处理分支差异。",
      );
    }

    const { stdout: status } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.trim()) {
      throw new GitApplyError(
        "WORKTREE_DIRTY",
        "当前项目存在未提交或未跟踪文件，请先提交、暂存或移走这些内容后再覆盖。",
      );
    }

    const merge = await execa(
      this.executable,
      ["-C", repositoryPath, "merge", "--ff-only", "--no-edit", input.resultCommit],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        reject: false,
      },
    );
    if (merge.exitCode !== 0) {
      const message = merge.stderr.trim() || merge.stdout.trim() || "Git 快进失败";
      throw new GitApplyError("APPLY_FAILED", `结果 Commit 应用失败：${message}`);
    }
    const { stdout: currentCommit } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "rev-parse",
      "HEAD",
    ]);
    return {
      status: "applied",
      branch,
      previousCommit,
      currentCommit: currentCommit.trim(),
    };
  }

  private async isAncestor(
    repositoryPath: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    const result = await execa(
      this.executable,
      ["-C", repositoryPath, "merge-base", "--is-ancestor", ancestor, descendant],
      { reject: false },
    );
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    throw new GitApplyError(
      "APPLY_FAILED",
      `无法验证 Commit 关系：${result.stderr.trim() || "Git 命令执行失败"}`,
    );
  }
}
