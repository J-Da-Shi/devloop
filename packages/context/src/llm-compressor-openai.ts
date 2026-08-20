import { CooldownGate, type LlmCompressor } from "./llm-compressor.js";

export interface OpenAiCompressorOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  cooldownRounds?: number;
  maxCallsPerRun?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * OpenAI 兼容的 HTTP 客户端。走 chat/completions；不依赖 openai npm 包。
 * 由 AgentWorker 每个新 run 前调用 setCurrentTurn(newTurn) 更新轮次。
 */
export class OpenAiCompatibleLlmCompressor implements LlmCompressor {
  private readonly gate: CooldownGate;
  private currentTurn = 0;
  private callsThisRun = 0;
  private readonly maxCallsPerRun: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OpenAiCompressorOptions) {
    this.gate = new CooldownGate(opts.cooldownRounds ?? 5);
    this.maxCallsPerRun = opts.maxCallsPerRun ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  setCurrentTurn(turn: number): void {
    this.currentTurn = turn;
  }

  resetRun(): void {
    this.callsThisRun = 0;
  }

  isReady(): boolean {
    return this.callsThisRun < this.maxCallsPerRun && this.gate.isReady(this.currentTurn);
  }

  cooldown(): void {
    this.gate.consume(this.currentTurn);
    this.callsThisRun += 1;
  }

  async summarize(text: string, opts: { targetTokens: number; hint?: string }): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.opts.endpoint.replace(/\/$/, "")}/chat/completions`;
      const resp = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages: [
            {
              role: "system",
              content: `你是文本压缩助手。把用户消息压缩到约 ${opts.targetTokens} tokens 以内${
                opts.hint ? `，重点关注：${opts.hint}` : ""
              }。保留关键事实、路径、错误码。用中文输出。`,
            },
            { role: "user", content: text },
          ],
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`LLM 压缩器 HTTP ${resp.status}`);
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("LLM 压缩器返回内容为空");
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
