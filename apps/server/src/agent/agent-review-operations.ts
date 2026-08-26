import { randomUUID } from "node:crypto";
import type { ClaimedTask, DevLoopRepository, EventfulResult } from "@devloop/db";
import {
  GitApplyError,
  type GitService,
  type ReconcileCommitInput,
  type ReconcileCommitResult,
} from "@devloop/git";
import type { RunPreviewConfig } from "@devloop/shared";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerHandle,
  RunnerResult,
  RunnerSkill,
} from "@devloop/runners";
import {
  AutoConflictResolutionError,
  formatRunnerResult,
  runnerRequiresWorktree,
  type ConflictResolutionStage,
} from "./agent-run-common.js";
import type { AgentWorkspaceOperations } from "./agent-workspace-operations.js";
import type { PlaywrightValidationService } from "../preview/playwright-validation-service.js";

const previewConfigurationEquals = (
  left: RunPreviewConfig | null,
  right: RunPreviewConfig | null,
): boolean =>
  left?.source === right?.source &&
  left?.command === right?.command &&
  left?.workingDirectory === right?.workingDirectory &&
  left?.healthPath === right?.healthPath;

const previewSourceLabel: Record<RunPreviewConfig["source"], string> = {
  project: "项目高级覆盖",
  agent: "Agent 识别",
  detected: "自动识别",
};

type ReviewGitService = Pick<GitService, "reconcileCommitConflicts" | "moveWorktreeToCommit">;

export interface AgentReviewOperationsOptions {
  gitService?: ReviewGitService;
  outputSchemaPath: string;
  playwrightValidationService?: Pick<PlaywrightValidationService, "validate">;
  publish(result: EventfulResult<unknown>): void;
  isExecutionActive(runId: string, executionToken: string): boolean;
  setActiveHandle(runId: string, handle: RunnerHandle): void;
}

export class AgentReviewOperations {
  public constructor(
    private readonly repository: DevLoopRepository,
    private readonly workspace: AgentWorkspaceOperations,
    private readonly options: AgentReviewOperationsOptions,
  ) {}

  async validateResultForReview(
    claimed: ClaimedTask,
    resultCommit: string,
    selectedPreviewConfiguration: RunPreviewConfig | null,
    signal: AbortSignal,
  ): Promise<void> {
    const validationService = this.options.playwrightValidationService;
    if (!validationService) return;
    if (selectedPreviewConfiguration) {
      this.options.publish(
        this.repository.recordRunEvent(
          claimed.run.id,
          "run.preview.configuration.selected",
          `预览配置来源：${previewSourceLabel[selectedPreviewConfiguration.source]}`,
          { ...selectedPreviewConfiguration },
        ),
      );
    }
    this.options.publish(
      this.repository.recordRunEvent(
        claimed.run.id,
        "run.playwright.started",
        "正在启动任务结果预览并执行 Playwright 自动验证",
        {},
      ),
    );
    try {
      const report = await validationService.validate({
        runId: claimed.run.id,
        repositoryPath: claimed.projectPath,
        resultCommit,
        previewConfiguration: selectedPreviewConfiguration,
        playwrightEnabled: claimed.playwrightEnabled,
        playwrightTestCommand: claimed.playwrightTestCommand,
        signal,
      });
      if (!previewConfigurationEquals(report.previewConfiguration, selectedPreviewConfiguration)) {
        if (report.previewConfiguration) {
          this.options.publish(
            this.repository.recordRunEvent(
              claimed.run.id,
              "run.preview.configuration.selected",
              `预览配置来源：${previewSourceLabel[report.previewConfiguration.source]}`,
              { ...report.previewConfiguration },
            ),
          );
        }
      }
      this.options.publish(
        this.repository.recordRunEvent(
          claimed.run.id,
          "run.playwright.completed",
          report.status === "passed"
            ? "Playwright 自动验证通过，截图与交互结果已附在审核页"
            : report.status === "failed"
              ? "Playwright 自动验证发现问题，请在审核页检查结果"
              : "Playwright 自动验证已跳过，请在审核页查看原因",
          {
            status: report.status,
            checks: report.checks,
            previewConfiguration: report.previewConfiguration,
          },
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      this.options.publish(
        this.repository.recordRunEvent(
          claimed.run.id,
          "run.playwright.failed",
          "Playwright 自动验证未能生成完整报告，但任务结果仍可人工审核",
          { error: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }

  selectPreviewConfiguration(claimed: ClaimedTask, result: RunnerResult): RunPreviewConfig | null {
    if (claimed.previewCommand) {
      return {
        source: "project",
        command: claimed.previewCommand,
        workingDirectory: claimed.previewWorkingDirectory,
        healthPath: claimed.previewHealthPath,
      };
    }
    return result.preview ? { source: "agent", ...result.preview } : null;
  }

  async prepareResultForReview(
    claimed: ClaimedTask,
    runner: AgentRunner,
    skills: RunnerSkill[],
    worktreePath: string | null,
    baseCommit: string | null,
    resultCommit: string | null,
    summary: string,
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
  ): Promise<{ resultCommit: string | null; summary: string }> {
    if (
      !claimed.autoResolveConflicts ||
      !runnerRequiresWorktree(runner.id) ||
      !worktreePath ||
      !baseCommit ||
      !resultCommit ||
      !this.options.gitService
    ) {
      return { resultCommit, summary };
    }
    this.options.publish(
      this.repository.setRunPhase(
        claimed.run.id,
        claimed.run.executionToken,
        "VERIFYING",
        "run.conflict_check.started",
        `正在检查结果与目标分支 ${claimed.run.targetBranch} 的写入冲突`,
      ),
    );
    const target = await this.workspace.resolveCurrentTarget(claimed, signal, onProcessGroupId);
    if (!target.branchExists || target.baseCommit === baseCommit) {
      this.options.publish(
        this.repository.recordRunEvent(
          claimed.run.id,
          "run.conflict_check.completed",
          "目标分支未发生冲突，无需自动解决",
          { targetCommit: target.baseCommit, conflicted: false },
        ),
      );
      return { resultCommit, summary };
    }
    const { reconciled, agentSummary } = await this.reconcileRunCommit(
      claimed,
      runner,
      skills,
      {
        repositoryPath: claimed.projectPath,
        targetBranch: target.targetBranch,
        targetCommit: target.baseCommit,
        baseCommit,
        resultCommit,
      },
      signal,
      onProcessGroupId,
      "review",
    );
    if (reconciled.resultCommit !== resultCommit) {
      signal.throwIfAborted();
      await this.options.gitService.moveWorktreeToCommit({
        worktreePath,
        expectedCommit: resultCommit,
        targetCommit: reconciled.resultCommit,
      });
      signal.throwIfAborted();
    }
    this.options.publish(
      this.repository.setRunBaseCommit(claimed.run.id, claimed.run.executionToken, {
        targetBranch: target.targetBranch,
        baseCommit: reconciled.targetCommit,
      }),
    );
    if (reconciled.status === "clean") {
      this.options.publish(
        this.repository.recordRunEvent(
          claimed.run.id,
          "run.conflict_check.completed",
          "目标分支已更新，本次结果已无冲突地对齐到最新 Commit",
          {
            targetCommit: target.baseCommit,
            resultCommit: reconciled.resultCommit,
            conflicted: false,
          },
        ),
      );
      return {
        resultCommit: reconciled.resultCommit,
        summary: `${summary}\n\n目标分支已更新，本次结果已自动对齐且不存在冲突。`,
      };
    }
    this.options.publish(
      this.repository.recordRunEvent(
        claimed.run.id,
        "run.conflict_resolution.completed",
        `Codex 已自动解决 ${reconciled.resolutions.length} 个冲突文件，等待人工审核`,
        {
          automatic: true,
          targetCommit: reconciled.targetCommit,
          resolutions: reconciled.resolutions,
          summary: agentSummary ?? "Codex 已完成自动冲突解决。",
          completedAt: new Date().toISOString(),
        },
      ),
    );
    return {
      resultCommit: reconciled.resultCommit,
      summary: `${summary}\n\n自动冲突解决：\n${agentSummary ?? "Codex 已完成自动冲突解决。"}`,
    };
  }

  async reconcileRunCommit(
    claimed: ClaimedTask,
    runner: AgentRunner,
    skills: RunnerSkill[],
    input: ReconcileCommitInput,
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
    stage: ConflictResolutionStage,
  ): Promise<{ reconciled: ReconcileCommitResult; agentSummary: string | null }> {
    if (!this.options.gitService) throw new Error("真实执行器缺少 Git 服务配置");
    let agentSummary: string | null = null;
    try {
      signal.throwIfAborted();
      const reconciled = await this.options.gitService.reconcileCommitConflicts(
        input,
        async ({ worktreePath, files }) => {
          if (!claimed.autoResolveConflicts) {
            throw new AutoConflictResolutionError(
              "blocked",
              "上一轮待审核结果与最新目标分支存在冲突，但任务已关闭自动解决冲突。请启用后重试。",
            );
          }
          const continuation = stage === "continuation";
          this.options.publish(
            this.repository.setRunPhase(
              claimed.run.id,
              claimed.run.executionToken,
              "REPAIRING",
              "run.conflict_resolution.started",
              continuation
                ? `上一轮结果与最新目标分支存在 ${files.length} 个冲突文件，正在交给执行器自动解决`
                : `检测到 ${files.length} 个冲突文件，正在交给执行器自动解决`,
              { stage, targetCommit: input.targetCommit, files: files.map((file) => file.path) },
            ),
          );
          const handle = runner.start(
            {
              runId: `conflict-${randomUUID()}`,
              taskId: claimed.task.id,
              title: claimed.title,
              goal: claimed.goal,
              acceptanceCriteria: claimed.acceptanceCriteria,
              skills,
              mode: "conflict-resolution",
              conflictPaths: files.map((file) => file.path),
              worktreePath,
              outputSchemaPath: this.options.outputSchemaPath,
              signal,
              onProcessGroupId,
            },
            (event) => this.handleConflictRunnerEvent(claimed, input.targetCommit, event, stage),
          );
          this.options.setActiveHandle(claimed.run.id, handle);
          const result = await handle.result;
          agentSummary = formatRunnerResult(result);
          if (result.outcome === "blocked") {
            throw new AutoConflictResolutionError(
              "blocked",
              continuation
                ? `Codex 在对齐上一轮待审核结果时被阻塞。\n\n${agentSummary}`
                : `Codex 已完成开发，但自动解决冲突被阻塞。\n\n${agentSummary}`,
            );
          }
          if (result.outcome !== "succeeded") {
            throw new AutoConflictResolutionError(
              "failed",
              continuation
                ? `Codex 无法把上一轮待审核结果与最新目标分支对齐。\n\n${agentSummary}`
                : `Codex 已完成开发，但自动解决冲突失败。\n\n${agentSummary}`,
            );
          }
        },
      );
      signal.throwIfAborted();
      return { reconciled, agentSummary };
    } catch (error) {
      if (error instanceof GitApplyError && error.code === "APPLY_CONFLICT") {
        throw new AutoConflictResolutionError(
          "blocked",
          stage === "continuation"
            ? `上一轮待审核结果与最新目标分支对齐后仍存在冲突。\n\n${error.message}`
            : `Codex 已完成开发，但自动解决后仍存在冲突。\n\n${error.message}`,
        );
      }
      throw error;
    }
  }

  private handleConflictRunnerEvent(
    claimed: ClaimedTask,
    targetCommit: string,
    event: RunnerEvent,
    stage: ConflictResolutionStage,
  ): void {
    if (!this.options.isExecutionActive(claimed.run.id, claimed.run.executionToken)) return;
    this.options.publish(
      this.repository.setRunPhase(
        claimed.run.id,
        claimed.run.executionToken,
        "REPAIRING",
        "run.conflict_resolution.progress",
        event.message,
        {
          stage,
          targetCommit,
          runnerEventType: event.type,
          ...(event.data ? { data: event.data } : {}),
        },
      ),
    );
  }
}
