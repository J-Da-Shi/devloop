import { access, realpath, rm } from "node:fs/promises";
import { execa } from "execa";
import { createGitCommand } from "./git-command.js";
import type { GitExecutionOptions } from "./git-types.js";
import { GitApplyError } from "./git-types.js";

export interface NumstatEntry {
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface NameStatusEntry {
  path: string;
  status: import("./git-types.js").RunChangedFileStatus;
  oldPath?: string;
}

export interface ConflictStageEntry {
  mode: string;
  objectId: string;
  stage: 0 | 1 | 2 | 3;
}

export interface PreparedConflictFile {
  file: import("./git-types.js").RunConflictFile;
  stages: ConflictStageEntry[];
}

export interface PreparedCommitComparison {
  repositoryPath: string;
  targetBranch: string;
  targetCommit: string | null;
  changedPaths: string[];
}

export const maxEditableConflictBytes = 750_000;

export const pathExists = async (path: string): Promise<boolean> => {
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

export const hasUnresolvedConflictMarkers = (content: string): boolean =>
  content.split(/\r?\n/).some((line) => /^(?:<{7}|={7}|>{7})(?: .*)?$/.test(line));

export const parseNumstatZ = (stdout: string): Map<string, NumstatEntry> => {
  const result = new Map<string, NumstatEntry>();
  const tokens = stdout.split("\0");
  let index = 0;
  while (index < tokens.length) {
    const line = tokens[index];
    if (!line) {
      index += 1;
      continue;
    }
    const [additionsText, deletionsText, maybePath] = line.split("\t");
    if (additionsText === undefined || deletionsText === undefined) {
      index += 1;
      continue;
    }
    const isBinary = additionsText === "-" && deletionsText === "-";
    const additions = isBinary ? 0 : Number.parseInt(additionsText, 10) || 0;
    const deletions = isBinary ? 0 : Number.parseInt(deletionsText, 10) || 0;
    let path: string;
    if (maybePath) {
      path = maybePath;
      index += 1;
    } else {
      path = tokens[index + 2] ?? tokens[index + 1] ?? "";
      index += 3;
    }
    if (path) {
      result.set(path, { additions, deletions, isBinary });
    }
  }
  return result;
};

const mapNameStatusCode = (code: string): import("./git-types.js").RunChangedFileStatus => {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    default:
      return "modified";
  }
};

export const parseNameStatusZ = (stdout: string): NameStatusEntry[] => {
  const tokens = stdout
    .split("\0")
    .filter((_, index, all) => index < all.length - 1 || all[index] !== "");
  const entries: NameStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const code = tokens[index];
    if (!code) {
      index += 1;
      continue;
    }
    const status = mapNameStatusCode(code);
    if (code[0] === "R" || code[0] === "C") {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      if (newPath) {
        entries.push({ path: newPath, status, ...(oldPath ? { oldPath } : {}) });
      }
      index += 3;
    } else {
      const path = tokens[index + 1];
      if (path) entries.push({ path, status });
      index += 2;
    }
  }
  return entries;
};

export class GitBaseService {
  protected readonly executable: string;
  protected readonly executeForRun: ReturnType<typeof createGitCommand>["executeForRun"];
  protected readonly nonInteractiveEnvironment: ReturnType<
    typeof createGitCommand
  >["nonInteractiveEnvironment"];

  public constructor(executable = "git") {
    this.executable = executable;
    const command = createGitCommand(executable);
    this.executeForRun = command.executeForRun;
    this.nonInteractiveEnvironment = command.nonInteractiveEnvironment;
  }

  protected async resolveLocalBranch(
    repositoryPath: string,
    branch: string,
    execution: GitExecutionOptions = {},
  ): Promise<string | null> {
    const result = await this.executeForRun(
      ["-C", repositoryPath, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
      execution,
      { reject: false },
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  protected async resolveRemoteBranch(
    repositoryPath: string,
    branch: string,
    execution: GitExecutionOptions = {},
  ): Promise<string | null> {
    const result = await this.executeForRun(
      ["-C", repositoryPath, "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`],
      execution,
      { reject: false },
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  protected async normalizeBranchName(
    repositoryPath: string,
    branch: string,
    execution: GitExecutionOptions = {},
  ): Promise<string> {
    if (branch === "HEAD") {
      const { stdout } = await this.executeForRun(
        ["-C", repositoryPath, "branch", "--show-current"],
        execution,
      );
      const currentBranch = stdout.trim();
      if (!currentBranch) {
        throw new GitApplyError(
          "DETACHED_HEAD",
          "项目当前处于 detached HEAD，无法把 HEAD 解析为目标分支。",
        );
      }
      return currentBranch;
    }
    if (branch.startsWith("refs/")) {
      throw new GitApplyError(
        "INVALID_BRANCH",
        "目标分支只填写分支名，不要包含 refs/heads/ 前缀。",
      );
    }
    const result = await this.executeForRun(
      ["-C", repositoryPath, "check-ref-format", "--branch", branch],
      execution,
      { reject: false },
    );
    if (result.exitCode !== 0) {
      throw new GitApplyError(
        "INVALID_BRANCH",
        `目标分支名称无效：${result.stderr.trim() || result.stdout.trim() || branch}`,
      );
    }
    return branch;
  }

  protected async getChangedPaths(
    repositoryPath: string,
    baseCommit: string,
    resultCommit: string,
  ): Promise<string[]> {
    const { stdout } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      baseCommit,
      resultCommit,
    ]);
    return stdout.split("\0").filter(Boolean);
  }

  protected async assertPathsClean(repositoryPath: string, paths: string[]): Promise<void> {
    const { stdout } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ...paths,
    ]);
    if (stdout.length > 0) {
      throw new GitApplyError(
        "WORKTREE_DIRTY",
        "本次结果涉及的文件存在未提交或未跟踪内容，请先提交、暂存或移走后再写入。",
      );
    }
  }

  protected async pathsMatchCommit(
    repositoryPath: string,
    currentCommit: string,
    resultCommit: string,
    paths: string[],
  ): Promise<boolean> {
    const result = await execa(
      this.executable,
      [
        "-C",
        repositoryPath,
        "diff",
        "--quiet",
        "--no-ext-diff",
        currentCommit,
        resultCommit,
        "--",
        ...paths,
      ],
      { reject: false },
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitApplyError(
      "APPLY_FAILED",
      `无法比较当前项目与结果文件：${result.stderr.trim() || "Git 命令执行失败"}`,
    );
  }

  protected async hasAppliedResultMarker(
    repositoryPath: string,
    currentCommit: string,
    resultCommit: string,
  ): Promise<boolean> {
    const { stdout } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "log",
      "-1",
      "--format=%H",
      "--fixed-strings",
      `--grep=DevLoop-Result: ${resultCommit}`,
      currentCommit,
    ]);
    return stdout.trim().length > 0;
  }

  protected async getBranchCheckoutPath(
    repositoryPath: string,
    branch: string,
  ): Promise<string | null> {
    const { stdout } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "worktree",
      "list",
      "--porcelain",
    ]);
    const targetRef = `refs/heads/${branch}`;
    let worktreePath: string | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length);
      else if (line === `branch ${targetRef}`) return worktreePath;
      else if (!line && worktreePath) worktreePath = null;
    }
    return null;
  }

  protected async isAncestor(
    repositoryPath: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    const result = await execa(
      this.executable,
      ["-C", repositoryPath, "merge-base", "--is-ancestor", ancestor, descendant],
      { reject: false },
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitApplyError(
      "APPLY_FAILED",
      `无法验证 Commit 关系：${result.stderr.trim() || "Git 命令执行失败"}`,
    );
  }

  protected async realRepositoryPath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      throw new GitApplyError("INVALID_REPOSITORY", "所选目录不存在或无法访问。");
    }
  }

  protected async removeTemporaryWorktree(
    repositoryPath: string,
    temporaryRoot: string,
    temporaryWorktree: string,
    created: boolean,
  ): Promise<void> {
    if (created) {
      await execa(
        this.executable,
        ["-C", repositoryPath, "worktree", "remove", "--force", temporaryWorktree],
        { reject: false },
      );
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
