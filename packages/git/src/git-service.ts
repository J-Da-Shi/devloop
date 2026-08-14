import { access, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import type {
  RunApplicationResult,
  RunChangedFile,
  RunChangedFileStatus,
  RunFilePatch,
  RunPublishResult,
} from "@devloop/shared";

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

export interface CloneRepositoryInput {
  repositoryUrl: string;
  destinationPath: string;
  defaultBranch: string;
}

export interface ClonedRepositoryInfo {
  repositoryUrl: string;
  path: string;
  defaultBranch: string;
  headCommit: string;
}

export interface ResolveRemoteTargetBaseInput {
  repositoryPath: string;
  targetBranch: string;
  fallbackRef: string;
}

export interface PushResultInput {
  repositoryPath: string;
  targetBranch: string;
  baseCommit: string;
  resultCommit: string;
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
  targetBranch: string;
  baseCommit: string;
  resultCommit: string;
}

export interface ListRunChangedFilesInput {
  repositoryPath: string;
  baseCommit: string;
  resultCommit: string;
}

export interface GetRunFilePatchInput {
  repositoryPath: string;
  baseCommit: string;
  resultCommit: string;
  path: string;
}

export type { RunChangedFile, RunChangedFileStatus, RunFilePatch } from "@devloop/shared";

export interface ResolveTargetBaseInput {
  repositoryPath: string;
  targetBranch: string;
  fallbackRef: string;
}

export interface ResolvedTargetBase {
  targetBranch: string;
  baseCommit: string;
  branchExists: boolean;
}

export type GitApplyErrorCode =
  | "WORKTREE_DIRTY"
  | "DETACHED_HEAD"
  | "INVALID_BRANCH"
  | "BRANCH_CHECKED_OUT"
  | "TARGET_BRANCH_CHANGED"
  | "BASE_COMMIT_MISSING"
  | "RESULT_COMMIT_MISSING"
  | "INVALID_RESULT_RANGE"
  | "INVALID_REPOSITORY_URL"
  | "REPOSITORY_EXISTS"
  | "REMOTE_ACCESS_FAILED"
  | "REMOTE_PUSH_REJECTED"
  | "APPLY_CONFLICT"
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

interface NumstatEntry {
  additions: number;
  deletions: number;
  isBinary: boolean;
}

const parseNumstatZ = (stdout: string): Map<string, NumstatEntry> => {
  const result = new Map<string, NumstatEntry>();
  const tokens = stdout.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const line = tokens[i];
    if (!line) {
      i += 1;
      continue;
    }
    const [addStr, delStr, maybePath] = line.split("\t");
    if (addStr === undefined || delStr === undefined) {
      i += 1;
      continue;
    }
    const isBinary = addStr === "-" && delStr === "-";
    const additions = isBinary ? 0 : Number.parseInt(addStr, 10) || 0;
    const deletions = isBinary ? 0 : Number.parseInt(delStr, 10) || 0;
    let path: string;
    if (maybePath && maybePath.length > 0) {
      path = maybePath;
      i += 1;
    } else {
      // Rename/copy: current form is empty, followed by two NUL-separated tokens (oldPath, newPath).
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      path = newPath ?? oldPath ?? "";
      i += 3;
    }
    if (path) {
      result.set(path, { additions, deletions, isBinary });
    }
  }
  return result;
};

const mapNameStatusCode = (code: string): RunChangedFileStatus => {
  const first = code[0];
  switch (first) {
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

interface NameStatusEntry {
  path: string;
  status: RunChangedFileStatus;
  oldPath?: string;
}

const parseNameStatusZ = (stdout: string): NameStatusEntry[] => {
  const tokens = stdout.split("\0").filter((_, idx, arr) => idx < arr.length - 1 || arr[idx] !== "");
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i];
    if (!code) {
      i += 1;
      continue;
    }
    const status = mapNameStatusCode(code);
    const first = code[0];
    if (first === "R" || first === "C") {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (newPath) {
        const entry: NameStatusEntry = { path: newPath, status };
        if (oldPath) {
          entry.oldPath = oldPath;
        }
        entries.push(entry);
      }
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path) {
        entries.push({ path, status });
      }
      i += 2;
    }
  }
  return entries;
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

  normalizeRepositoryUrl(value: string): string {
    const repositoryUrl = value.trim();
    if (repositoryUrl.startsWith("ssh://")) {
      let url: URL;
      try {
        url = new URL(repositoryUrl);
      } catch {
        throw new GitApplyError("INVALID_REPOSITORY_URL", "SSH Git 仓库地址格式无效。");
      }
      if (
        url.protocol !== "ssh:" ||
        !url.hostname ||
        url.password ||
        !url.pathname ||
        url.pathname === "/"
      ) {
        throw new GitApplyError(
          "INVALID_REPOSITORY_URL",
          "首版仅支持不含密码的 SSH Git 仓库地址。",
        );
      }
      url.hostname = url.hostname.toLowerCase();
      url.pathname = url.pathname.replace(/\/+$/, "");
      return url.toString().replace(/\/$/, "");
    }

    if (repositoryUrl.includes("://")) {
      throw new GitApplyError(
        "INVALID_REPOSITORY_URL",
        "首版仅支持 SSH Git 地址，例如 git@github.com:team/project.git。",
      );
    }

    const match = /^(?:(?<user>[A-Za-z0-9._-]+)@)?(?<host>[A-Za-z0-9._-]+):(?<path>[^\s]+)$/.exec(
      repositoryUrl,
    );
    if (!match?.groups?.host || !match.groups.path) {
      throw new GitApplyError(
        "INVALID_REPOSITORY_URL",
        "首版仅支持 SSH Git 地址，例如 git@github.com:team/project.git。",
      );
    }
    const user = match.groups.user ? `${match.groups.user}@` : "";
    const path = match.groups.path.replace(/\/+$/, "");
    if (!path || path.startsWith(":")) {
      throw new GitApplyError("INVALID_REPOSITORY_URL", "SSH Git 仓库路径不能为空。");
    }
    return `${user}${match.groups.host.toLowerCase()}:${path}`;
  }

  async validateBranchName(branch: string): Promise<string> {
    const candidate = branch.trim();
    if (candidate === "HEAD" || candidate.startsWith("refs/")) {
      throw new GitApplyError(
        "INVALID_BRANCH",
        "分支只填写实际分支名，不要使用 HEAD 或 refs/heads/ 前缀。",
      );
    }
    const result = await execa(this.executable, ["check-ref-format", "--branch", candidate], {
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new GitApplyError(
        "INVALID_BRANCH",
        `分支名称无效：${result.stderr.trim() || result.stdout.trim() || candidate}`,
      );
    }
    return candidate;
  }

  async cloneRepository(input: CloneRepositoryInput): Promise<ClonedRepositoryInfo> {
    const repositoryUrl = this.normalizeRepositoryUrl(input.repositoryUrl);
    const defaultBranch = await this.validateBranchName(input.defaultBranch);
    await mkdir(dirname(input.destinationPath), { recursive: true });
    if (await pathExists(input.destinationPath)) {
      throw new GitApplyError("REPOSITORY_EXISTS", "服务器托管仓库目录已经存在。");
    }

    const temporaryRoot = await mkdtemp(join(dirname(input.destinationPath), ".devloop-clone-"));
    const temporaryRepository = join(temporaryRoot, "repository");
    try {
      const clone = await execa(
        this.executable,
        ["clone", "--no-checkout", "--origin", "origin", repositoryUrl, temporaryRepository],
        { env: this.nonInteractiveEnvironment(), reject: false },
      );
      if (clone.exitCode !== 0) {
        throw new GitApplyError(
          "REMOTE_ACCESS_FAILED",
          `远程仓库克隆失败：${clone.stderr.trim() || clone.stdout.trim() || "Git 命令执行失败"}`,
        );
      }
      const resolved = await this.resolveRemoteTargetBase({
        repositoryPath: temporaryRepository,
        targetBranch: defaultBranch,
        fallbackRef: defaultBranch,
      });
      if (!resolved.branchExists) {
        throw new GitApplyError(
          "BASE_COMMIT_MISSING",
          `远程仓库中不存在默认分支 ${defaultBranch}。`,
        );
      }
      await rename(temporaryRepository, input.destinationPath);
      return {
        repositoryUrl,
        path: await realpath(input.destinationPath),
        defaultBranch,
        headCommit: resolved.baseCommit,
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async removeManagedRepository(repositoryPath: string): Promise<void> {
    await rm(repositoryPath, { recursive: true, force: true });
  }

  async fetchRepository(repositoryPath: string): Promise<void> {
    const resolvedPath = await realpath(repositoryPath);
    const fetch = await execa(
      this.executable,
      ["-C", resolvedPath, "fetch", "--prune", "origin"],
      { env: this.nonInteractiveEnvironment(), reject: false },
    );
    if (fetch.exitCode !== 0) {
      throw new GitApplyError(
        "REMOTE_ACCESS_FAILED",
        `远程仓库同步失败：${fetch.stderr.trim() || fetch.stdout.trim() || "Git 命令执行失败"}`,
      );
    }
  }

  async resolveRemoteTargetBase(
    input: ResolveRemoteTargetBaseInput,
  ): Promise<ResolvedTargetBase> {
    const repositoryPath = await realpath(input.repositoryPath);
    const targetBranch = await this.validateBranchName(input.targetBranch);
    const fallbackRef = await this.validateBranchName(input.fallbackRef);
    const branchCommit = await this.resolveRemoteBranch(repositoryPath, targetBranch);
    if (branchCommit) {
      return { targetBranch, baseCommit: branchCommit, branchExists: true };
    }
    const fallbackCommit = await this.resolveRemoteBranch(repositoryPath, fallbackRef);
    if (!fallbackCommit) {
      throw new GitApplyError(
        "BASE_COMMIT_MISSING",
        `目标分支 ${targetBranch} 不存在，且远程默认分支 ${fallbackRef} 无法解析。`,
      );
    }
    return { targetBranch, baseCommit: fallbackCommit, branchExists: false };
  }

  async pushResult(input: PushResultInput): Promise<RunPublishResult> {
    const repositoryPath = await realpath(input.repositoryPath);
    const targetBranch = await this.validateBranchName(input.targetBranch);
    await this.fetchRepository(repositoryPath);
    const [baseCommitCheck, resultCommitCheck] = await Promise.all([
      execa(this.executable, ["-C", repositoryPath, "cat-file", "-e", `${input.baseCommit}^{commit}`], {
        reject: false,
      }),
      execa(
        this.executable,
        ["-C", repositoryPath, "cat-file", "-e", `${input.resultCommit}^{commit}`],
        { reject: false },
      ),
    ]);
    if (baseCommitCheck.exitCode !== 0) {
      throw new GitApplyError("BASE_COMMIT_MISSING", "本次运行的基础 Commit 已不存在。");
    }
    if (resultCommitCheck.exitCode !== 0) {
      throw new GitApplyError("RESULT_COMMIT_MISSING", "本次运行的结果 Commit 已不存在。");
    }
    if (!(await this.isAncestor(repositoryPath, input.baseCommit, input.resultCommit))) {
      throw new GitApplyError(
        "INVALID_RESULT_RANGE",
        "结果 Commit 不是从本次运行的基础 Commit 产生，拒绝推送。",
      );
    }

    const remoteCommit = await this.resolveRemoteBranch(repositoryPath, targetBranch);
    if (
      remoteCommit &&
      (remoteCommit === input.resultCommit ||
        (await this.isAncestor(repositoryPath, input.resultCommit, remoteCommit)))
    ) {
      return {
        status: "already_pushed",
        branch: targetBranch,
        previousCommit: remoteCommit,
        currentCommit: remoteCommit,
        branchCreated: false,
      };
    }
    if (remoteCommit && remoteCommit !== input.baseCommit) {
      throw new GitApplyError(
        "REMOTE_PUSH_REJECTED",
        `远程目标分支 ${targetBranch} 已从执行基线前进，DevLoop 不会强制覆盖。`,
      );
    }

    const push = await execa(
      this.executable,
      ["-C", repositoryPath, "push", "--porcelain", "origin", `${input.resultCommit}:refs/heads/${targetBranch}`],
      { env: this.nonInteractiveEnvironment(), reject: false },
    );
    if (push.exitCode !== 0) {
      throw new GitApplyError(
        "REMOTE_PUSH_REJECTED",
        `远程分支推送失败：${push.stderr.trim() || push.stdout.trim() || "远程拒绝更新"}`,
      );
    }
    return {
      status: "pushed",
      branch: targetBranch,
      previousCommit: remoteCommit,
      currentCommit: input.resultCommit,
      branchCreated: remoteCommit === null,
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

  async resolveTargetBase(input: ResolveTargetBaseInput): Promise<ResolvedTargetBase> {
    const repositoryPath = await realpath(input.repositoryPath);
    const targetBranch = await this.normalizeBranchName(repositoryPath, input.targetBranch);
    const branchCommit = await this.resolveLocalBranch(repositoryPath, targetBranch);
    if (branchCommit) {
      return { targetBranch, baseCommit: branchCommit, branchExists: true };
    }

    const fallback = await execa(
      this.executable,
      ["-C", repositoryPath, "rev-parse", "--verify", `${input.fallbackRef}^{commit}`],
      { reject: false },
    );
    if (fallback.exitCode !== 0) {
      throw new GitApplyError(
        "BASE_COMMIT_MISSING",
        `目标分支 ${targetBranch} 不存在，且默认基线 ${input.fallbackRef} 无法解析。`,
      );
    }
    return {
      targetBranch,
      baseCommit: fallback.stdout.trim(),
      branchExists: false,
    };
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

  async listRunChangedFiles(input: ListRunChangedFilesInput): Promise<RunChangedFile[]> {
    if (input.baseCommit === input.resultCommit) {
      return [];
    }
    const repositoryPath = await realpath(input.repositoryPath);
    const range = `${input.baseCommit}..${input.resultCommit}`;

    const { stdout: numstatOut } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "diff",
      "--numstat",
      "-z",
      range,
    ]);
    const numstat = parseNumstatZ(numstatOut);

    const { stdout: nameStatusOut } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "diff",
      "--name-status",
      "-z",
      range,
    ]);
    const nameStatus = parseNameStatusZ(nameStatusOut);

    const files: RunChangedFile[] = [];
    for (const entry of nameStatus) {
      const stat = numstat.get(entry.path);
      const file: RunChangedFile = {
        path: entry.path,
        status: entry.status,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        isBinary: stat?.isBinary ?? false,
      };
      if (entry.oldPath) {
        file.oldPath = entry.oldPath;
      }
      files.push(file);
    }
    return files;
  }

  async getRunFilePatch(input: GetRunFilePatchInput): Promise<RunFilePatch> {
    if (input.baseCommit === input.resultCommit) {
      return { patch: "", isBinary: false };
    }
    const repositoryPath = await realpath(input.repositoryPath);
    const range = `${input.baseCommit}..${input.resultCommit}`;

    const { stdout: numstatOut } = await execa(this.executable, [
      "-C",
      repositoryPath,
      "diff",
      "--numstat",
      "-z",
      range,
      "--",
      input.path,
    ]);
    const numstat = parseNumstatZ(numstatOut);
    const isBinary = numstat.get(input.path)?.isBinary ?? false;
    if (isBinary) {
      return { patch: "", isBinary: true };
    }

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

  async applyCommitToWorkingTree(input: ApplyCommitInput): Promise<RunApplicationResult> {
    const repositoryPath = await realpath(input.repositoryPath);
    const targetBranch = await this.normalizeBranchName(repositoryPath, input.targetBranch);
    const [baseCommitCheck, resultCommitCheck] = await Promise.all([
      execa(
        this.executable,
        ["-C", repositoryPath, "cat-file", "-e", `${input.baseCommit}^{commit}`],
        { reject: false },
      ),
      execa(
        this.executable,
        ["-C", repositoryPath, "cat-file", "-e", `${input.resultCommit}^{commit}`],
        { reject: false },
      ),
    ]);
    if (baseCommitCheck.exitCode !== 0) {
      throw new GitApplyError(
        "BASE_COMMIT_MISSING",
        "本次运行的基础 Commit 在当前项目中不存在，无法计算需要写回的文件。",
      );
    }
    if (resultCommitCheck.exitCode !== 0) {
      throw new GitApplyError(
        "RESULT_COMMIT_MISSING",
        "结果 Commit 在当前项目中不存在，无法应用到工作目录。",
      );
    }
    if (!(await this.isAncestor(repositoryPath, input.baseCommit, input.resultCommit))) {
      throw new GitApplyError(
        "INVALID_RESULT_RANGE",
        "结果 Commit 不是从本次运行的基础 Commit 产生，无法安全写回。",
      );
    }

    const targetCommit = await this.resolveLocalBranch(repositoryPath, targetBranch);
    const targetCheckoutPath = targetCommit
      ? await this.getBranchCheckoutPath(repositoryPath, targetBranch)
      : null;
    const workingTreeUpdated = targetCheckoutPath
      ? (await realpath(targetCheckoutPath)) === repositoryPath
      : false;
    if (targetCheckoutPath && !workingTreeUpdated) {
      throw new GitApplyError(
        "BRANCH_CHECKED_OUT",
        `目标分支 ${targetBranch} 正在其他 Worktree 中检出：${targetCheckoutPath}`,
      );
    }

    const previousCommit = targetCommit ?? input.baseCommit;
    const changedPaths = await this.getChangedPaths(
      repositoryPath,
      input.baseCommit,
      input.resultCommit,
    );
    if (!targetCommit) {
      return this.updateTargetBranch({
        repositoryPath,
        branch: targetBranch,
        previousCommit,
        candidateCommit: input.resultCommit,
        changedPaths,
        branchCreated: true,
        workingTreeUpdated: false,
      });
    }
    if (changedPaths.length === 0) {
      return {
        status: "already_applied",
        branch: targetBranch,
        previousCommit,
        currentCommit: previousCommit,
        branchCreated: false,
        workingTreeUpdated,
      };
    }
    if (workingTreeUpdated) {
      await this.assertPathsClean(repositoryPath, changedPaths);
    }

    if (
      (await this.isAncestor(repositoryPath, input.resultCommit, previousCommit)) ||
      (await this.hasAppliedResultMarker(repositoryPath, previousCommit, input.resultCommit)) ||
      (await this.pathsMatchCommit(
        repositoryPath,
        previousCommit,
        input.resultCommit,
        changedPaths,
      ))
    ) {
      return {
        status: "already_applied",
        branch: targetBranch,
        previousCommit,
        currentCommit: previousCommit,
        branchCreated: false,
        workingTreeUpdated,
      };
    }

    let candidateCommit: string;
    if (await this.isAncestor(repositoryPath, previousCommit, input.resultCommit)) {
      candidateCommit = input.resultCommit;
    } else {
      candidateCommit = await this.createPatchedCommit(
        repositoryPath,
        previousCommit,
        input.baseCommit,
        input.resultCommit,
      );
    }

    return this.updateTargetBranch({
      repositoryPath,
      branch: targetBranch,
      previousCommit,
      candidateCommit,
      changedPaths,
      branchCreated: false,
      workingTreeUpdated,
    });
  }

  private async createPatchedCommit(
    repositoryPath: string,
    previousCommit: string,
    baseCommit: string,
    resultCommit: string,
  ): Promise<string> {
    const { stdout: patch } = await execa(
      this.executable,
      [
        "-C",
        repositoryPath,
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        baseCommit,
        resultCommit,
      ],
      { stripFinalNewline: false },
    );
    const temporaryRoot = await mkdtemp(join(tmpdir(), "devloop-apply-"));
    const temporaryWorktree = join(temporaryRoot, "worktree");
    let worktreeCreated = false;
    try {
      const addWorktree = await execa(
        this.executable,
        ["-C", repositoryPath, "worktree", "add", "--detach", temporaryWorktree, previousCommit],
        { reject: false },
      );
      if (addWorktree.exitCode !== 0) {
        throw new GitApplyError(
          "APPLY_FAILED",
          `无法创建临时写回目录：${addWorktree.stderr.trim() || addWorktree.stdout.trim()}`,
        );
      }
      worktreeCreated = true;

      const apply = await execa(
        this.executable,
        ["-C", temporaryWorktree, "apply", "--3way", "--index", "--whitespace=nowarn", "-"],
        { input: patch, reject: false },
      );
      if (apply.exitCode !== 0) {
        const message = apply.stderr.trim() || apply.stdout.trim() || "Git 三方应用失败";
        throw new GitApplyError(
          "APPLY_CONFLICT",
          `本次结果与目标分支文件存在冲突，未写入目标分支：${message}`,
        );
      }

      const { stdout: resultSubject } = await execa(this.executable, [
        "-C",
        repositoryPath,
        "show",
        "-s",
        "--format=%s",
        resultCommit,
      ]);
      const commit = await execa(
        this.executable,
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
          temporaryWorktree,
          "commit",
          "-m",
          resultSubject.trim() || `DevLoop: 写回结果 ${resultCommit.slice(0, 12)}`,
          "-m",
          `DevLoop-Result: ${resultCommit}`,
        ],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, reject: false },
      );
      if (commit.exitCode !== 0) {
        throw new Error(commit.stderr.trim() || commit.stdout.trim() || "Git 提交失败");
      }

      const { stdout: candidateCommit } = await execa(this.executable, [
        "-C",
        temporaryWorktree,
        "rev-parse",
        "HEAD",
      ]);
      return candidateCommit.trim();
    } catch (error) {
      if (error instanceof GitApplyError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "未知 Git 错误";
      throw new GitApplyError("APPLY_FAILED", `结果文件写回失败：${message}`);
    } finally {
      if (worktreeCreated) {
        await execa(
          this.executable,
          ["-C", repositoryPath, "worktree", "remove", "--force", temporaryWorktree],
          { reject: false },
        );
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async updateTargetBranch(input: {
    repositoryPath: string;
    branch: string;
    previousCommit: string;
    candidateCommit: string;
    changedPaths: string[];
    branchCreated: boolean;
    workingTreeUpdated: boolean;
  }): Promise<RunApplicationResult> {
    const branchRef = `refs/heads/${input.branch}`;
    if (input.workingTreeUpdated) {
      const [{ stdout: currentBranch }, { stdout: currentHead }] = await Promise.all([
        execa(this.executable, ["-C", input.repositoryPath, "branch", "--show-current"]),
        execa(this.executable, ["-C", input.repositoryPath, "rev-parse", "HEAD"]),
      ]);
      if (currentBranch.trim() !== input.branch || currentHead.trim() !== input.previousCommit) {
        throw new GitApplyError(
          "TARGET_BRANCH_CHANGED",
          `写回期间目标分支 ${input.branch} 已发生变化，请刷新后重试。`,
        );
      }
      await this.assertPathsClean(input.repositoryPath, input.changedPaths);
      const merge = await execa(
        this.executable,
        ["-C", input.repositoryPath, "merge", "--ff-only", "--no-edit", input.candidateCommit],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, reject: false },
      );
      if (merge.exitCode !== 0) {
        const message = merge.stderr.trim() || merge.stdout.trim() || "Git 快进失败";
        throw new GitApplyError("APPLY_FAILED", `目标分支写入失败：${message}`);
      }
    } else {
      const expectedOld = input.branchCreated ? "0".repeat(40) : input.previousCommit;
      const update = await execa(
        this.executable,
        ["-C", input.repositoryPath, "update-ref", branchRef, input.candidateCommit, expectedOld],
        { reject: false },
      );
      if (update.exitCode !== 0) {
        const message = update.stderr.trim() || update.stdout.trim() || "Git 引用更新失败";
        throw new GitApplyError(
          "TARGET_BRANCH_CHANGED",
          `目标分支 ${input.branch} 在写回期间发生变化：${message}`,
        );
      }
    }

    return {
      status: "applied",
      branch: input.branch,
      previousCommit: input.previousCommit,
      currentCommit: input.candidateCommit,
      branchCreated: input.branchCreated,
      workingTreeUpdated: input.workingTreeUpdated,
    };
  }

  private async getChangedPaths(
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

  private async assertPathsClean(repositoryPath: string, paths: string[]): Promise<void> {
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

  private async pathsMatchCommit(
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

  private async hasAppliedResultMarker(
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

  private async normalizeBranchName(repositoryPath: string, branch: string): Promise<string> {
    if (branch === "HEAD") {
      const { stdout } = await execa(this.executable, [
        "-C",
        repositoryPath,
        "branch",
        "--show-current",
      ]);
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
    const result = await execa(
      this.executable,
      ["-C", repositoryPath, "check-ref-format", "--branch", branch],
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

  private async resolveLocalBranch(repositoryPath: string, branch: string): Promise<string | null> {
    const result = await execa(
      this.executable,
      ["-C", repositoryPath, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
      { reject: false },
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  private async resolveRemoteBranch(repositoryPath: string, branch: string): Promise<string | null> {
    const result = await execa(
      this.executable,
      ["-C", repositoryPath, "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`],
      { reject: false },
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  private nonInteractiveEnvironment(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  }

  private async getBranchCheckoutPath(
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
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
      } else if (line === `branch ${targetRef}`) {
        return worktreePath;
      } else if (!line && worktreePath) {
        worktreePath = null;
      }
    }
    return null;
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
