import { resolve } from "node:path";
import type { ClaimedTask, DevLoopRepository, EventfulResult } from "@devloop/db";
import type { GitService, ReconcileCommitInput, ReconcileCommitResult } from "@devloop/git";
import type { AgentRunner, RunnerSkill } from "@devloop/runners";
import { runnerRequiresWorktree, type ConflictResolutionStage } from "./agent-run-common.js";
import type { SkillService } from "../skills/skill-service.js";

type GitWorkspaceService = Pick<
  GitService,
  | "fetchRepository"
  | "resolveRemoteTargetBase"
  | "resolveTargetBase"
  | "createWorktree"
  | "commitWorktree"
>;

type ReconcileRunCommit = (
  claimed: ClaimedTask,
  runner: AgentRunner,
  skills: RunnerSkill[],
  input: ReconcileCommitInput,
  signal: AbortSignal,
  onProcessGroupId: (processGroupId: number | null) => void,
  stage: ConflictResolutionStage,
) => Promise<{ reconciled: ReconcileCommitResult; agentSummary: string | null }>;

export interface AgentWorkspaceOperationsOptions {
  gitService?: GitWorkspaceService;
  worktreesPath?: string;
  skillService?: Pick<SkillService, "listEnabledForExecution">;
  publish(result: EventfulResult<unknown>): void;
}

export class AgentWorkspaceOperations {
  public constructor(
    private readonly repository: DevLoopRepository,
    private readonly options: AgentWorkspaceOperationsOptions,
  ) {}

  async prepareWorkspace(
    claimed: ClaimedTask,
    runner: AgentRunner,
    skills: RunnerSkill[],
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
    reconcileRunCommit: ReconcileRunCommit,
  ): Promise<{ path: string; baseCommit: string }> {
    if (!runnerRequiresWorktree(runner.id)) {
      throw new Error("当前执行器不需要 Git Worktree");
    }
    if (!this.options.gitService || !this.options.worktreesPath) {
      throw new Error("真实执行器缺少 Git Worktree 配置");
    }
    if (claimed.taskType === "RESEARCH") {
      const baseCommit = claimed.run.baseCommit;
      if (!baseCommit) throw new Error("研究任务缺少可用于隔离工作区的项目基线 Commit");
      this.options.publish(
        this.repository.setRunPhase(
          claimed.run.id,
          claimed.run.executionToken,
          "PREPARING",
          "runner.preparing",
          "正在准备互联网研究脚本的隔离工作区",
        ),
      );
      const worktreePath = resolve(this.options.worktreesPath, claimed.run.id);
      const branchName = `devloop/run/${claimed.run.id}`;
      await this.options.gitService.createWorktree({
        repositoryPath: claimed.projectPath,
        worktreePath,
        branchName,
        baseCommit,
        signal,
        onProcessGroupId,
      });
      this.options.publish(
        this.repository.setRunWorkspace(claimed.run.id, claimed.run.executionToken, {
          worktreePath,
          branchName,
        }),
      );
      return { path: worktreePath, baseCommit };
    }
    this.options.publish(
      this.repository.setRunPhase(
        claimed.run.id,
        claimed.run.executionToken,
        "PREPARING",
        "runner.preparing",
        `正在从目标分支 ${claimed.run.targetBranch} 准备独立 Git Worktree`,
      ),
    );
    const targetBase = await this.resolveCurrentTarget(claimed, signal, onProcessGroupId);
    this.options.publish(
      this.repository.setRunBaseCommit(claimed.run.id, claimed.run.executionToken, {
        targetBranch: targetBase.targetBranch,
        baseCommit: targetBase.baseCommit,
      }),
    );
    let workspaceBaseCommit = targetBase.baseCommit;
    if (claimed.continuationBaseCommit && claimed.continuationResultCommit) {
      this.options.publish(
        this.repository.setRunPhase(
          claimed.run.id,
          claimed.run.executionToken,
          "PREPARING",
          "run.continuation.started",
          "正在载入上一轮待审核结果，并与最新目标分支对齐",
          {
            previousBaseCommit: claimed.continuationBaseCommit,
            previousResultCommit: claimed.continuationResultCommit,
            targetCommit: targetBase.baseCommit,
          },
        ),
      );
      if (targetBase.baseCommit === claimed.continuationBaseCommit) {
        workspaceBaseCommit = claimed.continuationResultCommit;
      } else {
        const { reconciled, agentSummary } = await reconcileRunCommit(
          claimed,
          runner,
          skills,
          {
            repositoryPath: claimed.projectPath,
            targetBranch: targetBase.targetBranch,
            targetCommit: targetBase.baseCommit,
            baseCommit: claimed.continuationBaseCommit,
            resultCommit: claimed.continuationResultCommit,
          },
          signal,
          onProcessGroupId,
          "continuation",
        );
        workspaceBaseCommit = reconciled.resultCommit;
        if (reconciled.status === "resolved") {
          this.options.publish(
            this.repository.recordRunEvent(
              claimed.run.id,
              "run.conflict_resolution.completed",
              `Codex 已解决上一轮结果与目标分支的 ${reconciled.resolutions.length} 个冲突文件，继续执行本轮修改`,
              {
                automatic: true,
                stage: "continuation",
                targetCommit: reconciled.targetCommit,
                resultCommit: reconciled.resultCommit,
                resolutions: reconciled.resolutions,
                summary: agentSummary,
                completedAt: new Date().toISOString(),
              },
            ),
          );
        }
      }
      this.options.publish(
        this.repository.setRunPhase(
          claimed.run.id,
          claimed.run.executionToken,
          "PREPARING",
          "run.continuation.prepared",
          "上一轮待审核代码已载入，本轮将根据驳回意见继续修改",
          {
            previousResultCommit: claimed.continuationResultCommit,
            targetCommit: targetBase.baseCommit,
            workspaceBaseCommit,
          },
        ),
      );
    }
    const worktreePath = resolve(this.options.worktreesPath, claimed.run.id);
    const branchName = `devloop/run/${claimed.run.id}`;
    await this.options.gitService.createWorktree({
      repositoryPath: claimed.projectPath,
      worktreePath,
      branchName,
      baseCommit: workspaceBaseCommit,
      signal,
      onProcessGroupId,
    });
    this.options.publish(
      this.repository.setRunWorkspace(claimed.run.id, claimed.run.executionToken, {
        worktreePath,
        branchName,
      }),
    );
    return { path: worktreePath, baseCommit: targetBase.baseCommit };
  }

  async commitWorkspace(
    claimed: ClaimedTask,
    worktreePath: string | null,
    baseCommit: string | null,
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
    purpose: "review" | "retry" = "review",
  ): Promise<string | null> {
    if (!worktreePath || !this.options.gitService) return baseCommit;
    this.options.publish(
      this.repository.setRunPhase(
        claimed.run.id,
        claimed.run.executionToken,
        "VERIFYING",
        purpose === "retry" ? "run.retry_checkpoint.started" : "runner.verifying",
        purpose === "retry"
          ? "执行未完成，正在保存可用于重试的 Git 恢复点"
          : "Codex 执行完成，正在固化 Git 结果",
      ),
    );
    const title = claimed.task.title.replace(/\s+/g, " ").trim().slice(0, 120);
    return this.options.gitService.commitWorktree({
      worktreePath,
      message: purpose === "retry" ? `DevLoop retry checkpoint: ${title}` : `DevLoop: ${title}`,
      signal,
      onProcessGroupId,
    });
  }

  async resolveCurrentTarget(
    claimed: ClaimedTask,
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
  ): Promise<{ targetBranch: string; baseCommit: string; branchExists: boolean }> {
    if (!this.options.gitService) throw new Error("真实执行器缺少 Git 服务配置");
    if (claimed.projectRepositoryUrl) {
      await this.options.gitService.fetchRepository(claimed.projectPath, {
        signal,
        onProcessGroupId,
      });
      return this.options.gitService.resolveRemoteTargetBase({
        repositoryPath: claimed.projectPath,
        targetBranch: claimed.run.targetBranch,
        fallbackRef: claimed.projectDefaultBaseRef,
        signal,
        onProcessGroupId,
      });
    }
    return this.options.gitService.resolveTargetBase({
      repositoryPath: claimed.projectPath,
      targetBranch: claimed.run.targetBranch,
      fallbackRef: claimed.projectDefaultBaseRef,
      signal,
      onProcessGroupId,
    });
  }

  async loadEnabledSkills(signal: AbortSignal): Promise<RunnerSkill[]> {
    signal.throwIfAborted();
    const skills = (await this.options.skillService?.listEnabledForExecution()) ?? [];
    signal.throwIfAborted();
    return skills;
  }
}
