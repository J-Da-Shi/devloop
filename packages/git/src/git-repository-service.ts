import { mkdir, mkdtemp, rename, rm, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { GitBaseService, pathExists } from "./git-base-service.js";
import type {
  CloneRepositoryInput,
  ClonedRepositoryInfo,
  GitCapabilities,
  GitExecutionOptions,
  GitRepositoryInfo,
  PushResultInput,
  ResolveRemoteTargetBaseInput,
  ResolveTargetBaseInput,
  ResolvedTargetBase,
} from "./git-types.js";
import { GitApplyError } from "./git-types.js";

export class GitRepositoryService extends GitBaseService {
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
    const repositoryPath = await this.realRepositoryPath(inputPath);
    const [topLevel, branch, headCommit] = await Promise.all([
      execa(this.executable, ["-C", repositoryPath, "rev-parse", "--show-toplevel"], {
        reject: false,
      }),
      execa(this.executable, ["-C", repositoryPath, "branch", "--show-current"], { reject: false }),
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
      if (!url.hostname || url.password || !url.pathname || url.pathname === "/") {
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
    const path = match.groups.path.replace(/\/+$/, "");
    if (!path || path.startsWith(":")) {
      throw new GitApplyError("INVALID_REPOSITORY_URL", "SSH Git 仓库路径不能为空。");
    }
    return `${match.groups.user ? `${match.groups.user}@` : ""}${match.groups.host.toLowerCase()}:${path}`;
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
        {
          env: this.nonInteractiveEnvironment(),
          reject: false,
        },
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
      if (!resolved.branchExists)
        throw new GitApplyError(
          "BASE_COMMIT_MISSING",
          `远程仓库中不存在默认分支 ${defaultBranch}。`,
        );
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
      {
        env: this.nonInteractiveEnvironment(),
        reject: false,
      },
    );
    if (fetch.exitCode !== 0)
      throw new GitApplyError(
        "REMOTE_ACCESS_FAILED",
        `远程仓库同步失败：${fetch.stderr.trim() || fetch.stdout.trim() || "Git 命令执行失败"}`,
      );
  }

  async resolveRemoteTargetBase(input: ResolveRemoteTargetBaseInput): Promise<ResolvedTargetBase> {
    input.signal?.throwIfAborted();
    const repositoryPath = await realpath(input.repositoryPath);
    const targetBranch = await this.validateBranchName(input.targetBranch, input);
    const fallbackRef = await this.validateBranchName(input.fallbackRef, input);
    const branchCommit = await this.resolveRemoteBranch(repositoryPath, targetBranch, input);
    if (branchCommit) return { targetBranch, baseCommit: branchCommit, branchExists: true };
    const fallbackCommit = await this.resolveRemoteBranch(repositoryPath, fallbackRef, input);
    if (!fallbackCommit)
      throw new GitApplyError(
        "BASE_COMMIT_MISSING",
        `目标分支 ${targetBranch} 不存在，且远程默认分支 ${fallbackRef} 无法解析。`,
      );
    return { targetBranch, baseCommit: fallbackCommit, branchExists: false };
  }

  async pushResult(input: PushResultInput): Promise<import("./git-types.js").RunPublishResult> {
    const repositoryPath = await realpath(input.repositoryPath);
    const targetBranch = await this.validateBranchName(input.targetBranch);
    await this.fetchRepository(repositoryPath);
    const [baseCheck, resultCheck] = await Promise.all([
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
    if (baseCheck.exitCode !== 0)
      throw new GitApplyError("BASE_COMMIT_MISSING", "本次运行的基础 Commit 已不存在。");
    if (resultCheck.exitCode !== 0)
      throw new GitApplyError("RESULT_COMMIT_MISSING", "本次运行的结果 Commit 已不存在。");
    if (!(await this.isAncestor(repositoryPath, input.baseCommit, input.resultCommit)))
      throw new GitApplyError(
        "INVALID_RESULT_RANGE",
        "结果 Commit 不是从本次运行的基础 Commit 产生，拒绝推送。",
      );
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
    if (remoteCommit && remoteCommit !== input.baseCommit)
      throw new GitApplyError(
        "REMOTE_PUSH_REJECTED",
        `远程目标分支 ${targetBranch} 已从执行基线前进，DevLoop 不会强制覆盖。`,
      );
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
    if (push.exitCode !== 0)
      throw new GitApplyError(
        "REMOTE_PUSH_REJECTED",
        `远程分支推送失败：${push.stderr.trim() || push.stdout.trim() || "远程拒绝更新"}`,
      );
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
    if (branchCommit) return { targetBranch, baseCommit: branchCommit, branchExists: true };
    const fallback = await this.executeForRun(
      ["-C", repositoryPath, "rev-parse", "--verify", `${input.fallbackRef}^{commit}`],
      input,
      { reject: false },
    );
    if (fallback.exitCode !== 0)
      throw new GitApplyError(
        "BASE_COMMIT_MISSING",
        `目标分支 ${targetBranch} 不存在，且默认基线 ${input.fallbackRef} 无法解析。`,
      );
    return { targetBranch, baseCommit: fallback.stdout.trim(), branchExists: false };
  }
}
