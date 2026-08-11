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
  gitService?: Pick<GitService, "createWorktree" | "commitWorktree">;
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
  private activeHandle: RunnerHandle | null = null;

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
        this.publish(
          this.repository.failRun(
            persisted.activeRunId,
            "本地服务重启，上一轮执行已标记为中断，请检查后重试。",
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
    this.activeHandle?.cancel();
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
          this.activeHandle = null;
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
    const emit = (event: RunnerEvent) => this.handleRunnerEvent(claimed.run.id, event);

    try {
      const worktreePath = this.runner.id === "codex" ? await this.prepareWorkspace(claimed) : null;
      this.activeHandle = this.runner.start(
        {
          runId: claimed.run.id,
          taskId: claimed.task.id,
          title: claimed.task.title,
          goal: claimed.goal,
          acceptanceCriteria: claimed.acceptanceCriteria,
          worktreePath,
          outputSchemaPath: this.outputSchemaPath,
          signal: controller.signal,
        },
        emit,
      );

      const result = await this.activeHandle.result;
      const summary = formatRunnerResult(result);
      if (result.outcome === "succeeded") {
        const resultCommit = await this.commitWorkspace(claimed, worktreePath);
        this.publish(
          this.repository.completeRun(claimed.run.id, summary, resultCommit ?? undefined),
        );
      } else if (result.outcome === "blocked") {
        this.publish(this.repository.blockRun(claimed.run.id, summary));
      } else {
        this.publish(this.repository.failRun(claimed.run.id, summary));
      }
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "执行已由本机服务中断。"
          : error instanceof Error
            ? error.message
            : "执行器发生未知错误。";
      this.publish(this.repository.failRun(claimed.run.id, message));
    }
  }

  private handleRunnerEvent(runId: string, event: RunnerEvent): void {
    const status = phaseByEvent[event.type];
    if (!status) {
      return;
    }
    this.publish(this.repository.setRunPhase(runId, status, event.type, event.message, event.data));
  }

  private async prepareWorkspace(claimed: ClaimedTask): Promise<string | null> {
    if (this.runner.id !== "codex") {
      return null;
    }
    if (!this.options.gitService || !this.options.worktreesPath) {
      throw new Error("真实执行器缺少 Git Worktree 配置");
    }
    if (!claimed.run.baseCommit) {
      throw new Error("任务运行缺少基础 Commit，无法创建 Worktree");
    }

    this.publish(
      this.repository.setRunPhase(
        claimed.run.id,
        "PREPARING",
        "runner.preparing",
        "正在创建独立 Git Worktree",
      ),
    );
    const worktreePath = resolve(this.options.worktreesPath, claimed.run.id);
    const branchName = `devloop/run/${claimed.run.id}`;
    await this.options.gitService.createWorktree({
      repositoryPath: claimed.projectPath,
      worktreePath,
      branchName,
      baseCommit: claimed.run.baseCommit,
    });
    this.publish(
      this.repository.setRunWorkspace(claimed.run.id, claimed.run.executionToken, {
        worktreePath,
        branchName,
      }),
    );
    return worktreePath;
  }

  private async commitWorkspace(
    claimed: ClaimedTask,
    worktreePath: string | null,
  ): Promise<string | null> {
    if (!worktreePath || !this.options.gitService) {
      return claimed.run.baseCommit;
    }
    this.publish(
      this.repository.setRunPhase(
        claimed.run.id,
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
    this.publish(
      this.repository.setRunPhase(
        claimed.run.id,
        "PREPARING_REVIEW",
        "runner.review",
        `结果 Commit 已创建：${resultCommit.slice(0, 12)}`,
      ),
    );
    return resultCommit;
  }

  private publish(result: EventfulResult<unknown>): void {
    this.eventBus.publish(result.events);
  }
}
