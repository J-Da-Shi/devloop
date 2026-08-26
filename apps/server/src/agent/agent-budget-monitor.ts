import type { ClaimedTask, DevLoopRepository, EventfulResult } from "@devloop/db";

export interface AgentBudgetMonitorOptions {
  runnerId: string;
  checkIntervalMs?: number;
  now?: () => number;
  publish(result: EventfulResult<unknown>): void;
  onLimitReached(): void;
  onError(error: unknown): void;
}

export class AgentBudgetMonitor {
  private timer: NodeJS.Timeout | null = null;
  private activeUpdate: Promise<void> | null = null;
  private limitReached = false;
  private readonly startedAt: number;

  public constructor(
    private readonly repository: DevLoopRepository,
    private readonly claimed: ClaimedTask,
    private readonly options: AgentBudgetMonitorOptions,
  ) {
    this.startedAt = options.now?.() ?? Date.now();
  }

  start(): void {
    if (
      this.claimed.task.executionMode !== "MANAGED" ||
      this.claimed.task.budget.hardLimitCents <= 0
    ) {
      return;
    }
    this.timer = setInterval(
      () => void this.tick().catch(this.options.onError),
      this.options.checkIntervalMs ?? 5_000,
    );
    void this.tick().catch(this.options.onError);
  }

  async stop(persistFinalUsage = true): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.activeUpdate;
    if (persistFinalUsage && !this.limitReached) {
      await this.tick();
    }
  }

  private tick(): Promise<void> {
    if (this.limitReached) return Promise.resolve();
    if (this.activeUpdate) return this.activeUpdate;
    const update = this.updateUsage().finally(() => {
      if (this.activeUpdate === update) this.activeUpdate = null;
    });
    this.activeUpdate = update;
    return update;
  }

  private async updateUsage(): Promise<void> {
    try {
      const settings = this.repository.getManagedDeliverySettings();
      const rate =
        this.options.runnerId === "claude-code"
          ? settings.runnerHourlyRatesCents["claude-code"]
          : this.options.runnerId === "fake"
            ? settings.runnerHourlyRatesCents.fake
            : settings.runnerHourlyRatesCents.codex;
      const elapsedMs = Math.max(0, (this.options.now?.() ?? Date.now()) - this.startedAt);
      const estimatedCostCents = Math.ceil((elapsedMs * rate) / 3_600_000);
      const taskConsumedCents = Math.min(
        this.claimed.task.budget.hardLimitCents,
        this.claimed.task.budget.consumedCents + estimatedCostCents,
      );
      const result = this.repository.updateRunBudgetUsage(
        this.claimed.run.id,
        this.claimed.run.executionToken,
        { elapsedMs, estimatedCostCents, taskConsumedCents },
      );
      this.options.publish(result);
      if (taskConsumedCents >= this.claimed.task.budget.hardLimitCents) {
        this.limitReached = true;
        this.options.onLimitReached();
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (!error.message.includes("执行令牌已经失效") &&
          !error.message.includes("不再由此 Run 执行"))
      ) {
        throw error;
      }
    }
  }
}
