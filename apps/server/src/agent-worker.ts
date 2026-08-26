import {
  ContextBudgetExceededError,
} from "@devloop/context";
import type { ClaimedTask, DevLoopRepository, EventfulResult } from "@devloop/db";
import type { RunnerCapabilities, RunStatus, WorkerStatus } from "@devloop/shared";
import {
  terminateProcessGroup as terminateRunnerProcessGroup,
  type AgentRunner,
  type RunnerEvent,
  type RunnerHandle,
  type RunnerResult,
} from "@devloop/runners";
import {
  AutoConflictResolutionError,
  formatRunnerResult,
  runnerRequiresWorktree,
  type AgentWorkspace,
} from "./agent-run-common.js";
import { AgentReviewOperations } from "./agent-review-operations.js";
import { AgentRunFinalizer } from "./agent-run-finalizer.js";
import { AgentWorkspaceOperations } from "./agent-workspace-operations.js";
import type { ActiveExecution, AgentWorkerOptions } from "./agent-worker-types.js";
import type { DomainEventBus } from "./event-bus.js";
import { AgentBudgetMonitor } from "./agent-budget-monitor.js";
import { executeRolePipeline, runAgentStage } from "./agent-role-pipeline.js";

const phaseByEvent: Record<string, RunStatus> = {
  "runner.preparing": "PREPARING",
  "runner.agent": "AGENT_RUNNING",
  "runner.verifying": "VERIFYING",
  "runner.review": "PREPARING_REVIEW",
  "run.agent.planning.started": "AGENT_RUNNING",
  "run.agent.execution.started": "AGENT_RUNNING",
  "run.agent.verification.started": "VERIFYING",
};

export class AgentWorker {
  private timer: NodeJS.Timeout | null = null;
  private pulling = false;
  private readonly executions = new Map<string, Promise<void>>();
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly runners: Map<string, AgentRunner>;
  private readonly defaultRunnerId: string;
  private readonly runnerCapabilitiesById: Map<string, RunnerCapabilities>;
  private readonly workspaceOperations: AgentWorkspaceOperations;
  private readonly reviewOperations: AgentReviewOperations;
  private readonly runFinalizer: AgentRunFinalizer;
  /** 按 taskId 递增的「轮」计数，用于 LLM 压缩器冷却门。 */
  private readonly turnCounters = new Map<string, number>();

  private incrementTurn(taskId: string): number {
    const next = (this.turnCounters.get(taskId) ?? 0) + 1;
    this.turnCounters.set(taskId, next);
    return next;
  }

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
    const defaultId = options.defaultRunnerId ?? this.runners.keys().next().value;
    if (!defaultId) throw new Error("AgentWorker 无法确定默认 runner");
    if (!this.runners.has(defaultId)) {
      throw new Error(`默认 runner ${defaultId} 未在注册表中`);
    }
    this.defaultRunnerId = defaultId;
    this.runnerCapabilitiesById = new Map(
      (options.runnerCapabilities ?? []).map((capability) => [capability.id, capability]),
    );
    this.workspaceOperations = new AgentWorkspaceOperations(repository, {
      ...(options.gitService ? { gitService: options.gitService } : {}),
      ...(options.worktreesPath ? { worktreesPath: options.worktreesPath } : {}),
      ...(options.skillService ? { skillService: options.skillService } : {}),
      publish: (result) => this.publish(result),
    });
    this.reviewOperations = new AgentReviewOperations(repository, this.workspaceOperations, {
      ...(options.gitService ? { gitService: options.gitService } : {}),
      outputSchemaPath,
      ...(options.playwrightValidationService
        ? { playwrightValidationService: options.playwrightValidationService }
        : {}),
      publish: (result) => this.publish(result),
      isExecutionActive: (runId, executionToken) =>
        this.isExecutionActive(runId, executionToken),
      setActiveHandle: (runId, handle) => {
        const active = this.activeExecutions.get(runId);
        if (active) active.handle = handle;
      },
    });
    this.runFinalizer = new AgentRunFinalizer(repository, this.workspaceOperations, {
      publish: (result) => this.publish(result),
      isExecutionActive: (runId, executionToken) =>
        this.isExecutionActive(runId, executionToken),
      isInvalidExecutionError: (error) => this.isInvalidExecutionError(error),
    });
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
      const managedRetryReadyBefore = new Date(
        currentTime - (this.options.managedRetryDelayMs ?? 5_000),
      ).toISOString();
      for (const retry of this.repository.queueDueManagedRetries(managedRetryReadyBefore)) {
        this.publish(retry);
      }
      let claimedAny = false;
      while (this.executions.size < worker.concurrencyLimit) {
        const claimed = this.repository.claimNextTask({
          readyBefore,
          resolveRunner: (runnerId) => {
            const { runner } = this.resolveRunnerForProject(runnerId);
            return {
              id: runner.id,
              version:
                this.runnerCapabilitiesById.get(runner.id)?.version ??
                (runner.id === "fake" ? "built-in" : null),
            };
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
      budgetExceeded: false,
    };
    let budgetMonitor: AgentBudgetMonitor | null = null;
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
    let workspace: AgentWorkspace = {
      path: null,
      baseCommit: claimed.run.baseCommit,
    };
    try {
      const skills = await this.workspaceOperations.loadEnabledSkills(controller.signal);
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
      workspace = runnerRequiresWorktree(runner.id)
        ? await this.workspaceOperations.prepareWorkspace(
            claimed,
            runner,
            skills,
            controller.signal,
            onProcessGroupId,
            (...args) => this.reviewOperations.reconcileRunCommit(...args),
          )
        : { path: null, baseCommit: claimed.run.baseCommit };
      if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
        return;
      }
      budgetMonitor = new AgentBudgetMonitor(this.repository, claimed, {
        runnerId: runner.id,
        ...(this.options.budgetCheckIntervalMs !== undefined
          ? { checkIntervalMs: this.options.budgetCheckIntervalMs }
          : {}),
        ...(this.options.budgetNow ? { now: this.options.budgetNow } : {}),
        publish: (result) => this.publish(result),
        onLimitReached: () => {
          active.budgetExceeded = true;
          this.abortExecution(active);
        },
        onError: (error) => {
          try {
            this.publish(
              this.repository.recordRunEvent(
                claimed.run.id,
                "run.budget.measurement_failed",
                "预算用量暂时无法更新，执行继续进行",
                { error: error instanceof Error ? error.message : String(error) },
              ),
            );
          } catch {
            // 预算诊断事件失败不能中断正在运行的 Agent。
          }
        },
      });
      budgetMonitor.start();

      const roleContext = {
        claimed,
        runner,
        skills,
        workspace,
        active,
        emit,
        onProcessGroupId,
        repository: this.repository,
        publish: (value: EventfulResult<unknown>) => this.publish(value),
        outputSchemaPath: this.outputSchemaPath,
        options: this.options,
        incrementTurn: (taskId: string) => this.incrementTurn(taskId),
      };
      let result: RunnerResult;
      if (this.options.rolePipelineEnabled) {
        const pipelineResult = await executeRolePipeline(roleContext, this.runFinalizer);
        if (!pipelineResult) return;
        result = pipelineResult;
      } else {
        result = await runAgentStage(roleContext, "executor", claimed.run.plan, null);
      }
      await budgetMonitor.stop();
      budgetMonitor = null;
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
        const committedResult = await this.workspaceOperations.commitWorkspace(
          claimed,
          workspace.path,
          workspace.baseCommit,
          controller.signal,
          onProcessGroupId,
        );
        if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
          return;
        }
        const preparedResult = await this.reviewOperations.prepareResultForReview(
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
          await this.reviewOperations.validateResultForReview(
            claimed,
            preparedResult.resultCommit,
            this.reviewOperations.selectPreviewConfiguration(claimed, result),
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
        await this.runFinalizer.finalizeUnsuccessfulRun(
          claimed,
          "blocked",
          summary,
          workspace,
          controller.signal,
          onProcessGroupId,
        );
      } else {
        await this.runFinalizer.finalizeUnsuccessfulRun(
          claimed,
          "failed",
          summary,
          workspace,
          controller.signal,
          onProcessGroupId,
        );
      }
    } catch (error) {
      await budgetMonitor?.stop(!active.budgetExceeded);
      budgetMonitor = null;
      if (
        active.cancelled ||
        !this.isExecutionActive(claimed.run.id, claimed.run.executionToken) ||
        this.isInvalidExecutionError(error)
      ) {
        return;
      }
      if (active.budgetExceeded) {
        await this.runFinalizer.finalizeBudgetPausedRun(claimed, workspace, onProcessGroupId);
        return;
      }
      if (error instanceof ContextBudgetExceededError) {
        await this.runFinalizer.finalizeUnsuccessfulRun(
          claimed,
          "failed",
          `上下文超预算无法压缩至预算内（${error.detail.totalTokens}/${error.detail.budgetTokens} tokens）`,
          workspace,
          controller.signal,
          onProcessGroupId,
        );
        return;
      }
      if (error instanceof AutoConflictResolutionError) {
        await this.runFinalizer.finalizeUnsuccessfulRun(
          claimed,
          error.outcome,
          error.message,
          workspace,
          controller.signal,
          onProcessGroupId,
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
        await this.runFinalizer.finalizeUnsuccessfulRun(
          claimed,
          "failed",
          message,
          workspace,
          controller.signal,
          onProcessGroupId,
        );
      } catch (failureError) {
        if (!this.isInvalidExecutionError(failureError)) {
          throw failureError;
        }
      }
    } finally {
      await budgetMonitor?.stop(false);
      // Run 结束（无论 succeed/fail/block/cancel）都清理该 run 的 scratchpad。
      const scratchpad = this.options.scratchpad;
      if (scratchpad) {
        try {
          await scratchpad.purgeByRun(claimed.run.id);
        } catch (purgeError) {
          // 清理失败不影响主流程；打印一行让运维可查。
          // 使用 process.stderr 避免依赖服务级 logger。
          process.stderr.write(
            `[agent-worker] 清理 scratchpad 失败 runId=${claimed.run.id}: ${
              purgeError instanceof Error ? purgeError.message : String(purgeError)
            }\n`,
          );
        }
      }
    }
  }

  private handleRunnerEvent(runId: string, executionToken: string, event: RunnerEvent): void {
    const status =
      event.type === "runner.agent" && event.data?.role === "verifier"
        ? "VERIFYING"
        : phaseByEvent[event.type];
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
