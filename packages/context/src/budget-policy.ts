export type TriggerLevel = "pass" | "weak" | "medium" | "strong";

export interface BudgetPolicyInput {
  currentTokens: number;
  budgetTokens: number;
  llmReady: boolean;
}

/** 触发中级压缩（medium）的下界比例；<= 60% 视为无需压缩。 */
export const MEDIUM_THRESHOLD_RATIO = 0.6;
/** 触发强级压缩（strong）的下界比例；> 90% 强制走 strong 兜底。 */
export const STRONG_THRESHOLD_RATIO = 0.9;

/**
 * 三级触发决策：
 * - <= 60% → pass
 * - (60%, 90%] → llm 就绪 medium，否则 weak
 * - > 90%    → strong（忽略 llm 就绪状态）
 * - budgetTokens <= 0 → strong（异常兜底，让上层继续尝试或抛异常）
 */
export const decideTriggerLevel = (input: BudgetPolicyInput): TriggerLevel => {
  const { currentTokens, budgetTokens, llmReady } = input;
  if (budgetTokens <= 0) return "strong";
  const ratio = currentTokens / budgetTokens;
  if (ratio <= MEDIUM_THRESHOLD_RATIO) return "pass";
  if (ratio > STRONG_THRESHOLD_RATIO) return "strong";
  return llmReady ? "medium" : "weak";
};
