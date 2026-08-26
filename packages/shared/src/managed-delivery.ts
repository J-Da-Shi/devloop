import { z } from "zod";

export const taskExecutionModes = ["MANAGED", "STANDARD"] as const;
export const taskExecutionModeSchema = z.enum(taskExecutionModes);
export type TaskExecutionMode = z.infer<typeof taskExecutionModeSchema>;

export type BudgetConfidence = "LOW" | "MEDIUM" | "HIGH";

export type BudgetMeasurementSource = "ELAPSED_TIME_ESTIMATE" | "PROVIDER_REPORTED";

export interface TaskBudgetEstimate {
  currency: "CNY";
  lowCents: number;
  highCents: number;
  lowMinutes: number;
  highMinutes: number;
  confidence: BudgetConfidence;
  rationale: string[];
}

export interface TaskBudget extends TaskBudgetEstimate {
  hardLimitCents: number;
  consumedCents: number;
  warningPercent: number;
}

export interface RunBudgetUsage {
  currency: "CNY";
  estimatedCostCents: number;
  elapsedMs: number;
  hardLimitCents: number;
  warningAtCents: number;
  source: BudgetMeasurementSource;
}

export interface ManagedDeliverySettings {
  maxTaskBudgetCents: number;
  warningPercent: number;
  budgetOverrunPercent: number;
  autoRetryLimit: number;
  runnerHourlyRatesCents: {
    codex: number;
    "claude-code": number;
    fake: number;
  };
  version: number;
  updatedAt: string;
}
