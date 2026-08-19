import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ClaimedTask, DevLoopRepository, EventfulResult } from "@devloop/db";
import {
  GitApplyError,
  type GitService,
  type ReconcileCommitInput,
  type ReconcileCommitResult,
} from "@devloop/git";
import type {
  DomainEvent,
  RunPreviewConfig,
  RunnerCapabilities,
  RunStatus,
  WorkerStatus,
} from "@devloop/shared";
import {
  terminateProcessGroup as terminateRunnerProcessGroup,
  type AgentRunner,
  type RunnerEvent,
  type RunnerHandle,
  type RunnerResult,
  type RunnerSkill,
} from "@devloop/runners";
import type { DomainEventBus } from "./event-bus.js";
import type { SkillService } from "./skill-service.js";
import type { PlaywrightValidationService } from "./playwright-validation-service.js";

const phaseByEvent: Record<string, RunStatus> = {
  "runner.preparing": "PREPARING",
  "runner.agent": "AGENT_RUNNING",
  "runner.verifying": "VERIFYING",
  "runner.review": "PREPARING_REVIEW",
};

const runnersRequiringWorktree = new Set(["codex", "claude-code"]);
const runnerRequiresWorktree = (runnerId: string): boolean =>
  runnersRequiringWorktree.has(runnerId);

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

export interface AgentWorkerOptions {
  claimDelayMs?: number;
  now?: () => number;
  defaultRunnerId?: string;
  runnerCapabilities?: RunnerCapabilities[];
  gitService?: Pick<
    GitService,
    | "fetchRepository"
    | "resolveRemoteTargetBase"
    | "resolveTargetBase"
    | "createWorktree"
    | "commitWorktree"
    | "reconcileCommitConflicts"
    | "moveWorktreeToCommit"
  >;
  worktreesPath?: string;
  terminateProcessGroup?: (processGroupId: number) => void;
  skillService?: Pick<SkillService, "listEnabledForExecution">;
  playwrightValidationService?: Pick<PlaywrightValidationService, "validate">;
}

class AutoConflictResolutionError extends Error {
  public constructor(
    public readonly outcome: "blocked" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "AutoConflictResolutionError";
  }
}

const formatRunnerResult = (result: RunnerResult): string => {
  const criteria = result.acceptanceCriteria?.map(
    (item) =>
      `${item.status === "passed" ? "通过" : item.status === "failed" ? "失败" : "无法验证"}：${item.criterion}（${item.evidence}）`,
  );
  return [
    result.summary,
    result.blockedReason ? `阻塞原因：${result.blockedReason}` : null,
    criteria?.length ? `验收结果：\n${criteria.join("\n")}` : null,
    result.risks.length ? `风险：\n${result.risks.join("\n")}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
};

type ConflictResolutionStage = "continuation" | "review";

interface ActiveExecution {
  taskId: string;
  runId: string;
  executionToken: string;
  controller: AbortController;
  handle: RunnerHandle | null;
  processGroupId: number | null;
  cancelled: boolean;
}

export class AgentWorker {
  private timer: NodeJS.Timeout | null = null;
  private pulling = false;
  private readonly executions = new Map<string, Promise<void>>();
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly runners: Map<string, AgentRunner>;
  private readonly defaultRunnerId: string;
  private readonly runnerCapabilitiesById: Map<string, RunnerCapabilities>;

  public constructor(
    private readonly repository: DevLoopRepository,
    runners: AgentRunner | Map<string, AgentRunner>,
    private readonly eventBus: DomainEventBus,
    private readonly outputSchemaPath: string,
    private readonly options: AgentWorkerOptions = {},
  ) {
    if (runners instanceof Map) {
      this.runners = runners;
    } else {
      this.runners = new Map([[runners.id, runners]]);
    }
    if (this.runners.size === 0) {
      throw new Error("AgentWorker 需要至少注册一个 runner");
    }
    const defaultId = options.defaultRunnerId ?? this.runners.keys().next().value!;
    if (!this.runners.has(defaultId)) {
      throw new Error(`默认 runner ${defaultId} 未在注册表中`);
    }
    this.defaultRunnerId = defaultId;
    this.runnerCapabilitiesById = new Map(
      (options.runnerCapabilities ?? []).map((capability) => [capability.id, capability]),
    );
  }

  private get defaultRunner(): AgentRunner {
    return this.runners.get(this.defaultRunnerId)!;
  }

  private resolveRunnerForProject(projectRunnerId: string): {
    runner: AgentRunner;
    fellBack: boolean;
    requestedId: string;
  } {
    const requested = this.runners.get(projectRunnerId);
    if (requested) {
      return { runner: requested, fellBack: false, requestedId: projectRunnerId };
    }
    // 只注册了一个 runner 时不算 fallback：单 runner 场景本就是覆盖全部项目
    const fellBack = this.runners.size > 1;
    return { runner: this.defaultRunner, fellBack, requestedId: projectRunnerId };
  }

  private isWorkerAvailable(): boolean {
    if (this.runnerCapabilitiesById.size === 0) {
      return true;
    }
    for (const capability of this.runnerCapabilitiesById.values()) {
      if (capability.available) {
        return true;
      }
    }
    return false;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    for (const interruptedRun of this.repository.listActiveRuns()) {
      try {
        const processGroupId = this.repository.getRunProcessGroupId(interruptedRun.id);
        if (processGroupId !== null) {
          this.terminateProcessGroup(processGroupId);
        }
        this.publish(
          this.repository.failRun(
            interruptedRun.id,
            interruptedRun.executionToken,
            "服务器重启，上一轮执行已标记为中断，请检查后重试。",
          ),
        );
      } catch {
        // 单个恢复动作失败时继续处理其他 Run，诊断页会保留异常状态。
      }
    }
    const targetStatus = this.isWorkerAvailable() ? "RUNNING" : "DEGRADED";
    if (this.repository.getWorkerState().status !== targetStatus) {
      this.publish(this.repository.setWorkerStatus(targetStatus));
    }
    this.timer = setInterval(() => this.wake(), 1_000);
    if (targetStatus === "RUNNING") {
      this.wake();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const active of this.activeExecutions.values()) {
      this.abortExecution(active);
    }
    await Promise.allSettled(this.executions.values());
    if (this.repository.getWorkerState().status !== "STOPPED") {
      this.publish(this.repository.setWorkerStatus("STOPPED"));
    }
  }

  setStatus(status: Extract<WorkerStatus, "RUNNING" | "PAUSED">): void {
    const nextStatus = status === "RUNNING" && !this.isWorkerAvailable() ? "DEGRADED" : status;
    const current = this.repository.getWorkerState();
    if (current.status !== nextStatus) {
      this.publish(this.repository.setWorkerStatus(nextStatus));
    }
    if (nextStatus === "RUNNING") {
      this.wake();
    }
  }

  setConcurrency(concurrencyLimit: number): void {
    this.publish(this.repository.setWorkerConcurrency(concurrencyLimit));
    if (this.repository.getWorkerState().status === "RUNNING") {
      this.wake();
    }
  }

  cancelTask(taskId: string, deviceId: string, expectedVersion: number, idempotencyKey: string) {
    const result = this.repository.cancelRunningTask(
      taskId,
      deviceId,
      expectedVersion,
      idempotencyKey,
    );
    const active = this.activeExecutions.get(result.value.run.id);
    if (active?.taskId === taskId && active.runId === result.value.run.id) {
      active.cancelled = true;
      this.abortExecution(active);
    }
    return result;
  }

  pullNextTask(): boolean {
    if (this.pulling) {
      return false;
    }

    this.pulling = true;
    try {
      this.repository.heartbeat();
      const worker = this.repository.getWorkerState();
      if (worker.status !== "RUNNING") {
        return false;
      }

      const claimDelayMs = this.options.claimDelayMs ?? 5_000;
      const currentTime = this.options.now?.() ?? Date.now();
      const readyBefore = new Date(currentTime - claimDelayMs).toISOString();
      let claimedAny = false;
      while (this.executions.size < worker.concurrencyLimit) {
        const claimed = this.repository.claimNextTask({
          readyBefore,
          resolveRunnerVersion: (runnerId) => {
            const { runner } = this.resolveRunnerForProject(runnerId);
            return (
              this.runnerCapabilitiesById.get(runner.id)?.version ??
              (runner.id === "fake" ? "built-in" : null)
            );
          },
        });
        if (!claimed) {
          break;
        }

        claimedAny = true;
        this.eventBus.publish(claimed.events);
        const runId = claimed.value.run.id;
        const execution = this.execute(claimed.value).finally(() => {
          if (this.executions.get(runId) === execution) {
            this.executions.delete(runId);
          }
          this.activeExecutions.delete(runId);
          if (this.timer) {
            this.wake();
          }
        });
        this.executions.set(runId, execution);
        void execution.catch(() => undefined);
      }
      return claimedAny;
    } finally {
      this.pulling = false;
    }
  }

  wake(): void {
    queueMicrotask(() => this.pullNextTask());
  }

  private async execute(claimed: ClaimedTask): Promise<void> {
    const controller = new AbortController();
    const active: ActiveExecution = {
      taskId: claimed.task.id,
      runId: claimed.run.id,
      executionToken: claimed.run.executionToken,
      controller,
      handle: null as RunnerHandle | null,
      processGroupId: null,
      cancelled: false,
    };
    this.activeExecutions.set(active.runId, active);
    const emit = (event: RunnerEvent) =>
      this.handleRunnerEvent(claimed.run.id, claimed.run.executionToken, event);
    const onProcessGroupId = (processGroupId: number | null) =>
      this.handleProcessGroupChange(active, processGroupId);

    const resolvedRunner = this.resolveRunnerForProject(claimed.projectRunner);
    const runner = resolvedRunner.runner;
    if (resolvedRunner.fellBack) {
      try {
        this.publish(
          this.repository.recordRunEvent(
            claimed.run.id,
            "runner.fallback",
            `项目请求的执行器 ${resolvedRunner.requestedId} 未注册，本次改用 ${runner.id}`,
            { requestedRunner: resolvedRunner.requestedId, actualRunner: runner.id },
          ),
        );
      } catch {
        // 事件记录失败不阻断执行。
      }
    }
    try {
      const skills = await this.loadEnabledSkills(controller.signal);
      if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
        return;
      }
      this.publish(
        this.repository.setRunSkillSnapshot(
          claimed.run.id,
          claimed.run.executionToken,
          skills.map((skill) => ({
            skillId: skill.id,
            version: skill.version,
            contentHash: skill.contentHash,
          })),
        ),
      );
      const workspace = runnerRequiresWorktree(runner.id)
        ? await this.prepareWorkspace(claimed, runner, skills, controller.signal, onProcessGroupId)
        : { path: null, baseCommit: claimed.run.baseCommit };
      if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
        return;
      }
      active.handle = runner.start(
        {
          runId: claimed.run.id,
          taskId: claimed.task.id,
          taskType: claimed.taskType,
          title: claimed.title,
          goal: claimed.goal,
          acceptanceCriteria: claimed.acceptanceCriteria,
          skills,
          reviewFeedback: claimed.reviewFeedback,
          worktreePath: workspace.path,
          outputSchemaPath: this.outputSchemaPath,
          signal: controller.signal,
          onProcessGroupId,
        },
        emit,
      );

      const result = await active.handle.result;
      if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
        return;
      }
      const summary = formatRunnerResult(result);
      if (result.outcome === "succeeded") {
        if (claimed.taskType === "RESEARCH") {
          this.publish(
            this.repository.setRunPhase(
              claimed.run.id,
              claimed.run.executionToken,
              "PREPARING_REVIEW",
              "runner.review",
              "互联网研究已完成，正在准备总结供用户审核",
            ),
          );
          this.publish(
            this.repository.completeRun(claimed.run.id, claimed.run.executionToken, summary),
          );
          return;
        }
        const committedResult = await this.commitWorkspace(
          claimed,
          workspace.path,
          workspace.baseCommit,
          controller.signal,
          onProcessGroupId,
        );
        if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
          return;
        }
        const preparedResult = await this.prepareResultForReview(
          claimed,
          runner,
          skills,
          workspace.path,
          workspace.baseCommit,
          committedResult,
          summary,
          controller.signal,
          onProcessGroupId,
        );
        if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
          return;
        }
        if (preparedResult.resultCommit) {
          this.publish(
            this.repository.setRunPhase(
              claimed.run.id,
              claimed.run.executionToken,
              "PREPARING_REVIEW",
              "runner.review",
              `审核结果 Commit 已准备完成：${preparedResult.resultCommit.slice(0, 12)}`,
            ),
          );
          await this.validateResultForReview(
            claimed,
            preparedResult.resultCommit,
            this.selectPreviewConfiguration(claimed, result),
            controller.signal,
          );
          if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
            return;
          }
        }
        this.publish(
          this.repository.completeRun(
            claimed.run.id,
            claimed.run.executionToken,
            preparedResult.summary,
            preparedResult.resultCommit ?? undefined,
          ),
        );
      } else if (result.outcome === "blocked") {
        this.publish(this.repository.blockRun(claimed.run.id, claimed.run.executionToken, summary));
      } else {
        this.publish(this.repository.failRun(claimed.run.id, claimed.run.executionToken, summary));
      }
    } catch (error) {
      if (
        active.cancelled ||
        !this.isExecutionActive(claimed.run.id, claimed.run.executionToken) ||
        this.isInvalidExecutionError(error)
      ) {
        return;
      }
      if (error instanceof AutoConflictResolutionError) {
        this.publish(
          error.outcome === "blocked"
            ? this.repository.blockRun(claimed.run.id, claimed.run.executionToken, error.message)
            : this.repository.failRun(claimed.run.id, claimed.run.executionToken, error.message),
        );
        return;
      }
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "执行已由服务器中断。"
          : error instanceof Error
            ? error.message
            : "执行器发生未知错误。";
      try {
        this.publish(this.repository.failRun(claimed.run.id, claimed.run.executionToken, message));
      } catch (failureError) {
        if (!this.isInvalidExecutionError(failureError)) {
          throw failureError;
        }
      }
    }
  }

  private async validateResultForReview(
    claimed: ClaimedTask,
    resultCommit: string,
    selectedPreviewConfiguration: RunPreviewConfig | null,
    signal: AbortSignal,
  ): Promise<void> {
    const validationService = this.options.playwrightValidationService;
    if (!validationService) return;
    if (selectedPreviewConfiguration) {
      this.publish(
        this.repository.recordRunEvent(
          claimed.run.id,
          "run.preview.configuration.selected",
          `预览配置来源：${previewSourceLabel[selectedPreviewConfiguration.source]}`,
          { ...selectedPreviewConfiguration },
        ),
      );
    }
    this.publish(
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
          this.publish(
            this.repository.recordRunEvent(
              claimed.run.id,
              "run.preview.configuration.selected",
              `预览配置来源：${previewSourceLabel[report.previewConfiguration.source]}`,
              { ...report.previewConfiguration },
            ),
          );
        }
      }
      this.publish(
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
      this.publish(
        this.repository.recordRunEvent(
          claimed.run.id,
          "run.playwright.failed",
          "Playwright 自动验证未能生成完整报告，但任务结果仍可人工审核",
          { error: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }

  private selectPreviewConfiguration(
    claimed: ClaimedTask,
    result: RunnerResult,
  ): RunPreviewConfig | null {
    if (claimed.previewCommand) {
      return {
        source: "project",
        command: claimed.previewCommand,
        workingDirectory: claimed.previewWorkingDirectory,
        healthPath: claimed.previewHealthPath,
      };
    }
    if (result.preview) {
      return { source: "agent", ...result.preview };
    }
    return null;
  }

  private handleRunnerEvent(runId: string, executionToken: string, event: RunnerEvent): void {
    const status = phaseByEvent[event.type];
    if (!status || !this.isExecutionActive(runId, executionToken)) {
      return;
    }
    try {
      this.publish(
        this.repository.setRunPhase(
          runId,
          executionToken,
          status,
          event.type,
          event.message,
          event.data,
        ),
      );
    } catch (error) {
      if (!this.isInvalidExecutionError(error)) {
        throw error;
      }
    }
  }

  private async prepareWorkspace(
    claimed: ClaimedTask,
    runner: AgentRunner,
    skills: RunnerSkill[],
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
  ): Promise<{ path: string; baseCommit: string }> {
    if (!runnerRequiresWorktree(runner.id)) {
      throw new Error("当前执行器不需要 Git Worktree");
    }
    if (!this.options.gitService || !this.options.worktreesPath) {
      throw new Error("真实执行器缺少 Git Worktree 配置");
    }
    if (claimed.taskType === "RESEARCH") {
      const baseCommit = claimed.run.baseCommit;
      if (!baseCommit) {
        throw new Error("研究任务缺少可用于隔离工作区的项目基线 Commit");
      }
      this.publish(
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
      this.publish(
        this.repository.setRunWorkspace(claimed.run.id, claimed.run.executionToken, {
          worktreePath,
          branchName,
        }),
      );
      return { path: worktreePath, baseCommit };
    }
    this.publish(
      this.repository.setRunPhase(
        claimed.run.id,
        claimed.run.executionToken,
        "PREPARING",
        "runner.preparing",
        `正在从目标分支 ${claimed.run.targetBranch} 准备独立 Git Worktree`,
      ),
    );
    const targetBase = await this.resolveCurrentTarget(claimed, signal, onProcessGroupId);
    this.publish(
      this.repository.setRunBaseCommit(claimed.run.id, claimed.run.executionToken, {
        targetBranch: targetBase.targetBranch,
        baseCommit: targetBase.baseCommit,
      }),
    );
    let workspaceBaseCommit = targetBase.baseCommit;
    if (claimed.continuationBaseCommit && claimed.continuationResultCommit) {
      this.publish(
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
        const { reconciled, agentSummary } = await this.reconcileRunCommit(
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
          this.publish(
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

      this.publish(
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
    this.publish(
      this.repository.setRunWorkspace(claimed.run.id, claimed.run.executionToken, {
        worktreePath,
        branchName,
      }),
    );
    return { path: worktreePath, baseCommit: targetBase.baseCommit };
  }

  private async commitWorkspace(
    claimed: ClaimedTask,
    worktreePath: string | null,
    baseCommit: string | null,
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
  ): Promise<string | null> {
    if (!worktreePath || !this.options.gitService) {
      return baseCommit;
    }
    this.publish(
      this.repository.setRunPhase(
        claimed.run.id,
        claimed.run.executionToken,
        "VERIFYING",
        "runner.verifying",
        "Codex 执行完成，正在固化 Git 结果",
      ),
    );
    const title = claimed.task.title.replace(/\s+/g, " ").trim().slice(0, 120);
    const resultCommit = await this.options.gitService.commitWorktree({
      worktreePath,
      message: `DevLoop: ${title}`,
      signal,
      onProcessGroupId,
    });
    return resultCommit;
  }

  private async prepareResultForReview(
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

    this.publish(
      this.repository.setRunPhase(
        claimed.run.id,
        claimed.run.executionToken,
        "VERIFYING",
        "run.conflict_check.started",
        `正在检查结果与目标分支 ${claimed.run.targetBranch} 的写入冲突`,
      ),
    );
    const target = await this.resolveCurrentTarget(claimed, signal, onProcessGroupId);
    if (!target.branchExists || target.baseCommit === baseCommit) {
      this.publish(
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
    this.publish(
      this.repository.setRunBaseCommit(claimed.run.id, claimed.run.executionToken, {
        targetBranch: target.targetBranch,
        baseCommit: reconciled.targetCommit,
      }),
    );
    if (reconciled.status === "clean") {
      this.publish(
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

    const completedAt = new Date().toISOString();
    this.publish(
      this.repository.recordRunEvent(
        claimed.run.id,
        "run.conflict_resolution.completed",
        `Codex 已自动解决 ${reconciled.resolutions.length} 个冲突文件，等待人工审核`,
        {
          automatic: true,
          targetCommit: reconciled.targetCommit,
          resolutions: reconciled.resolutions,
          summary: agentSummary ?? "Codex 已完成自动冲突解决。",
          completedAt,
        },
      ),
    );
    return {
      resultCommit: reconciled.resultCommit,
      summary: `${summary}\n\n自动冲突解决：\n${agentSummary ?? "Codex 已完成自动冲突解决。"}`,
    };
  }

  private async reconcileRunCommit(
    claimed: ClaimedTask,
    runner: AgentRunner,
    skills: RunnerSkill[],
    input: ReconcileCommitInput,
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
    stage: ConflictResolutionStage,
  ): Promise<{ reconciled: ReconcileCommitResult; agentSummary: string | null }> {
    if (!this.options.gitService) {
      throw new Error("真实执行器缺少 Git 服务配置");
    }
    let agentSummary: string | null = null;
    try {
      signal.throwIfAborted();
      const reconciled = await this.options.gitService.reconcileCommitConflicts(
        input,
        async ({ worktreePath: conflictWorktree, files }) => {
          if (!claimed.autoResolveConflicts) {
            throw new AutoConflictResolutionError(
              "blocked",
              "上一轮待审核结果与最新目标分支存在冲突，但任务已关闭自动解决冲突。请启用后重试。",
            );
          }
          const continuation = stage === "continuation";
          this.publish(
            this.repository.setRunPhase(
              claimed.run.id,
              claimed.run.executionToken,
              "REPAIRING",
              "run.conflict_resolution.started",
              continuation
                ? `上一轮结果与最新目标分支存在 ${files.length} 个冲突文件，正在交给执行器自动解决`
                : `检测到 ${files.length} 个冲突文件，正在交给执行器自动解决`,
              {
                stage,
                targetCommit: input.targetCommit,
                files: files.map((file) => file.path),
              },
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
              worktreePath: conflictWorktree,
              outputSchemaPath: this.outputSchemaPath,
              signal,
              onProcessGroupId,
            },
            (event: RunnerEvent) =>
              this.handleConflictRunnerEvent(claimed, input.targetCommit, event, stage),
          );
          const active = this.activeExecutions.get(claimed.run.id);
          if (active) {
            active.handle = handle;
          }
          const result = await handle.result;
          agentSummary = formatRunnerResult(result);
          if (result.outcome === "blocked") {
            throw new AutoConflictResolutionError(
              "blocked",
              stage === "continuation"
                ? `Codex 在对齐上一轮待审核结果时被阻塞。\n\n${agentSummary}`
                : `Codex 已完成开发，但自动解决冲突被阻塞。\n\n${agentSummary}`,
            );
          }
          if (result.outcome !== "succeeded") {
            throw new AutoConflictResolutionError(
              "failed",
              stage === "continuation"
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

  private async resolveCurrentTarget(
    claimed: ClaimedTask,
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
  ): Promise<{
    targetBranch: string;
    baseCommit: string;
    branchExists: boolean;
  }> {
    if (!this.options.gitService) {
      throw new Error("真实执行器缺少 Git 服务配置");
    }
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

  private async loadEnabledSkills(signal: AbortSignal): Promise<RunnerSkill[]> {
    signal.throwIfAborted();
    const skills = (await this.options.skillService?.listEnabledForExecution()) ?? [];
    signal.throwIfAborted();
    return skills;
  }

  private handleConflictRunnerEvent(
    claimed: ClaimedTask,
    targetCommit: string,
    event: RunnerEvent,
    stage: ConflictResolutionStage,
  ): void {
    if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
      return;
    }
    this.publish(
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

  private isExecutionActive(runId: string, executionToken: string): boolean {
    const active = this.activeExecutions.get(runId);
    return active?.runId === runId && active.executionToken === executionToken && !active.cancelled;
  }

  private handleProcessGroupChange(active: ActiveExecution, processGroupId: number | null): void {
    if (this.activeExecutions.get(active.runId) !== active) {
      if (processGroupId !== null) {
        this.terminateProcessGroup(processGroupId);
      }
      return;
    }
    active.processGroupId = processGroupId;
    if (active.cancelled) {
      if (processGroupId !== null) {
        this.terminateProcessGroup(processGroupId);
      }
      return;
    }
    try {
      this.repository.setRunProcessGroupId(active.runId, active.executionToken, processGroupId);
    } catch (error) {
      if (this.isInvalidExecutionError(error)) {
        active.cancelled = true;
        this.abortExecution(active);
        return;
      }
      if (processGroupId !== null) {
        this.terminateProcessGroup(processGroupId);
      }
      throw error;
    }
  }

  private abortExecution(active: ActiveExecution): void {
    const processGroupId = active.processGroupId;
    active.controller.abort();
    active.handle?.cancel();
    if (processGroupId !== null) {
      this.terminateProcessGroup(processGroupId);
    }
  }

  private terminateProcessGroup(processGroupId: number): void {
    (this.options.terminateProcessGroup ?? terminateRunnerProcessGroup)(processGroupId);
  }

  private isInvalidExecutionError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    return (
      error.message.includes("执行令牌已经失效") ||
      error.message.includes("不再由此 Run 执行") ||
      error.message.includes("已经失去基础 Commit 所有权") ||
      error.message.includes("已经失去 Worktree 所有权")
    );
  }

  private publish(result: EventfulResult<unknown>): void {
    this.eventBus.publish(result.events);
  }
}
