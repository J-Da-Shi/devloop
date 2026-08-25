import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Form, InputNumber, Segmented, Skeleton } from "antd";
import { Gauge } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ManagedBudgetEstimateInput, Task } from "@devloop/shared";
import type { UseFormReturn } from "react-hook-form";
import { Controller, useWatch } from "react-hook-form";
import { api, queryKeys } from "../../../core/index.js";
import {
  splitCriteria,
  taskExecutionModeOptions,
  type TaskFormValues,
} from "../../../types/index.js";

interface TaskBudgetConfiguratorProps {
  form: UseFormReturn<TaskFormValues>;
  task: Task | null;
  canEdit: boolean;
}

const formatYuan = (cents: number): string => `¥${(cents / 100).toFixed(2)}`;

export function TaskBudgetConfigurator({ form, task, canEdit }: TaskBudgetConfiguratorProps) {
  const values = useWatch({ control: form.control });
  const [debouncedInput, setDebouncedInput] = useState<ManagedBudgetEstimateInput | null>(null);
  const lastSuggestedYuan = useRef<number | undefined>(undefined);
  const executionMode = values.executionMode ?? "MANAGED";
  const criteria = useMemo(() => splitCriteria(values.criteriaText ?? ""), [values.criteriaText]);
  const estimateInput = useMemo<ManagedBudgetEstimateInput | null>(() => {
    const projectId = values.projectId;
    const title = values.title?.trim();
    const goal = values.goal?.trim();
    if (executionMode !== "MANAGED" || !projectId || !title || !goal || criteria.length === 0) {
      return null;
    }
    return {
      projectId,
      taskType: values.taskType ?? "DEVELOPMENT",
      executionMode,
      title,
      goal,
      acceptanceCriteria: criteria,
    };
  }, [criteria, executionMode, values.goal, values.projectId, values.taskType, values.title]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedInput(estimateInput);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [estimateInput]);

  const activeEstimateInput = estimateInput ? debouncedInput : null;

  const estimate = useQuery({
    queryKey: activeEstimateInput
      ? queryKeys.budgetEstimate(activeEstimateInput)
      : ["managed-delivery", "budget-estimate", "idle"],
    queryFn: () => {
      if (!activeEstimateInput) throw new Error("预算估算输入尚未准备完成");
      return api.estimateTaskBudget(activeEstimateInput);
    },
    enabled: Boolean(activeEstimateInput),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!estimate.data || task) return;
    const suggestedYuan = estimate.data.budget.hardLimitCents / 100;
    const current = form.getValues("budgetHardLimitYuan");
    if (current === undefined || current === lastSuggestedYuan.current) {
      form.setValue("budgetHardLimitYuan", suggestedYuan, { shouldValidate: true });
    }
    lastSuggestedYuan.current = suggestedYuan;
  }, [estimate.data, form, task]);

  const minimumYuan = task ? Math.floor(task.budget.consumedCents) / 100 + 0.01 : 1;
  const suggestedYuan = estimate.data?.budget.hardLimitCents
    ? estimate.data.budget.hardLimitCents / 100
    : undefined;

  return (
    <section className="task-budget-configurator" aria-label="任务托管与预算">
      <Form.Item label="执行方式" htmlFor="task-execution-mode" required>
        <Controller
          control={form.control}
          name="executionMode"
          render={({ field }) => (
            <Segmented
              id="task-execution-mode"
              block
              value={field.value}
              disabled={!canEdit}
              options={taskExecutionModeOptions}
              onChange={field.onChange}
            />
          )}
        />
      </Form.Item>

      {executionMode === "MANAGED" ? (
        <div className="task-budget-fields">
          <div className="task-budget-estimate" aria-live="polite">
            <span className="task-budget-estimate-icon">
              <Gauge size={18} aria-hidden="true" />
            </span>
            {estimate.isFetching ? (
              <Skeleton.Input active size="small" />
            ) : estimate.data ? (
              <span>
                <strong>
                  预计 {formatYuan(estimate.data.budget.lowCents)}-
                  {formatYuan(estimate.data.budget.highCents)}
                </strong>
                <small>
                  {estimate.data.budget.lowMinutes}-{estimate.data.budget.highMinutes} 分钟 ·
                  {estimate.data.budget.confidence === "HIGH"
                    ? "高置信度"
                    : estimate.data.budget.confidence === "MEDIUM"
                      ? "中置信度"
                      : "低置信度"}
                </small>
              </span>
            ) : (
              <span>
                <strong>等待预算估算</strong>
                <small>填写目标与验收标准后生成</small>
              </span>
            )}
          </div>
          {estimate.isError ? (
            <Alert
              type="warning"
              showIcon
              message={estimate.error instanceof Error ? estimate.error.message : "预算估算失败"}
            />
          ) : null}
          <Form.Item
            label="自动停止上限"
            required
            validateStatus={form.formState.errors.budgetHardLimitYuan ? "error" : ""}
            help={form.formState.errors.budgetHardLimitYuan?.message}
          >
            <div className="task-budget-limit-control">
              <Controller
                control={form.control}
                name="budgetHardLimitYuan"
                render={({ field }) => (
                  <InputNumber
                    ref={field.ref}
                    name={field.name}
                    value={field.value ?? null}
                    disabled={!canEdit}
                    min={minimumYuan}
                    max={100_000}
                    precision={2}
                    addonBefore="¥"
                    onBlur={field.onBlur}
                    onChange={(value) => field.onChange(value ?? undefined)}
                  />
                )}
              />
              {suggestedYuan !== undefined && estimate.data ? (
                <Button
                  disabled={!canEdit || form.getValues("budgetHardLimitYuan") === suggestedYuan}
                  onClick={() =>
                    form.setValue("budgetHardLimitYuan", suggestedYuan, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                >
                  使用建议 {formatYuan(estimate.data.budget.hardLimitCents)}
                </Button>
              ) : null}
            </div>
          </Form.Item>
          {task && task.budget.consumedCents > 0 ? (
            <Alert
              type={task.status === "BUDGET_PAUSED" ? "warning" : "info"}
              showIcon
              message={`已消耗 ${formatYuan(task.budget.consumedCents)}，新上限必须高于该金额`}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
