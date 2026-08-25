import type {
  ManagedDeliverySettings,
  ProjectRunner,
  TaskBudget,
  TaskExecutionMode,
  TaskType,
} from "@devloop/shared";

export interface TaskBudgetEstimateRequest {
  taskType: TaskType;
  executionMode: TaskExecutionMode;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
}

export function estimateTaskBudget(
  input: TaskBudgetEstimateRequest,
  runner: ProjectRunner,
  settings: ManagedDeliverySettings,
): TaskBudget {
  const rate = settings.runnerHourlyRatesCents[runner];
  const baseMinutes = input.taskType === "RESEARCH" ? 45 : 75;
  const goalMinutes = Math.ceil(input.goal.trim().length / 500) * 12;
  const criteriaMinutes = input.acceptanceCriteria.length * 10;
  const titleMinutes = input.title.trim().length > 80 ? 10 : 0;
  const expectedMinutes = Math.max(20, baseMinutes + goalMinutes + criteriaMinutes + titleMinutes);
  const lowMinutes = Math.max(15, Math.round(expectedMinutes * 0.7));
  const highMinutes = Math.max(lowMinutes, Math.ceil(expectedMinutes * 1.45));
  const lowCents = Math.ceil((lowMinutes * rate) / 60);
  const highCents = Math.ceil((highMinutes * rate) / 60);
  const describedWell = input.goal.trim().length >= 500 && input.acceptanceCriteria.length >= 3;
  const confidence = describedWell
    ? "HIGH"
    : input.goal.trim().length >= 180 && input.acceptanceCriteria.length >= 2
      ? "MEDIUM"
      : "LOW";
  const projectedLimit = Math.ceil((highCents * (100 + settings.budgetOverrunPercent)) / 100);
  const hardLimitCents =
    input.executionMode === "MANAGED" && rate > 0
      ? Math.min(settings.maxTaskBudgetCents, Math.max(highCents, projectedLimit))
      : 0;
  const rationale = [
    `${input.taskType === "RESEARCH" ? "研究" : "开发"}任务基础工作量约 ${baseMinutes} 分钟`,
    `目标描述和 ${input.acceptanceCriteria.length} 条验收标准增加约 ${goalMinutes + criteriaMinutes + titleMinutes} 分钟`,
    rate > 0
      ? `${runner} 当前估算费率为 ¥${(rate / 100).toFixed(2)}/小时`
      : `${runner} 尚未配置估算费率，仅预测执行时间`,
  ];
  return {
    currency: "CNY",
    lowCents,
    highCents,
    lowMinutes,
    highMinutes,
    confidence,
    rationale,
    hardLimitCents,
    consumedCents: 0,
    warningPercent: settings.warningPercent,
  };
}
