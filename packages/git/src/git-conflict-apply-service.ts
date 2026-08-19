import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { GitConflictPreviewService } from "./git-conflict-preview-service.js";
import { hasUnresolvedConflictMarkers } from "./git-base-service.js";
import type { ApplyCommitInput, RunApplicationResult, RunConflictResolution } from "./git-types.js";
import { GitApplyError } from "./git-types.js";

export class GitConflictApplyService extends GitConflictPreviewService {
  async applyCommitToWorkingTree(input: ApplyCommitInput): Promise<RunApplicationResult> {
    const { repositoryPath, targetBranch, targetCommit, changedPaths } =
      await this.prepareApplication(input);
    const targetCheckoutPath = targetCommit
      ? await this.getBranchCheckoutPath(repositoryPath, targetBranch)
      : null;
    const workingTreeUpdated = targetCheckoutPath
      ? (await realpath(targetCheckoutPath)) === repositoryPath
      : false;
    if (targetCheckoutPath && !workingTreeUpdated)
      throw new GitApplyError(
        "BRANCH_CHECKED_OUT",
        `目标分支 ${targetBranch} 正在其他 Worktree 中检出：${targetCheckoutPath}`,
      );
    const previousCommit = targetCommit ?? input.baseCommit;
    if (!targetCommit)
      return this.updateTargetBranch({
        repositoryPath,
        branch: targetBranch,
        previousCommit,
        candidateCommit: input.resultCommit,
        changedPaths,
        branchCreated: true,
        workingTreeUpdated: false,
      });
    if (changedPaths.length === 0)
      return {
        status: "already_applied",
        branch: targetBranch,
        previousCommit,
        currentCommit: previousCommit,
        branchCreated: false,
        workingTreeUpdated,
      };
    if (workingTreeUpdated) await this.assertPathsClean(repositoryPath, changedPaths);
    if (
      (await this.isAncestor(repositoryPath, input.resultCommit, previousCommit)) ||
      (await this.hasAppliedResultMarker(repositoryPath, previousCommit, input.resultCommit)) ||
      (await this.pathsMatchCommit(
        repositoryPath,
        previousCommit,
        input.resultCommit,
        changedPaths,
      ))
    )
      return {
        status: "already_applied",
        branch: targetBranch,
        previousCommit,
        currentCommit: previousCommit,
        branchCreated: false,
        workingTreeUpdated,
      };
    const candidateCommit = (await this.isAncestor(
      repositoryPath,
      previousCommit,
      input.resultCommit,
    ))
      ? input.resultCommit
      : await this.createPatchedCommit(
          repositoryPath,
          previousCommit,
          input.baseCommit,
          input.resultCommit,
          input.conflictResolutions ?? [],
        );
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

  protected async createPatchedCommit(
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
    let created = false;
    try {
      const add = await execa(
        this.executable,
        ["-C", repositoryPath, "worktree", "add", "--detach", temporaryWorktree, previousCommit],
        { reject: false },
      );
      if (add.exitCode !== 0)
        throw new GitApplyError(
          "APPLY_FAILED",
          `无法创建临时写回目录：${add.stderr.trim() || add.stdout.trim()}`,
        );
      created = true;
      const apply = await execa(
        this.executable,
        ["-C", temporaryWorktree, "apply", "--3way", "--index", "--whitespace=nowarn", "-"],
        { input: patch, reject: false },
      );
      if (apply.exitCode !== 0) {
        const conflictPaths = await this.getUnmergedPaths(temporaryWorktree);
        if (conflictPaths.length === 0)
          throw new GitApplyError(
            "APPLY_CONFLICT",
            `本次结果与目标分支文件存在冲突，未写入目标分支：${apply.stderr.trim() || apply.stdout.trim() || "Git 三方应用失败"}`,
          );
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
      if (commit.exitCode !== 0)
        throw new Error(commit.stderr.trim() || commit.stdout.trim() || "Git 提交失败");
      const { stdout: candidateCommit } = await execa(this.executable, [
        "-C",
        temporaryWorktree,
        "rev-parse",
        "HEAD",
      ]);
      return candidateCommit.trim();
    } catch (error) {
      if (error instanceof GitApplyError) throw error;
      throw new GitApplyError(
        "APPLY_FAILED",
        `结果文件写回失败：${error instanceof Error ? error.message : "未知 Git 错误"}`,
      );
    } finally {
      await this.removeTemporaryWorktree(repositoryPath, temporaryRoot, temporaryWorktree, created);
    }
  }

  private async applyConflictResolutions(
    worktreePath: string,
    conflictPaths: string[],
    resolutions: RunConflictResolution[],
  ): Promise<void> {
    const byPath = new Map<string, RunConflictResolution>();
    for (const resolution of resolutions) {
      if (byPath.has(resolution.path))
        throw new GitApplyError(
          "APPLY_CONFLICT",
          `冲突文件 ${resolution.path} 提交了重复的解决结果。`,
        );
      byPath.set(resolution.path, resolution);
    }
    const conflictSet = new Set(conflictPaths);
    const unexpected = resolutions
      .map((resolution) => resolution.path)
      .filter((path) => !conflictSet.has(path));
    if (unexpected.length > 0)
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `冲突文件已经变化，请刷新后重新处理：${unexpected.join("、")}`,
      );
    const unresolved = conflictPaths.filter((path) => !byPath.has(path));
    if (unresolved.length > 0)
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `仍有 ${unresolved.length} 个冲突文件未解决：${unresolved.join("、")}`,
      );
    for (const path of conflictPaths) {
      const resolution = byPath.get(path);
      if (!resolution) continue;
      const stages = await this.getConflictStages(worktreePath, path);
      if (resolution.strategy === "content") {
        if (hasUnresolvedConflictMarkers(resolution.content))
          throw new GitApplyError("APPLY_CONFLICT", `冲突文件 ${path} 仍包含未解决的冲突标记。`);
        const mode =
          stages.find((entry) => entry.stage === 3)?.mode ??
          stages.find((entry) => entry.stage === 2)?.mode ??
          stages.find((entry) => entry.stage === 1)?.mode;
        if (!mode)
          throw new GitApplyError("APPLY_CONFLICT", `无法确定冲突文件 ${path} 的文件类型。`);
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
      const selectedStage = stages.find(
        (entry) => entry.stage === (resolution.strategy === "target" ? 2 : 3),
      );
      if (!selectedStage) {
        await execa(this.executable, [
          "-C",
          worktreePath,
          "update-index",
          "--force-remove",
          "--",
          path,
        ]);
      } else {
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
    }
    const remaining = await this.getUnmergedPaths(worktreePath);
    if (remaining.length > 0)
      throw new GitApplyError(
        "APPLY_CONFLICT",
        `仍有 ${remaining.length} 个冲突文件未解决：${remaining.join("、")}`,
      );
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
      if (currentBranch.trim() !== input.branch || currentHead.trim() !== input.previousCommit)
        throw new GitApplyError(
          "TARGET_BRANCH_CHANGED",
          `写回期间目标分支 ${input.branch} 已发生变化，请刷新后重试。`,
        );
      await this.assertPathsClean(input.repositoryPath, input.changedPaths);
      const merge = await execa(
        this.executable,
        ["-C", input.repositoryPath, "merge", "--ff-only", "--no-edit", input.candidateCommit],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, reject: false },
      );
      if (merge.exitCode !== 0)
        throw new GitApplyError(
          "APPLY_FAILED",
          `目标分支写入失败：${merge.stderr.trim() || merge.stdout.trim() || "Git 快进失败"}`,
        );
    } else {
      const expectedOld = input.branchCreated ? "0".repeat(40) : input.previousCommit;
      const update = await execa(
        this.executable,
        ["-C", input.repositoryPath, "update-ref", branchRef, input.candidateCommit, expectedOld],
        { reject: false },
      );
      if (update.exitCode !== 0)
        throw new GitApplyError(
          "TARGET_BRANCH_CHANGED",
          `目标分支 ${input.branch} 在写回期间发生变化：${update.stderr.trim() || update.stdout.trim() || "Git 引用更新失败"}`,
        );
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
}
