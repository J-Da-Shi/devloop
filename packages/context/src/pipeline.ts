import { classifyFragment } from "./classifier.js";
import { decideTriggerLevel, type TriggerLevel } from "./budget-policy.js";
import { estimateTokens } from "./token-counter.js";
import { getCompressor } from "./compressors/index.js";
import type { LlmCompressor } from "./llm-compressor.js";
import type { ScratchpadStore } from "./scratchpad.js";
import type { CompressionLevel, Fragment, FragmentSpec } from "./types.js";

/**
 * Pipeline 无法把总 tokens 压到预算内时抛出。上层（AgentWorker）应捕获此错并把
 * Run 标记为 FAILED，附带 detail 供审计。
 */
export class ContextBudgetExceededError extends Error {
  constructor(
    public readonly detail: { totalTokens: number; budgetTokens: number; attempts: number },
  ) {
    super(`上下文超预算：${detail.totalTokens} > ${detail.budgetTokens}`);
    this.name = "ContextBudgetExceededError";
  }
}

export interface PipelineOptions {
  budgetTokens: number;
  runId: string;
  turn?: number;
  scratchpad: ScratchpadStore;
  llm?: LlmCompressor | null;
  logger?: (event: string, payload: Record<string, unknown>) => void;
  /** 默认 true：把 MEDIUM 阶段落入 scratchpad 的 ref 在交付前尽量展开回原文。 */
  expandRefs?: boolean;
}

export interface PipelineResult {
  text: string;
  fragments: Fragment[];
  stats: { triggerLevels: TriggerLevel[]; totalTokens: number };
}

/** 强级压缩最多重试次数；超过后进入硬切/异常兜底。 */
const MAX_STRONG_ATTEMPTS = 3;

const totalTokens = (frags: Fragment[]): number =>
  frags.reduce((s, f) => s + f.currentTokens, 0);

const applyLevel = async (
  frags: Fragment[],
  level: TriggerLevel,
  ctx: {
    scratchpad: ScratchpadStore;
    llm: LlmCompressor | null;
    runId: string;
    logger: NonNullable<PipelineOptions["logger"]>;
  },
): Promise<Fragment[]> => {
  if (level === "pass") return frags;
  const mapped: CompressionLevel =
    level === "weak" ? "WEAK" : level === "medium" ? "MEDIUM" : "STRONG";
  const next: Fragment[] = [];
  for (const f of frags) {
    const compressor = getCompressor(f.type);
    const out = await compressor.compress(f, mapped, {
      scratchpad: ctx.scratchpad,
      llm: ctx.llm,
      runId: ctx.runId,
      logger: ctx.logger,
    });
    if (out) next.push(out);
  }
  return next;
};

/**
 * 硬切：保留全部 SYSTEM + USER_QUERY；其余从尾部（最近产生）向前累加，直到不超预算。
 */
const hardCut = (frags: Fragment[], budget: number): Fragment[] => {
  const forced = frags.filter((f) => f.type === "SYSTEM" || f.type === "USER_QUERY");
  const remaining = frags.filter((f) => f.type !== "SYSTEM" && f.type !== "USER_QUERY");
  let used = totalTokens(forced);
  const kept: Fragment[] = [...forced];
  for (let i = remaining.length - 1; i >= 0; i -= 1) {
    if (used + remaining[i]!.currentTokens <= budget) {
      kept.push(remaining[i]!);
      used += remaining[i]!.currentTokens;
    }
  }
  return kept;
};

const specToFragment = async (spec: FragmentSpec, index: number): Promise<Fragment> => {
  const cls = await classifyFragment(spec);
  const tokens = estimateTokens(spec.text);
  return {
    id: spec.id ?? `f${index}`,
    type: cls.type,
    text: spec.text,
    originalTokens: tokens,
    currentTokens: tokens,
    compressionLevel: "NONE",
    droppable: cls.droppable,
    metadata: { ...(spec.metadata ?? {}) },
  };
};

/**
 * Ref 展开：把 MEDIUM 阶段写入 scratchpad 的 fragment 尽量替换回原文。
 * 从数组末尾（最近产生）向前尝试，展开后若累加超预算则保留占位。
 */
const expandRefs = async (
  frags: Fragment[],
  budget: number,
  store: ScratchpadStore,
): Promise<Fragment[]> => {
  let currentTotal = totalTokens(frags);
  const out = [...frags];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const f = out[i]!;
    if (f.compressionLevel !== "MEDIUM" || !f.metadata.scratchpadRef) continue;
    const row = await store.load(f.metadata.scratchpadRef);
    if (!row) continue;
    const tokens = estimateTokens(row.text);
    const delta = tokens - f.currentTokens;
    if (currentTotal + delta <= budget) {
      out[i] = { ...f, text: row.text, currentTokens: tokens };
      currentTotal += delta;
    }
  }
  return out;
};

/**
 * 主入口。给定一批 FragmentSpec 与预算，返回压缩后的最终文本与 Fragment 快照。
 *
 * 三层死锁保护：
 *   1. 每轮升级 strong 最多重试 MAX_STRONG_ATTEMPTS（3）次
 *   2. 仍超预算 → hardCut（保留 SYSTEM+USER_QUERY，其余从尾部保留）
 *   3. hardCut 仍超 → 抛 ContextBudgetExceededError
 */
export const compressUntilFits = async (
  specs: FragmentSpec[],
  opts: PipelineOptions,
): Promise<PipelineResult> => {
  const logger = opts.logger ?? (() => {});
  let fragments = await Promise.all(specs.map(specToFragment));
  const triggerLevels: TriggerLevel[] = [];
  const llm = opts.llm ?? null;

  let attempts = 0;
  while (true) {
    const level = decideTriggerLevel({
      currentTokens: totalTokens(fragments),
      budgetTokens: opts.budgetTokens,
      llmReady: llm ? llm.isReady() : false,
    });
    triggerLevels.push(level);
    logger(`context.compress.${level}`, {
      before: totalTokens(fragments),
      budget: opts.budgetTokens,
      attempts,
    });
    if (level === "pass") break;
    fragments = await applyLevel(fragments, level, {
      scratchpad: opts.scratchpad,
      llm,
      runId: opts.runId,
      logger,
    });
    if (totalTokens(fragments) <= opts.budgetTokens) break;
    if (level === "strong") attempts += 1;
    if (attempts >= MAX_STRONG_ATTEMPTS) break;
  }

  if (totalTokens(fragments) > opts.budgetTokens) {
    fragments = hardCut(fragments, opts.budgetTokens);
    logger("context.compress.strong", {
      hardCutApplied: true,
      total: totalTokens(fragments),
    });
  }
  if (totalTokens(fragments) > opts.budgetTokens) {
    logger("context.compress.fatal", {
      total: totalTokens(fragments),
      budget: opts.budgetTokens,
    });
    throw new ContextBudgetExceededError({
      totalTokens: totalTokens(fragments),
      budgetTokens: opts.budgetTokens,
      attempts,
    });
  }

  if (opts.expandRefs !== false) {
    fragments = await expandRefs(fragments, opts.budgetTokens, opts.scratchpad);
  }

  const text = fragments.map((f) => f.text).join("\n");
  return { text, fragments, stats: { triggerLevels, totalTokens: totalTokens(fragments) } };
};
