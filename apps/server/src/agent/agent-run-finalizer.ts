import type { ClaimedTask, DevLoopRepository, EventfulResult } from "@devloop/db";
import type { AgentWorkspace } from "./agent-run-common.js";
import type { AgentWorkspaceOperations } from "./agent-workspace-operations.js";

export interface AgentRunFinalizerOptions {
  publish(result: EventfulResult<unknown>): void;
  isExecutionActive(runId: string, executionToken: string): boolean;
  isInvalidExecutionError(error: unknown): boolean;
}

export class AgentRunFinalizer {
  public constructor(
    private readonly repository: DevLoopRepository,
    private readonly workspaceOperations: AgentWorkspaceOperations,
    private readonly options: AgentRunFinalizerOptions,
  ) {}

  async finalizeUnsuccessfulRun(
    claimed: ClaimedTask,
    outcome: "blocked" | "failed",
    summary: string,
    workspace: AgentWorkspace,
    signal: AbortSignal,
    onProcessGroupId: (processGroupId: number | null) => void,
  ): Promise<void> {
    let resultCommit: string | undefined;
    let finalSummary = summary;
    if (claimed.taskType === "DEVELOPMENT" && workspace.path) {
      try {
        const checkpoint = await this.workspaceOperations.commitWorkspace(
          claimed,
          workspace.path,
          workspace.baseCommit,
          signal,
          onProcessGroupId,
          "retry",
        );
        resultCommit = checkpoint ?? undefined;
        if (checkpoint) {
          this.options.publish(
            this.repository.recordRunEvent(
              claimed.run.id,
              "run.retry_checkpoint.saved",
              `已保存可用于重试的 Git 恢复点：${checkpoint.slice(0, 12)}`,
              { baseCommit: workspace.baseCommit, resultCommit: checkpoint },
            ),
          );
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        const message = error instanceof Error ? error.message : "未知 Git 错误";
        finalSummary = `${summary}\n\n未能保存本轮 Worktree 进度，重试将仅携带失败诊断：${message}`;
        try {
          this.options.publish(
            this.repository.recordRunEvent(
              claimed.run.id,
              "run.retry_checkpoint.failed",
              "未能保存可用于重试的 Git 恢复点",
              { error: message },
            ),
          );
        } catch (recordError) {
          if (!this.options.isInvalidExecutionError(recordError)) throw recordError;
        }
      }
    }
    if (!this.options.isExecutionActive(claimed.run.id, claimed.run.executionToken)) return;
    const finished =
      outcome === "blocked"
        ? this.repository.blockRun(
            claimed.run.id,
            claimed.run.executionToken,
            finalSummary,
            resultCommit,
          )
        : this.repository.failRun(
            claimed.run.id,
            claimed.run.executionToken,
            finalSummary,
            resultCommit,
          );
    this.options.publish(finished);
  }

  async finalizeBudgetPausedRun(
    claimed: ClaimedTask,
    workspace: AgentWorkspace,
    onProcessGroupId: (processGroupId: number | null) => void,
  ): Promise<void> {
    const checkpointController = new AbortController();
    let resultCommit: string | undefined;
    let checkpointMessage = "";
    if (claimed.taskType === "DEVELOPMENT" && workspace.path) {
      try {
        resultCommit =
          (await this.workspaceOperations.commitWorkspace(
            claimed,
            workspace.path,
            workspace.baseCommit,
            checkpointController.signal,
            onProcessGroupId,
            "retry",
          )) ?? undefined;
      } catch (error) {
        checkpointMessage = `\n\n预算暂停前未能保存 Git 检查点：${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    const budget = this.repository.getTask(claimed.task.id)?.budget ?? claimed.task.budget;
    const summary = `任务已达到预算硬上限 ¥${(budget.hardLimitCents / 100).toFixed(
      2,
    )}，平台已停止继续消耗。当前阶段结果和执行上下文已经保留；提高预算上限后可从最近检查点继续。${checkpointMessage}`;
    this.options.publish(
      this.repository.pauseRunForBudget(
        claimed.run.id,
        claimed.run.executionToken,
        summary,
        resultCommit,
      ),
    );
  }
}
