import {
  NoopLlmCompressor,
  OpenAiCompatibleLlmCompressor,
  type LlmCompressor,
} from "@devloop/context";
import type { RuntimeConfig } from "../runtime-config.js";

/**
 * 从 runtime-config 读取压缩器配置；未配置 endpoint/apiKey 时返回 Noop 实现。
 * pipeline 遇 Noop 会自动降级为规则型头尾截断。
 */
export const createLlmCompressor = (cfg: RuntimeConfig["context"]["compressor"]): LlmCompressor => {
  if (!cfg.endpoint || !cfg.apiKey) return new NoopLlmCompressor();
  return new OpenAiCompatibleLlmCompressor({
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxCallsPerRun: cfg.maxCallsPerRun,
  });
};
