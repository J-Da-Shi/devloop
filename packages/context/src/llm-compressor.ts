/**
 * LLM 压缩器接口。二级触发时被 pipeline 调用；未配置端点时使用 NoopLlmCompressor。
 */
export interface LlmCompressor {
  summarize(text: string, opts: { targetTokens: number; hint?: string }): Promise<string>;
  isReady(): boolean;
  cooldown(): void;
}

/**
 * 未配置 LLM 端点时的空实现：始终未就绪、调用 summarize 抛错。
 * pipeline 遇此实现会自动降级为规则型压缩。
 */
export class NoopLlmCompressor implements LlmCompressor {
  async summarize(
    _text: string,
    _opts: { targetTokens: number; hint?: string },
  ): Promise<string> {
    throw new Error("LLM 压缩器未配置端点");
  }
  isReady(): boolean {
    return false;
  }
  cooldown(): void {
    /* 未启用时的空操作 */
  }
}

/**
 * N 轮冷却门：一次 consume 后，接下来 N 轮内 isReady 均返回 false。
 * 「轮」由外部按 taskId 递增，见 pipeline / AgentWorker。
 */
export class CooldownGate {
  private lastConsumedTurn: number | null = null;
  constructor(private readonly rounds: number) {}
  consume(turn: number): boolean {
    if (!this.isReady(turn)) return false;
    this.lastConsumedTurn = turn;
    return true;
  }
  isReady(turn: number): boolean {
    if (this.lastConsumedTurn === null) return true;
    return turn - this.lastConsumedTurn >= this.rounds;
  }
}
