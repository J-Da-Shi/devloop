import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ClaimedTask, DevLoopRepository, EventfulResult } from "@devloop/db";
import {
  GitApplyError,
  type GitService,
  type ReconcileCommitInput,
  type ReconcileCommitResult,
} from "@devloop/git";
import type { DomainEvent, RunStatus, WorkerStatus } from "@devloop/shared";
import {
  terminateProcessGroup as terminateRunnerProcessGroup,
  type AgentRunner,
  type RunnerEvent,
  type RunnerHandle,
  type RunnerResult,
} from "@devloop/runners";
import type { DomainEventBus } from "./event-bus.js";

const phaseByEvent: Record<string, RunStatus> = {
  "runner.preparing": "PREPARING",
  "runner.agent": "AGENT_RUNNING",
  "runner.verifying": "VERIFYING",
  "runner.review": "PREPARING_REVIEW",
};

export interface AgentWorkerOptions {
  claimDelayMs?: number;
  now?: () => number;
  available?: boolean;
  runnerVersion?: string | null;
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
  private execution: Promise<void> | null = null;
  private activeExecution: ActiveExecution | null = null;

  public constructor(
    private readonly repository: DevLoopRepository,
    private readonly runner: AgentRunner,
    private readonly eventBus: DomainEventBus,
    private readonly outputSchemaPath: string,
    private readonly options: AgentWorkerOptions = {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    const persisted = this.repository.getWorkerState();
    if (persisted.activeRunId) {
      try {
        const interruptedRun = this.repository.getRun(persisted.activeRunId);
        if (!interruptedRun) {
          throw new Error("找不到上次执行记录");
        }
        const processGroupId = this.repository.getRunProcessGroupId(persisted.activeRunId);
        if (processGroupId !== null) {
          this.terminateProcessGroup(processGroupId);
        }
        this.publish(
          this.repository.failRun(
            persisted.activeRunId,
            interruptedRun.executionToken,
            "服务器重启，上一轮执行已标记为中断，请检查后重试。",
          ),
        );
      } catch {
        // 恢复动作失败时仍允许服务启动，后续诊断页会暴露持久化状态。
      }
    }
    const targetStatus = this.options.available === false ? "DEGRADED" : "RUNNING";
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
    if (this.activeExecution) {
      this.abortExecution(this.activeExecution);
    }
    await this.execution?.catch(() => undefined);
    if (this.repository.getWorkerState().status !== "STOPPED") {
      this.publish(this.repository.setWorkerStatus("STOPPED"));
    }
  }

  setStatus(status: Extract<WorkerStatus, "RUNNING" | "PAUSED">): void {
    const nextStatus =
      status === "RUNNING" && this.options.available === false ? "DEGRADED" : status;
    const current = this.repository.getWorkerState();
    if (current.status !== nextStatus) {
      this.publish(this.repository.setWorkerStatus(nextStatus));
    }
    if (nextStatus === "RUNNING") {
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
    const active = this.activeExecution;
    if (active?.taskId === taskId && active.runId === result.value.run.id) {
      active.cancelled = true;
      this.abortExecution(active);
    }
    return result;
  }

  pullNextTask(): boolean {
    if (this.pulling || this.execution) {
      return false;
    }

    this.pulling = true;
    try {
      this.repository.heartbeat();
      if (this.repository.getWorkerState().status !== "RUNNING") {
        return false;
      }

      const claimDelayMs = this.options.claimDelayMs ?? 5_000;
      const currentTime = this.options.now?.() ?? Date.now();
      const readyBefore = new Date(currentTime - claimDelayMs).toISOString();
      const claimed = this.repository.claimNextTask(
        this.runner.id,
        readyBefore,
        this.options.runnerVersion ?? null,
      );
      if (!claimed) {
        return false;
      }

      this.eventBus.publish(claimed.events);
      const execution = this.execute(claimed.value).finally(() => {
        if (this.execution === execution) {
          this.execution = null;
        }
        if (this.activeExecution?.runId === claimed.value.run.id) {
          this.activeExecution = null;
        }
        if (this.timer) {
          this.wake();
        }
      });
      this.execution = execution;
      return true;
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
    this.activeExecution = active;
    const emit = (event: RunnerEvent) =>
      this.handleRunnerEvent(claimed.run.id, claimed.run.executionToken, event);
    const onProcessGroupId = (processGroupId: number | null) =>
      this.handleProcessGroupChange(active, processGroupId);

    try {
      const workspace =
        this.runner.id === "codex"
          ? await this.prepareWorkspace(claimed, controller.signal, onProcessGroupId)
          : { path: null, baseCommit: claimed.run.baseCommit };
      if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
        return;
      }
      active.handle = this.runner.start(
        {
          runId: claimed.run.id,
          taskId: claimed.task.id,
          title: claimed.title,
          goal: claimed.goal,
          acceptanceCriteria: claimed.acceptanceCriteria,
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
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
  ): Promise<{ path: string; baseCommit: string }> {
    if (this.runner.id !== "codex") {
      throw new Error("只有 Codex 执行器需要准备 Git Worktree");
    }
    if (!this.options.gitService || !this.options.worktreesPath) {
      throw new Error("真实执行器缺少 Git Worktree 配置");
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
    worktreePath: string | null,
    baseCommit: string | null,
    resultCommit: string | null,
    summary: string,
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
  ): Promise<{ resultCommit: string | null; summary: string }> {
    if (
      !claimed.autoResolveConflicts ||
      this.runner.id !== "codex" ||
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
                ? `上一轮结果与最新目标分支存在 ${files.length} 个冲突文件，正在交给 Codex 自动解决`
                : `检测到 ${files.length} 个冲突文件，正在交给 Codex 自动解决`,
              {
                stage,
                targetCommit: input.targetCommit,
                files: files.map((file) => file.path),
              },
            ),
          );
          const handle = this.runner.start(
            {
              runId: `conflict-${randomUUID()}`,
              taskId: claimed.task.id,
              title: claimed.title,
              goal: claimed.goal,
              acceptanceCriteria: claimed.acceptanceCriteria,
              mode: "conflict-resolution",
              conflictPaths: files.map((file) => file.path),
              worktreePath: conflictWorktree,
              outputSchemaPath: this.outputSchemaPath,
              signal,
              onProcessGroupId,
            },
            (event) => this.handleConflictRunnerEvent(claimed, input.targetCommit, event, stage),
          );
          if (this.activeExecution?.runId === claimed.run.id) {
            this.activeExecution.handle = handle;
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
    const active = this.activeExecution;
    return active?.runId === runId && active.executionToken === executionToken && !active.cancelled;
  }

  private handleProcessGroupChange(active: ActiveExecution, processGroupId: number | null): void {
    if (this.activeExecution !== active) {
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
