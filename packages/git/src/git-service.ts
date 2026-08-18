import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import type {
  RunApplicationResult,
  RunChangedFile,
  RunChangedFileStatus,
  RunConflictFile,
  RunConflictPreview,
  RunConflictResolution,
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

export interface GitExecutionOptions {
  signal?: AbortSignal;
  onProcessGroupId?: (processGroupId: number | null) => void;
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

export interface ResolveRemoteTargetBaseInput extends GitExecutionOptions {
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

export interface CreateWorktreeInput extends GitExecutionOptions {
  repositoryPath: string;
  worktreePath: string;
  branchName: string;
  baseCommit: string;
}

export interface CommitWorktreeInput extends GitExecutionOptions {
  worktreePath: string;
  message: string;
}

export interface ApplyCommitInput {
  repositoryPath: string;
  targetBranch: string;
  baseCommit: string;
  resultCommit: string;
  expectedTargetCommit?: string | null;
  conflictResolutions?: RunConflictResolution[];
}

export interface ConflictResolutionWorkspace {
  worktreePath: string;
  files: RunConflictFile[];
}

export interface GeneratedConflictResolutions {
  targetCommit: string;
  resolutions: RunConflictResolution[];
}

export interface ReconcileCommitInput {
  repositoryPath: string;
  targetBranch: string;
  targetCommit: string;
  baseCommit: string;
  resultCommit: string;
}

export type ReconcileCommitResult =
  | {
      status: "clean";
      targetCommit: string;
      resultCommit: string;
      resolutions: [];
    }
  | {
      status: "resolved";
      targetCommit: string;
      resultCommit: string;
      resolutions: RunConflictResolution[];
    };

export interface MoveWorktreeToCommitInput {
  worktreePath: string;
  expectedCommit: string;
  targetCommit: string;
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

export type {
  RunChangedFile,
  RunChangedFileStatus,
  RunConflictFile,
  RunConflictPreview,
  RunFilePatch,
} from "@devloop/shared";

export interface ResolveTargetBaseInput extends GitExecutionOptions {
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
  | "INVALID_REPOSITORY"
  | "REPOSITORY_NOT_ROOT"
  | "INVALID_BRANCH"
  | "BRANCH_CHECKED_OUT"
  | "TARGET_BRANCH_CHANGED"
  | "TARGET_COMMIT_MISSING"
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

const terminateProcessGroup = (processGroupId: number): void => {
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    processGroupId === process.pid
  ) {
    return;
  }
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill", ["/pid", String(processGroupId), "/T", "/F"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.on("error", () => undefined);
    taskkill.unref();
    return;
  }

  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch {
    return;
  }
  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // The process group has already exited.
    }
  }, 5_000);
  forceKillTimer.unref();
};

interface NumstatEntry {
  additions: number;
  deletions: number;
  isBinary: boolean;
}

interface ConflictStageEntry {
  mode: string;
  objectId: string;
  stage: 0 | 1 | 2 | 3;
}

interface PreparedConflictFile {
  file: RunConflictFile;
  stages: ConflictStageEntry[];
}

interface PreparedCommitComparison {
  repositoryPath: string;
  targetBranch: string;
  targetCommit: string | null;
  changedPaths: string[];
}

const maxEditableConflictBytes = 750_000;

const hasUnresolvedConflictMarkers = (content: string): boolean =>
  content.split(/\r?\n/).some((line) => /^(?:<{7}|={7}|>{7})(?: .*)?$/.test(line));

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
  const tokens = stdout
    .split("\0")
    .filter((_, idx, arr) => idx < arr.length - 1 || arr[idx] !== "");
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

  private async executeForRun(
    argumentsList: string[],
    execution: GitExecutionOptions,
    options: { env?: NodeJS.ProcessEnv; reject?: boolean } = {},
  ) {
    execution.signal?.throwIfAborted();
    const managed = Boolean(execution.signal || execution.onProcessGroupId);
    const subprocess = execa(this.executable, argumentsList, {
      ...options,
      ...(managed ? { detached: true } : {}),
      ...(execution.signal
        ? {
            cancelSignal: execution.signal,
            forceKillAfterDelay: 5_000,
          }
        : {}),
    });
    const processGroupId = managed ? (subprocess.pid ?? null) : null;
    const terminate = () => {
      if (processGroupId !== null) {
        terminateProcessGroup(processGroupId);
      }
    };
    if (processGroupId !== null) {
      try {
        execution.onProcessGroupId?.(processGroupId);
      } catch (error) {
        terminate();
        void subprocess.catch(() => undefined);
        throw error;
      }
      execution.signal?.addEventListener("abort", terminate, { once: true });
    }
    try {
      const result = await subprocess;
      if (result.isCanceled) {
        throw new DOMException("Git execution cancelled", "AbortError");
      }
      return result;
    } catch (error) {
      if (execution.signal?.aborted) {
        throw new DOMException("Git execution cancelled", "AbortError");
      }
      throw error;
    } finally {
      execution.signal?.removeEventListener("abort", terminate);
      if (processGroupId !== null) {
        execution.onProcessGroupId?.(null);
      }
    }
  }

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
    let repositoryPath: string;
    try {
      repositoryPath = await realpath(inputPath);
    } catch {
      throw new GitApplyError("INVALID_REPOSITORY", "所选目录不存在或无法访问。");
    }
    const [topLevel, branch, headCommit] = await Promise.all([
      execa(this.executable, ["-C", repositoryPath, "rev-parse", "--show-toplevel"], {
        reject: false,
      }),
      execa(this.executable, ["-C", repositoryPath, "branch", "--show-current"], {
        reject: false,
      }),
      execa(this.executable, ["-C", repositoryPath, "rev-parse", "HEAD"], { reject: false }),
    ]);
    if (topLevel.exitCode !== 0 || headCommit.exitCode !== 0) {
      throw new GitApplyError("INVALID_REPOSITORY", "所选目录不是可用的 Git 仓库。");
    }

    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(topLevel.stdout.trim());
    } catch {
      throw new GitApplyError("INVALID_REPOSITORY", "无法读取 Git 仓库根目录。");
    }
    if (repositoryRoot !== repositoryPath) {
      throw new GitApplyError("REPOSITORY_NOT_ROOT", "请选择 Git 仓库根目录，而不是其子目录。");
    }
    if (branch.exitCode !== 0 || !branch.stdout.trim()) {
      throw new GitApplyError("DETACHED_HEAD", "本地项目处于 detached HEAD，请先切换到分支。");
    }

    return {
      path: repositoryPath,
      branch: branch.stdout.trim(),
      headCommit: headCommit.stdout.trim(),
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

  async validateBranchName(branch: string, execution: GitExecutionOptions = {}): Promise<string> {
    const candidate = branch.trim();
    if (candidate === "HEAD" || candidate.startsWith("refs/")) {
      throw new GitApplyError(
        "INVALID_BRANCH",
        "分支只填写实际分支名，不要使用 HEAD 或 refs/heads/ 前缀。",
      );
    }
    const result = await this.executeForRun(
      ["check-ref-format", "--branch", candidate],
      execution,
      { reject: false },
    );
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

  async fetchRepository(
    repositoryPath: string,
    execution: GitExecutionOptions = {},
  ): Promise<void> {
    execution.signal?.throwIfAborted();
    const resolvedPath = await realpath(repositoryPath);
    const fetch = await this.executeForRun(
      ["-C", resolvedPath, "fetch", "--prune", "origin"],
      execution,
      { env: this.nonInteractiveEnvironment(), reject: false },
    );
    if (fetch.exitCode !== 0) {
      throw new GitApplyError(
        "REMOTE_ACCESS_FAILED",
        `远程仓库同步失败：${fetch.stderr.trim() || fetch.stdout.trim() || "Git 命令执行失败"}`,
      );
    }
  }

  async resolveRemoteTargetBase(input: ResolveRemoteTargetBaseInput): Promise<ResolvedTargetBase> {
    input.signal?.throwIfAborted();
    const repositoryPath = await realpath(input.repositoryPath);
    const targetBranch = await this.validateBranchName(input.targetBranch, input);
    const fallbackRef = await this.validateBranchName(input.fallbackRef, input);
    const branchCommit = await this.resolveRemoteBranch(repositoryPath, targetBranch, input);
    if (branchCommit) {
      return { targetBranch, baseCommit: branchCommit, branchExists: true };
    }
    const fallbackCommit = await this.resolveRemoteBranch(repositoryPath, fallbackRef, input);
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
      execa(
        this.executable,
        ["-C", repositoryPath, "cat-file", "-e", `${input.baseCommit}^{commit}`],
        {
          reject: false,
        },
      ),
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
      [
        "-C",
        repositoryPath,
        "push",
        "--porcelain",
        "origin",
        `${input.resultCommit}:refs/heads/${targetBranch}`,
      ],
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
    input.signal?.throwIfAborted();
    const repositoryPath = await realpath(input.repositoryPath);
    const targetBranch = await this.normalizeBranchName(repositoryPath, input.targetBranch, input);
    const branchCommit = await this.resolveLocalBranch(repositoryPath, targetBranch, input);
    if (branchCommit) {
      return { targetBranch, baseCommit: branchCommit, branchExists: true };
    }

    const fallback = await this.executeForRun(
      ["-C", repositoryPath, "rev-parse", "--verify", `${input.fallbackRef}^{commit}`],
      input,
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
    input.signal?.throwIfAborted();
    const repositoryPath = await realpath(input.repositoryPath);
    input.signal?.throwIfAborted();
    await mkdir(dirname(input.worktreePath), { recursive: true });
    input.signal?.throwIfAborted();
    if (await pathExists(input.worktreePath)) {
      throw new Error("目标 Worktree 路径已经存在");
    }

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

  async commitWorktree(input: CommitWorktreeInput): Promise<string> {
    input.signal?.throwIfAborted();
    const worktreePath = await realpath(input.worktreePath);
    const { stdout: status } = await this.executeForRun(
      ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"],
      input,
    );
    if (status.trim()) {
      await this.executeForRun(["-C", worktreePath, "add", "--all"], input);
      // 用 core.hooksPath=/dev/null 屏蔽目标仓库的所有 Git 钩子。DevLoop 在 Worktree 中提交的
      // 是 agent 执行结果，目标仓库的钩子（例如 simple-git-hooks 触发的 pnpm install）在
      // Worktree 环境下常常无法正确工作（.git 是文件而不是目录），且这些校验已经在开发者
      // 本地 / CI 层执行过，DevLoop 不需要再拦一次。
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
    if (currentCommit.trim() !== input.expectedCommit) {
      throw new GitApplyError(
        "TARGET_BRANCH_CHANGED",
        "Run Worktree 的结果 Commit 已发生变化，拒绝覆盖 Codex 结果。",
      );
    }
    if (status.trim()) {
      throw new GitApplyError(
        "WORKTREE_DIRTY",
        "Run Worktree 在冲突解决后出现未提交修改，拒绝切换到已解决结果。",
      );
    }
    if (targetCheck.exitCode !== 0) {
      throw new GitApplyError("RESULT_COMMIT_MISSING", "自动解决后的结果 Commit 已不存在。");
    }
    await execa(this.executable, ["-C", worktreePath, "reset", "--hard", input.targetCommit]);
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

  async previewCommitConflicts(input: ApplyCommitInput): Promise<RunConflictPreview> {
    const prepared = await this.prepareApplication(input);
    return this.previewPreparedCommitConflicts(prepared, input.baseCommit, input.resultCommit);
  }

  async generateConflictResolutions(
    input: ApplyCommitInput,
    resolver: (workspace: ConflictResolutionWorkspace) => Promise<void>,
  ): Promise<GeneratedConflictResolutions> {
    const { repositoryPath, targetCommit } = await this.prepareApplication(input);
    if (!targetCommit) {
      throw new GitApplyError("APPLY_CONFLICT", "目标分支尚不存在，不需要解决写入冲突。");
    }

    return this.generatePreparedConflictResolutions(
      repositoryPath,
      targetCommit,
      input.baseCommit,
      input.resultCommit,
      resolver,
    );
  }

  async reconcileCommitConflicts(
    input: ReconcileCommitInput,
    resolver: (workspace: ConflictResolutionWorkspace) => Promise<void>,
  ): Promise<ReconcileCommitResult> {
    const prepared = await this.prepareReconciliation(input);
    const preview = await this.previewPreparedCommitConflicts(
      prepared,
      input.baseCommit,
      input.resultCommit,
    );
    if (preview.status !== "conflicted") {
      const resultCommit = await this.reconcileCleanCommit(
        prepared,
        input.baseCommit,
        input.resultCommit,
      );
      return {
        status: "clean",
        targetCommit: input.targetCommit,
        resultCommit,
        resolutions: [],
      };
    }

    const generated = await this.generatePreparedConflictResolutions(
      prepared.repositoryPath,
      input.targetCommit,
      input.baseCommit,
      input.resultCommit,
      resolver,
    );
    const resultCommit = await this.createPatchedCommit(
      prepared.repositoryPath,
      input.targetCommit,
      input.baseCommit,
      input.resultCommit,
      generated.resolutions,
    );
    return {
      status: "resolved",
      targetCommit: input.targetCommit,
      resultCommit,
      resolutions: generated.resolutions,
    };
  }

  private async reconcileCleanCommit(
    prepared: PreparedCommitComparison & { targetCommit: string },
    baseCommit: string,
    resultCommit: string,
  ): Promise<string> {
    const { repositoryPath, targetCommit, changedPaths } = prepared;
    if (changedPaths.length === 0) {
      return targetCommit;
    }
    if (await this.isAncestor(repositoryPath, targetCommit, resultCommit)) {
      return resultCommit;
    }
    if (
      (await this.isAncestor(repositoryPath, resultCommit, targetCommit)) ||
      (await this.hasAppliedResultMarker(repositoryPath, targetCommit, resultCommit)) ||
      (await this.pathsMatchCommit(repositoryPath, targetCommit, resultCommit, changedPaths))
    ) {
      return targetCommit;
    }
    return this.createPatchedCommit(repositoryPath, targetCommit, baseCommit, resultCommit, []);
  }

  async applyCommitToWorkingTree(input: ApplyCommitInput): Promise<RunApplicationResult> {
    const { repositoryPath, targetBranch, targetCommit, changedPaths } =
      await this.prepareApplication(input);
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
        input.conflictResolutions ?? [],
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

  private async prepareApplication(input: ApplyCommitInput): Promise<{
    repositoryPath: string;
    targetBranch: string;
    targetCommit: string | null;
    changedPaths: string[];
  }> {
    const prepared = await this.prepareCommitRange(input);
    const targetCommit = await this.resolveLocalBranch(
      prepared.repositoryPath,
      prepared.targetBranch,
    );
    if (input.expectedTargetCommit !== undefined && input.expectedTargetCommit !== targetCommit) {
      throw new GitApplyError(
        "TARGET_BRANCH_CHANGED",
        `目标分支 ${prepared.targetBranch} 已发生变化，请刷新冲突内容后重新处理。`,
      );
    }
    return { ...prepared, targetCommit };
  }

  private async prepareReconciliation(
    input: ReconcileCommitInput,
  ): Promise<PreparedCommitComparison & { targetCommit: string }> {
    const prepared = await this.prepareCommitRange(input);
    const targetCheck = await execa(
      this.executable,
      ["-C", prepared.repositoryPath, "cat-file", "-e", `${input.targetCommit}^{commit}`],
      { reject: false },
    );
    if (targetCheck.exitCode !== 0) {
      throw new GitApplyError(
        "TARGET_COMMIT_MISSING",
        `目标分支 ${prepared.targetBranch} 的最新 Commit 已不存在。`,
      );
    }
    return { ...prepared, targetCommit: input.targetCommit };
  }

  private async prepareCommitRange(input: {
    repositoryPath: string;
    targetBranch: string;
    baseCommit: string;
    resultCommit: string;
  }): Promise<Omit<PreparedCommitComparison, "targetCommit">> {
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

    const changedPaths = await this.getChangedPaths(
      repositoryPath,
      input.baseCommit,
      input.resultCommit,
    );
    return { repositoryPath, targetBranch, changedPaths };
  }

  private async previewPreparedCommitConflicts(
    prepared: PreparedCommitComparison,
    baseCommit: string,
    resultCommit: string,
  ): Promise<RunConflictPreview> {
    const { repositoryPath, targetBranch, targetCommit, changedPaths } = prepared;
    const cleanPreview = (): RunConflictPreview => ({
      status: "clean",
      targetBranch,
      targetCommit,
      files: [],
      message: null,
    });

    if (!targetCommit || changedPaths.length === 0) {
      return cleanPreview();
    }
    if (
      (await this.isAncestor(repositoryPath, targetCommit, resultCommit)) ||
      (await this.isAncestor(repositoryPath, resultCommit, targetCommit)) ||
      (await this.hasAppliedResultMarker(repositoryPath, targetCommit, resultCommit)) ||
      (await this.pathsMatchCommit(repositoryPath, targetCommit, resultCommit, changedPaths))
    ) {
      return cleanPreview();
    }

    const files = await this.previewPatchedCommitConflicts(
      repositoryPath,
      targetCommit,
      baseCommit,
      resultCommit,
    );
    if (files.length === 0) {
      return cleanPreview();
    }
    return {
      status: "conflicted",
      targetBranch,
      targetCommit,
      files,
      message: `本次结果与目标分支 ${targetBranch} 存在 ${files.length} 个冲突文件。`,
    };
  }

  private async generatePreparedConflictResolutions(
    repositoryPath: string,
    targetCommit: string,
    baseCommit: string,
    resultCommit: string,
    resolver: (workspace: ConflictResolutionWorkspace) => Promise<void>,
  ): Promise<GeneratedConflictResolutions> {
    return this.withPatchedConflictWorktree(
      repositoryPath,
      targetCommit,
      baseCommit,
      resultCommit,
      async ({ worktreePath, files }) => {
        if (files.length === 0) {
          throw new GitApplyError("APPLY_CONFLICT", "当前目标分支与本次结果已经不存在冲突。");
        }
        if (files.length > 100) {
          throw new GitApplyError(
            "APPLY_CONFLICT",
            `冲突文件数量为 ${files.length}，超过单次 Agent 解决上限 100 个。`,
          );
        }
        await resolver({
          worktreePath,
          files: files.map((item) => item.file),
        });

        await this.stageConflictResolutions(worktreePath, files);

        const remainingPaths = await this.getUnmergedPaths(worktreePath);
        if (remainingPaths.length > 0) {
          throw new GitApplyError(
            "APPLY_CONFLICT",
            `Agent 完成后仍有 ${remainingPaths.length} 个冲突文件未解决：${remainingPaths.join("、")}`,
          );
        }

        const resolutions = await Promise.all(
          files.map((file) => this.collectConflictResolution(worktreePath, file)),
        );
        const contentLength = resolutions.reduce(
          (total, resolution) =>
            total + (resolution.strategy === "content" ? resolution.content.length : 0),
          0,
        );
        if (contentLength > 900_000) {
          throw new GitApplyError(
            "APPLY_CONFLICT",
            "Agent 生成的冲突解决内容超过 900000 个字符，请改为人工分批处理。",
          );
        }
        return { targetCommit, resolutions };
      },
    );
  }

  private async stageConflictResolutions(
    worktreePath: string,
    files: PreparedConflictFile[],
  ): Promise<void> {
    const stage = await execa(
      this.executable,
      ["-C", worktreePath, "add", "-A", "--", ...files.map((item) => item.file.path)],
      { reject: false },
    );
    if (stage.exitCode !== 0) {
      const message = stage.stderr.trim() || stage.stdout.trim() || "Git 暂存失败";
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `DevLoop 无法暂存 Agent 解决的冲突文件：${message}`,
      );
    }
  }

  private async previewPatchedCommitConflicts(
    repositoryPath: string,
    targetCommit: string,
    baseCommit: string,
    resultCommit: string,
  ): Promise<RunConflictFile[]> {
    return this.withPatchedConflictWorktree(
      repositoryPath,
      targetCommit,
      baseCommit,
      resultCommit,
      async ({ files }) => files.map((item) => item.file),
    );
  }

  private async withPatchedConflictWorktree<T>(
    repositoryPath: string,
    targetCommit: string,
    baseCommit: string,
    resultCommit: string,
    callback: (workspace: { worktreePath: string; files: PreparedConflictFile[] }) => Promise<T>,
  ): Promise<T> {
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
    const temporaryRoot = await mkdtemp(join(tmpdir(), "devloop-conflict-preview-"));
    const temporaryWorktree = join(temporaryRoot, "worktree");
    let worktreeCreated = false;
    try {
      const addWorktree = await execa(
        this.executable,
        ["-C", repositoryPath, "worktree", "add", "--detach", temporaryWorktree, targetCommit],
        { reject: false },
      );
      if (addWorktree.exitCode !== 0) {
        throw new GitApplyError(
          "APPLY_FAILED",
          `无法创建冲突预检目录：${addWorktree.stderr.trim() || addWorktree.stdout.trim()}`,
        );
      }
      worktreeCreated = true;

      const apply = await execa(
        this.executable,
        ["-C", temporaryWorktree, "apply", "--3way", "--index", "--whitespace=nowarn", "-"],
        { input: patch, reject: false },
      );
      if (apply.exitCode === 0) {
        return await callback({ worktreePath: temporaryWorktree, files: [] });
      }

      const conflictPaths = await this.getUnmergedPaths(temporaryWorktree);
      if (conflictPaths.length === 0) {
        const message = apply.stderr.trim() || apply.stdout.trim() || "Git 三方应用失败";
        throw new GitApplyError("APPLY_FAILED", `无法生成冲突预览：${message}`);
      }

      const files = await Promise.all(
        conflictPaths.map(async (path) => {
          const [{ stdout: conflictPatch }, { stdout: numstatOutput }, stages] = await Promise.all([
            execa(
              this.executable,
              ["-C", temporaryWorktree, "diff", "--cc", "--no-color", "--no-ext-diff", "--", path],
              { stripFinalNewline: false },
            ),
            execa(this.executable, [
              "-C",
              repositoryPath,
              "diff",
              "--numstat",
              "-z",
              targetCommit,
              resultCommit,
              "--",
              path,
            ]),
            this.getConflictStages(temporaryWorktree, path),
          ]);
          const isBinary =
            Array.from(parseNumstatZ(numstatOutput).values()).some((entry) => entry.isBinary) ||
            conflictPatch.includes("Binary files");
          let content: string | null = null;
          const editableStages = stages.filter((entry) => entry.stage === 2 || entry.stage === 3);
          const hasOnlyRegularFiles = editableStages.every((entry) => entry.mode.startsWith("100"));
          if (!isBinary && hasOnlyRegularFiles) {
            const fileContent = await readFile(join(temporaryWorktree, path)).catch(() => null);
            if (fileContent && fileContent.byteLength <= maxEditableConflictBytes) {
              content = fileContent.toString("utf8");
            }
          }
          return {
            file: {
              path,
              patch: conflictPatch,
              isBinary,
              content,
              targetExists: stages.some((entry) => entry.stage === 2),
              resultExists: stages.some((entry) => entry.stage === 3),
            },
            stages,
          };
        }),
      );
      return await callback({ worktreePath: temporaryWorktree, files });
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

  private async collectConflictResolution(
    worktreePath: string,
    conflict: PreparedConflictFile,
  ): Promise<RunConflictResolution> {
    const path = conflict.file.path;
    const indexEntry = await this.getResolvedIndexEntry(worktreePath, path);
    const targetStage = conflict.stages.find((entry) => entry.stage === 2);
    const resultStage = conflict.stages.find((entry) => entry.stage === 3);

    if (!indexEntry) {
      if (await pathExists(join(worktreePath, path))) {
        throw new GitApplyError("APPLY_CONFLICT", `Agent 未暂存冲突文件 ${path}。`);
      }
      if (!targetStage && resultStage) return { path, strategy: "target" };
      if (!resultStage && targetStage) return { path, strategy: "result" };
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `Agent 删除了冲突文件 ${path}，但该删除无法映射到目标分支侧或本次结果侧。`,
      );
    }

    const worktreeDiff = await execa(
      this.executable,
      ["-C", worktreePath, "diff", "--quiet", "--", path],
      { reject: false },
    );
    if (worktreeDiff.exitCode !== 0) {
      throw new GitApplyError("APPLY_CONFLICT", `Agent 暂存后又修改了冲突文件 ${path}。`);
    }

    if (targetStage && this.indexEntriesMatch(indexEntry, targetStage)) {
      return { path, strategy: "target" };
    }
    if (resultStage && this.indexEntriesMatch(indexEntry, resultStage)) {
      return { path, strategy: "result" };
    }

    if (conflict.file.isBinary || !indexEntry.mode.startsWith("100")) {
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `Agent 对二进制或特殊文件 ${path} 生成了新的内容，只允许选择目标分支侧或本次结果侧。`,
      );
    }
    const stat = await lstat(join(worktreePath, path)).catch(() => null);
    if (!stat?.isFile() || stat.size > maxEditableConflictBytes) {
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `Agent 解决后的文件 ${path} 无法作为文本内容交给人工审核。`,
      );
    }
    const content = await readFile(join(worktreePath, path), "utf8");
    if (hasUnresolvedConflictMarkers(content)) {
      throw new GitApplyError("APPLY_CONFLICT", `Agent 解决后的文件 ${path} 仍包含冲突标记。`);
    }
    return { path, strategy: "content", content };
  }

  private indexEntriesMatch(left: ConflictStageEntry, right: ConflictStageEntry): boolean {
    return left.mode === right.mode && left.objectId === right.objectId;
  }

  private async getResolvedIndexEntry(
    worktreePath: string,
    path: string,
  ): Promise<ConflictStageEntry | null> {
    const { stdout } = await execa(this.executable, [
      "-C",
      worktreePath,
      "ls-files",
      "--stage",
      "-z",
      "--",
      path,
    ]);
    return this.parseIndexEntries(stdout).find((entry) => entry.stage === 0) ?? null;
  }

  private async createPatchedCommit(
    repositoryPath: string,
    previousCommit: string,
    baseCommit: string,
    resultCommit: string,
    conflictResolutions: RunConflictResolution[],
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
        const conflictPaths = await this.getUnmergedPaths(temporaryWorktree);
        if (conflictPaths.length === 0) {
          throw new GitApplyError(
            "APPLY_CONFLICT",
            `本次结果与目标分支文件存在冲突，未写入目标分支：${message}`,
          );
        }
        await this.applyConflictResolutions(temporaryWorktree, conflictPaths, conflictResolutions);
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
          "--allow-empty",
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

  private async applyConflictResolutions(
    worktreePath: string,
    conflictPaths: string[],
    resolutions: RunConflictResolution[],
  ): Promise<void> {
    const resolutionByPath = new Map<string, RunConflictResolution>();
    for (const resolution of resolutions) {
      if (resolutionByPath.has(resolution.path)) {
        throw new GitApplyError(
          "APPLY_CONFLICT",
          `冲突文件 ${resolution.path} 提交了重复的解决结果。`,
        );
      }
      resolutionByPath.set(resolution.path, resolution);
    }

    const conflictPathSet = new Set(conflictPaths);
    const unexpectedPaths = resolutions
      .map((resolution) => resolution.path)
      .filter((path) => !conflictPathSet.has(path));
    if (unexpectedPaths.length > 0) {
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `冲突文件已经变化，请刷新后重新处理：${unexpectedPaths.join("、")}`,
      );
    }
    const unresolvedPaths = conflictPaths.filter((path) => !resolutionByPath.has(path));
    if (unresolvedPaths.length > 0) {
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `仍有 ${unresolvedPaths.length} 个冲突文件未解决：${unresolvedPaths.join("、")}`,
      );
    }

    for (const path of conflictPaths) {
      const resolution = resolutionByPath.get(path);
      if (!resolution) continue;
      const stages = await this.getConflictStages(worktreePath, path);
      if (resolution.strategy === "content") {
        if (hasUnresolvedConflictMarkers(resolution.content)) {
          throw new GitApplyError("APPLY_CONFLICT", `冲突文件 ${path} 仍包含未解决的冲突标记。`);
        }
        const mode =
          stages.find((entry) => entry.stage === 3)?.mode ??
          stages.find((entry) => entry.stage === 2)?.mode ??
          stages.find((entry) => entry.stage === 1)?.mode;
        if (!mode) {
          throw new GitApplyError("APPLY_CONFLICT", `无法确定冲突文件 ${path} 的文件类型。`);
        }
        const { stdout: objectId } = await execa(
          this.executable,
          ["-C", worktreePath, "hash-object", "-w", "--stdin"],
          { input: resolution.content },
        );
        await execa(this.executable, [
          "-C",
          worktreePath,
          "update-index",
          "--add",
          "--cacheinfo",
          mode,
          objectId.trim(),
          path,
        ]);
        continue;
      }

      const stageNumber = resolution.strategy === "target" ? 2 : 3;
      const selectedStage = stages.find((entry) => entry.stage === stageNumber);
      if (!selectedStage) {
        await execa(this.executable, [
          "-C",
          worktreePath,
          "update-index",
          "--force-remove",
          "--",
          path,
        ]);
        continue;
      }
      await execa(this.executable, [
        "-C",
        worktreePath,
        "update-index",
        "--add",
        "--cacheinfo",
        selectedStage.mode,
        selectedStage.objectId,
        path,
      ]);
    }

    const remainingPaths = await this.getUnmergedPaths(worktreePath);
    if (remainingPaths.length > 0) {
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `仍有 ${remainingPaths.length} 个冲突文件未解决：${remainingPaths.join("、")}`,
      );
    }
  }

  private async getUnmergedPaths(worktreePath: string): Promise<string[]> {
    const { stdout } = await execa(this.executable, [
      "-C",
      worktreePath,
      "diff",
      "--name-only",
      "--diff-filter=U",
      "-z",
    ]);
    return stdout.split("\0").filter(Boolean);
  }

  private async getConflictStages(
    worktreePath: string,
    path: string,
  ): Promise<ConflictStageEntry[]> {
    const { stdout } = await execa(this.executable, [
      "-C",
      worktreePath,
      "ls-files",
      "-u",
      "-z",
      "--",
      path,
    ]);
    return this.parseIndexEntries(stdout).filter((entry) => entry.stage !== 0);
  }

  private parseIndexEntries(stdout: string): ConflictStageEntry[] {
    return stdout
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        const separatorIndex = entry.indexOf("\t");
        if (separatorIndex < 0) return [];
        const [mode = "", objectId = "", stageText = ""] = entry
          .slice(0, separatorIndex)
          .split(" ");
        const stage = Number(stageText);
        if (![0, 1, 2, 3].includes(stage) || !mode || !objectId) return [];
        return [{ mode, objectId, stage: stage as 0 | 1 | 2 | 3 }];
      });
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

  private async normalizeBranchName(
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

  private async resolveLocalBranch(
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

  private async resolveRemoteBranch(
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
