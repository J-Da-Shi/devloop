import { z } from "zod";

export const taskExecutionModes = ["MANAGED", "STANDARD"] as const;
export const taskExecutionModeSchema = z.enum(taskExecutionModes);
export type TaskExecutionMode = z.infer<typeof taskExecutionModeSchema>;

export const budgetConfidenceLevels = ["LOW", "MEDIUM", "HIGH"] as const;
export const budgetConfidenceSchema = z.enum(budgetConfidenceLevels);
export type BudgetConfidence = z.infer<typeof budgetConfidenceSchema>;

export const budgetMeasurementSources = ["ELAPSED_TIME_ESTIMATE", "PROVIDER_REPORTED"] as const;
export const budgetMeasurementSourceSchema = z.enum(budgetMeasurementSources);
export type BudgetMeasurementSource = z.infer<typeof budgetMeasurementSourceSchema>;

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

export const defaultManagedDeliverySettings = {
  maxTaskBudgetCents: 10_000,
  warningPercent: 80,
  budgetOverrunPercent: 25,
  autoRetryLimit: 2,
  runnerHourlyRatesCents: {
    codex: 2_000,
    "claude-code": 2_000,
    fake: 0,
  },
} as const;
