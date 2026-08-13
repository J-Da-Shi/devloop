import { resolve } from "node:path";
import type { ClaimedTask, DevLoopRepository, EventfulResult } from "@devloop/db";
import type { GitService } from "@devloop/git";
import type { DomainEvent, RunStatus, WorkerStatus } from "@devloop/shared";
import type { AgentRunner, RunnerEvent, RunnerHandle, RunnerResult } from "@devloop/runners";
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
    "fetchRepository" | "resolveRemoteTargetBase" | "createWorktree" | "commitWorktree"
  >;
  worktreesPath?: string;
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

export class AgentWorker {
  private timer: NodeJS.Timeout | null = null;
  private pulling = false;
  private execution: Promise<void> | null = null;
  private activeExecution: {
    taskId: string;
    runId: string;
    executionToken: string;
    controller: AbortController;
    handle: RunnerHandle | null;
    cancelled: boolean;
  } | null = null;

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
    this.activeExecution?.controller.abort();
    this.activeExecution?.handle?.cancel();
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
      active.controller.abort();
      active.handle?.cancel();
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
    const active = {
      taskId: claimed.task.id,
      runId: claimed.run.id,
      executionToken: claimed.run.executionToken,
      controller,
      handle: null as RunnerHandle | null,
      cancelled: false,
    };
    this.activeExecution = active;
    const emit = (event: RunnerEvent) =>
      this.handleRunnerEvent(claimed.run.id, claimed.run.executionToken, event);

    try {
      const workspace =
        this.runner.id === "codex"
          ? await this.prepareWorkspace(claimed)
          : { path: null, baseCommit: claimed.run.baseCommit };
      if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
        return;
      }
      active.handle = this.runner.start(
        {
          runId: claimed.run.id,
          taskId: claimed.task.id,
          title: claimed.task.title,
          goal: claimed.goal,
          acceptanceCriteria: claimed.acceptanceCriteria,
          worktreePath: workspace.path,
          outputSchemaPath: this.outputSchemaPath,
          signal: controller.signal,
        },
        emit,
      );

      const result = await active.handle.result;
      if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
        return;
      }
      const summary = formatRunnerResult(result);
      if (result.outcome === "succeeded") {
        const resultCommit = await this.commitWorkspace(
          claimed,
          workspace.path,
          workspace.baseCommit,
        );
        if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
          return;
        }
        this.publish(
          this.repository.completeRun(
            claimed.run.id,
            claimed.run.executionToken,
            summary,
            resultCommit ?? undefined,
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
    await this.options.gitService.fetchRepository(claimed.projectPath);
    const targetBase = await this.options.gitService.resolveRemoteTargetBase({
      repositoryPath: claimed.projectPath,
      targetBranch: claimed.run.targetBranch,
      fallbackRef: claimed.projectDefaultBaseRef,
    });
    this.publish(
      this.repository.setRunBaseCommit(claimed.run.id, claimed.run.executionToken, {
        targetBranch: targetBase.targetBranch,
        baseCommit: targetBase.baseCommit,
      }),
    );
    const worktreePath = resolve(this.options.worktreesPath, claimed.run.id);
    const branchName = `devloop/run/${claimed.run.id}`;
    await this.options.gitService.createWorktree({
      repositoryPath: claimed.projectPath,
      worktreePath,
      branchName,
      baseCommit: targetBase.baseCommit,
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
    });
    if (!this.isExecutionActive(claimed.run.id, claimed.run.executionToken)) {
      return resultCommit;
    }
    this.publish(
      this.repository.setRunPhase(
        claimed.run.id,
        claimed.run.executionToken,
        "PREPARING_REVIEW",
        "runner.review",
        `结果 Commit 已创建：${resultCommit.slice(0, 12)}`,
      ),
    );
    return resultCommit;
  }

  private isExecutionActive(runId: string, executionToken: string): boolean {
    const active = this.activeExecution;
    return active?.runId === runId && active.executionToken === executionToken && !active.cancelled;
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
