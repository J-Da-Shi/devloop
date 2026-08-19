import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { GitWorktreeService } from "./git-worktree-service.js";
import {
  hasUnresolvedConflictMarkers,
  maxEditableConflictBytes,
  parseNumstatZ,
  pathExists,
  type ConflictStageEntry,
  type PreparedCommitComparison,
  type PreparedConflictFile,
} from "./git-base-service.js";
import type {
  ApplyCommitInput,
  ConflictResolutionWorkspace,
  GeneratedConflictResolutions,
  ReconcileCommitInput,
  ReconcileCommitResult,
  RunConflictResolution,
  RunConflictFile,
  RunConflictPreview,
} from "./git-types.js";
import { GitApplyError } from "./git-types.js";

export abstract class GitConflictPreviewService extends GitWorktreeService {
  async previewCommitConflicts(input: ApplyCommitInput): Promise<RunConflictPreview> {
    const prepared = await this.prepareApplication(input);
    return this.previewPreparedCommitConflicts(prepared, input.baseCommit, input.resultCommit);
  }

  async generateConflictResolutions(
    input: ApplyCommitInput,
    resolver: (workspace: ConflictResolutionWorkspace) => Promise<void>,
  ): Promise<GeneratedConflictResolutions> {
    const { repositoryPath, targetCommit } = await this.prepareApplication(input);
    if (!targetCommit)
      throw new GitApplyError("APPLY_CONFLICT", "目标分支尚不存在，不需要解决写入冲突。");
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
      return { status: "clean", targetCommit: input.targetCommit, resultCommit, resolutions: [] };
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

  protected async prepareApplication(input: ApplyCommitInput): Promise<PreparedCommitComparison> {
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

  protected async prepareReconciliation(
    input: ReconcileCommitInput,
  ): Promise<PreparedCommitComparison & { targetCommit: string }> {
    const prepared = await this.prepareCommitRange(input);
    const targetCheck = await execa(
      this.executable,
      ["-C", prepared.repositoryPath, "cat-file", "-e", `${input.targetCommit}^{commit}`],
      { reject: false },
    );
    if (targetCheck.exitCode !== 0)
      throw new GitApplyError(
        "TARGET_COMMIT_MISSING",
        `目标分支 ${prepared.targetBranch} 的最新 Commit 已不存在。`,
      );
    return { ...prepared, targetCommit: input.targetCommit };
  }

  protected async prepareCommitRange(input: {
    repositoryPath: string;
    targetBranch: string;
    baseCommit: string;
    resultCommit: string;
  }): Promise<Omit<PreparedCommitComparison, "targetCommit">> {
    const repositoryPath = await this.realRepositoryPath(input.repositoryPath);
    const targetBranch = await this.normalizeBranchName(repositoryPath, input.targetBranch);
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
      throw new GitApplyError(
        "BASE_COMMIT_MISSING",
        "本次运行的基础 Commit 在当前项目中不存在，无法计算需要写回的文件。",
      );
    if (resultCheck.exitCode !== 0)
      throw new GitApplyError(
        "RESULT_COMMIT_MISSING",
        "结果 Commit 在当前项目中不存在，无法应用到工作目录。",
      );
    if (!(await this.isAncestor(repositoryPath, input.baseCommit, input.resultCommit)))
      throw new GitApplyError(
        "INVALID_RESULT_RANGE",
        "结果 Commit 不是从本次运行的基础 Commit 产生，无法安全写回。",
      );
    return {
      repositoryPath,
      targetBranch,
      changedPaths: await this.getChangedPaths(
        repositoryPath,
        input.baseCommit,
        input.resultCommit,
      ),
    };
  }

  protected async previewPreparedCommitConflicts(
    prepared: PreparedCommitComparison,
    baseCommit: string,
    resultCommit: string,
  ): Promise<RunConflictPreview> {
    const { repositoryPath, targetBranch, targetCommit, changedPaths } = prepared;
    const clean = (): RunConflictPreview => ({
      status: "clean",
      targetBranch,
      targetCommit,
      files: [],
      message: null,
    });
    if (!targetCommit || changedPaths.length === 0) return clean();
    if (
      (await this.isAncestor(repositoryPath, targetCommit, resultCommit)) ||
      (await this.isAncestor(repositoryPath, resultCommit, targetCommit)) ||
      (await this.hasAppliedResultMarker(repositoryPath, targetCommit, resultCommit)) ||
      (await this.pathsMatchCommit(repositoryPath, targetCommit, resultCommit, changedPaths))
    )
      return clean();
    const files = await this.previewPatchedCommitConflicts(
      repositoryPath,
      targetCommit,
      baseCommit,
      resultCommit,
    );
    if (files.length === 0) return clean();
    return {
      status: "conflicted",
      targetBranch,
      targetCommit,
      files,
      message: `本次结果与目标分支 ${targetBranch} 存在 ${files.length} 个冲突文件。`,
    };
  }

  protected async generatePreparedConflictResolutions(
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
        if (files.length === 0)
          throw new GitApplyError("APPLY_CONFLICT", "当前目标分支与本次结果已经不存在冲突。");
        if (files.length > 100)
          throw new GitApplyError(
            "APPLY_CONFLICT",
            `冲突文件数量为 ${files.length}，超过单次 Agent 解决上限 100 个。`,
          );
        await resolver({ worktreePath, files: files.map((item) => item.file) });
        await this.stageConflictResolutions(worktreePath, files);
        const remainingPaths = await this.getUnmergedPaths(worktreePath);
        if (remainingPaths.length > 0)
          throw new GitApplyError(
            "APPLY_CONFLICT",
            `Agent 完成后仍有 ${remainingPaths.length} 个冲突文件未解决：${remainingPaths.join("、")}`,
          );
        const resolutions = await Promise.all(
          files.map((file) => this.collectConflictResolution(worktreePath, file)),
        );
        const contentLength = resolutions.reduce(
          (total, resolution) =>
            total + (resolution.strategy === "content" ? resolution.content.length : 0),
          0,
        );
        if (contentLength > 900_000)
          throw new GitApplyError(
            "APPLY_CONFLICT",
            "Agent 生成的冲突解决内容超过 900000 个字符，请改为人工分批处理。",
          );
        return { targetCommit, resolutions };
      },
    );
  }

  protected async previewPatchedCommitConflicts(
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

  protected async withPatchedConflictWorktree<T>(
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
    let created = false;
    try {
      const add = await execa(
        this.executable,
        ["-C", repositoryPath, "worktree", "add", "--detach", temporaryWorktree, targetCommit],
        { reject: false },
      );
      if (add.exitCode !== 0)
        throw new GitApplyError(
          "APPLY_FAILED",
          `无法创建冲突预检目录：${add.stderr.trim() || add.stdout.trim()}`,
        );
      created = true;
      const apply = await execa(
        this.executable,
        ["-C", temporaryWorktree, "apply", "--3way", "--index", "--whitespace=nowarn", "-"],
        { input: patch, reject: false },
      );
      if (apply.exitCode === 0)
        return await callback({ worktreePath: temporaryWorktree, files: [] });
      const conflictPaths = await this.getUnmergedPaths(temporaryWorktree);
      if (conflictPaths.length === 0)
        throw new GitApplyError(
          "APPLY_FAILED",
          `无法生成冲突预览：${apply.stderr.trim() || apply.stdout.trim() || "Git 三方应用失败"}`,
        );
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
          if (!isBinary && editableStages.every((entry) => entry.mode.startsWith("100"))) {
            const fileContent = await readFile(join(temporaryWorktree, path)).catch(() => null);
            if (fileContent && fileContent.byteLength <= maxEditableConflictBytes)
              content = fileContent.toString("utf8");
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
      await this.removeTemporaryWorktree(repositoryPath, temporaryRoot, temporaryWorktree, created);
    }
  }

  protected async stageConflictResolutions(
    worktreePath: string,
    files: PreparedConflictFile[],
  ): Promise<void> {
    const stage = await execa(
      this.executable,
      ["-C", worktreePath, "add", "-A", "--", ...files.map((item) => item.file.path)],
      { reject: false },
    );
    if (stage.exitCode !== 0)
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `DevLoop 无法暂存 Agent 解决的冲突文件：${stage.stderr.trim() || stage.stdout.trim() || "Git 暂存失败"}`,
      );
  }

  protected async collectConflictResolution(
    worktreePath: string,
    conflict: PreparedConflictFile,
  ): Promise<RunConflictResolution> {
    const path = conflict.file.path;
    const indexEntry = await this.getResolvedIndexEntry(worktreePath, path);
    const targetStage = conflict.stages.find((entry) => entry.stage === 2);
    const resultStage = conflict.stages.find((entry) => entry.stage === 3);
    if (!indexEntry) {
      if (await pathExists(join(worktreePath, path)))
        throw new GitApplyError("APPLY_CONFLICT", `Agent 未暂存冲突文件 ${path}。`);
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
    if (worktreeDiff.exitCode !== 0)
      throw new GitApplyError("APPLY_CONFLICT", `Agent 暂存后又修改了冲突文件 ${path}。`);
    if (targetStage && this.indexEntriesMatch(indexEntry, targetStage))
      return { path, strategy: "target" };
    if (resultStage && this.indexEntriesMatch(indexEntry, resultStage))
      return { path, strategy: "result" };
    if (conflict.file.isBinary || !indexEntry.mode.startsWith("100"))
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `Agent 对二进制或特殊文件 ${path} 生成了新的内容，只允许选择目标分支侧或本次结果侧。`,
      );
    const stat = await lstat(join(worktreePath, path)).catch(() => null);
    if (!stat?.isFile() || stat.size > maxEditableConflictBytes)
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `Agent 解决后的文件 ${path} 无法作为文本内容交给人工审核。`,
      );
    const content = await readFile(join(worktreePath, path), "utf8");
    if (hasUnresolvedConflictMarkers(content))
      throw new GitApplyError("APPLY_CONFLICT", `Agent 解决后的文件 ${path} 仍包含冲突标记。`);
    return { path, strategy: "content", content };
  }

  protected indexEntriesMatch(left: ConflictStageEntry, right: ConflictStageEntry): boolean {
    return left.mode === right.mode && left.objectId === right.objectId;
  }

  protected async getResolvedIndexEntry(
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

  protected async getUnmergedPaths(worktreePath: string): Promise<string[]> {
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

  protected async getConflictStages(
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

  protected parseIndexEntries(stdout: string): ConflictStageEntry[] {
    return stdout
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        const separator = entry.indexOf("\t");
        if (separator < 0) return [];
        const [mode = "", objectId = "", stageText = ""] = entry.slice(0, separator).split(" ");
        const stage = Number(stageText);
        if (![0, 1, 2, 3].includes(stage) || !mode || !objectId) return [];
        return [{ mode, objectId, stage: stage as 0 | 1 | 2 | 3 }];
      });
  }

  private async reconcileCleanCommit(
    prepared: PreparedCommitComparison & { targetCommit: string },
    baseCommit: string,
    resultCommit: string,
  ): Promise<string> {
    const { repositoryPath, targetCommit, changedPaths } = prepared;
    if (changedPaths.length === 0) return targetCommit;
    if (await this.isAncestor(repositoryPath, targetCommit, resultCommit)) return resultCommit;
    if (
      (await this.isAncestor(repositoryPath, resultCommit, targetCommit)) ||
      (await this.hasAppliedResultMarker(repositoryPath, targetCommit, resultCommit)) ||
      (await this.pathsMatchCommit(repositoryPath, targetCommit, resultCommit, changedPaths))
    )
      return targetCommit;
    return this.createPatchedCommit(repositoryPath, targetCommit, baseCommit, resultCommit, []);
  }

  protected abstract createPatchedCommit(
    repositoryPath: string,
    previousCommit: string,
    baseCommit: string,
    resultCommit: string,
    conflictResolutions: RunConflictResolution[],
  ): Promise<string>;
}
