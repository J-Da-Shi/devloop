import type { ClaimedTask, DevLoopRepository, EventfulResult } from "@devloop/db";
import type { AgentPlan, AgentRole, AgentVerification, RunStatus } from "@devloop/shared";
import type { AgentRunner, RunnerEvent, RunnerResult, RunnerSkill } from "@devloop/runners";
import { formatRunnerResult, type AgentWorkspace } from "./agent-run-common.js";
import type { ActiveExecution, AgentWorkerOptions } from "./agent-worker-types.js";
import type { AgentRunFinalizer } from "./agent-run-finalizer.js";

export interface AgentRoleStageContext {
  claimed: ClaimedTask;
  runner: AgentRunner;
  skills: RunnerSkill[];
  workspace: AgentWorkspace;
  active: ActiveExecution;
  emit: (event: RunnerEvent) => void;
  onProcessGroupId: (processGroupId: number | null) => void;
  repository: DevLoopRepository;
  publish: (result: EventfulResult<unknown>) => void;
  outputSchemaPath: string;
  options: AgentWorkerOptions;
  incrementTurn: (taskId: string) => number;
}

const roleNames: Record<AgentRole, string> = {
  planner: "规划 Agent",
  executor: "执行 Agent",
  verifier: "验收 Agent",
};

const eventNames: Record<AgentRole, string> = {
  planner: "planning",
  executor: "execution",
  verifier: "verification",
};

const verificationHasBlockingFindings = (
  verification: NonNullable<RunnerResult["verification"]>,
  requiredCriteria: string[] = [],
): boolean =>
  verification.status !== "passed" ||
  verification.criteria.some((criterion) => criterion.status !== "passed") ||
  verification.checks.some((check) => check.status === "failed") ||
  verification.issues.length > 0 ||
  requiredCriteria.some(
    (criterion) =>
      !verification.criteria.some((item) => item.criterion.trim() === criterion.trim()),
  );

const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

export async function runAgentStage(
  context: AgentRoleStageContext,
  role: AgentRole,
  plan: AgentPlan | null,
  executionResult: RunnerResult | null,
  verificationFeedback: AgentVerification | null = null,
): Promise<RunnerResult> {
  const { claimed, active, repository } = context;
  const status: RunStatus = role === "verifier" ? "VERIFYING" : "AGENT_RUNNING";
  const eventType = `run.agent.${eventNames[role]}.started`;
  context.publish(
    repository.setRunPhase(
      claimed.run.id,
      claimed.run.executionToken,
      status,
      eventType,
      `${roleNames[role]}开始工作`,
      { role },
    ),
  );
  const contextBudget = context.options.contextBudgets?.[context.runner.id];
  const scratchpad = context.options.scratchpad;
  const llm = context.options.llmCompressor ?? null;
  const turn = context.incrementTurn(claimed.task.id);
  if (
    llm &&
    typeof (llm as { setCurrentTurn?: (value: number) => void }).setCurrentTurn === "function"
  ) {
    (llm as unknown as { setCurrentTurn: (value: number) => void }).setCurrentTurn(turn);
  }
  const contextPipeline = scratchpad ? { scratchpad, llm, runId: claimed.run.id, turn } : null;
  const handle = context.runner.start(
    {
      runId: claimed.run.id,
      taskId: claimed.task.id,
      taskType: claimed.taskType,
      title: claimed.title,
      goal: claimed.goal,
      acceptanceCriteria: claimed.acceptanceCriteria,
      skills: context.skills,
      role,
      plan,
      executionResult,
      verificationFeedback,
      reviewFeedback: claimed.reviewFeedback,
      retryContext: claimed.retryContext,
      worktreePath: context.workspace.path,
      outputSchemaPath: context.outputSchemaPath,
      signal: active.controller.signal,
      onProcessGroupId: context.onProcessGroupId,
      ...(contextBudget !== undefined ? { contextBudget } : {}),
      ...(contextPipeline ? { contextPipeline } : {}),
    },
    (event) =>
      context.emit({
        ...event,
        data: { ...(event.data ?? {}), role },
      }),
  );
  active.handle = handle;
  try {
    return await handle.result;
  } finally {
    if (active.handle === handle) active.handle = null;
  }
}

export async function executeRolePipeline(
  context: AgentRoleStageContext,
  finalizer: AgentRunFinalizer,
): Promise<RunnerResult | null> {
  const { claimed, repository, active, onProcessGroupId } = context;
  const finalize = (outcome: "blocked" | "failed", summary: string) =>
    finalizer.finalizeUnsuccessfulRun(
      claimed,
      outcome,
      summary,
      context.workspace,
      active.controller.signal,
      onProcessGroupId,
    );
  const planningResult = await runAgentStage(context, "planner", null, null);
  if (planningResult.outcome !== "succeeded" || !planningResult.plan) {
    await finalize(
      planningResult.outcome === "blocked" ? "blocked" : "failed",
      `规划 Agent 未能生成可执行计划。\n\n${formatRunnerResult(planningResult)}`,
    );
    return null;
  }
  const plan = planningResult.plan;
  context.publish(repository.setRunPlan(claimed.run.id, claimed.run.executionToken, plan));

  let executionResult = await runAgentStage(context, "executor", plan, null);
  if (executionResult.outcome !== "succeeded") {
    await finalize(
      executionResult.outcome === "blocked" ? "blocked" : "failed",
      formatRunnerResult(executionResult),
    );
    return null;
  }

  const recordExecutionCompleted = (result: RunnerResult, repairAttempt: number): void => {
    context.publish(
      repository.recordRunEvent(
        claimed.run.id,
        "run.agent.execution.completed",
        repairAttempt === 0 ? "执行 Agent 已完成代码或研究交付" : "执行 Agent 已完成验收修复",
        { role: "executor", summary: result.summary, repairAttempt },
      ),
    );
  };
  recordExecutionCompleted(executionResult, 0);

  const configuredMaxRepairAttempts = context.options.rolePipelineMaxRepairAttempts;
  const maxRepairAttempts = Number.isFinite(configuredMaxRepairAttempts)
    ? Math.max(0, Math.floor(configuredMaxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS))
    : DEFAULT_MAX_REPAIR_ATTEMPTS;
  let repairAttempt = 0;
  while (true) {
    const verificationResult = await runAgentStage(context, "verifier", plan, executionResult);
    if (!verificationResult.verification) {
      await finalize(
        verificationResult.outcome === "blocked" ? "blocked" : "failed",
        "验收 Agent 未返回有效的验收报告。",
      );
      return null;
    }
    context.publish(
      repository.setRunVerification(
        claimed.run.id,
        claimed.run.executionToken,
        verificationResult.verification,
      ),
    );
    if (verificationResult.outcome !== "succeeded") {
      await finalize(
        verificationResult.outcome === "blocked" ? "blocked" : "failed",
        formatRunnerResult(verificationResult),
      );
      return null;
    }
    const requiredCriteria = [...claimed.acceptanceCriteria, ...plan.acceptanceCriteria].filter(
      (criterion, index, criteria) =>
        criteria.findIndex((item) => item.trim() === criterion.trim()) === index,
    );
    const missingCriteria = requiredCriteria.filter(
      (criterion) =>
        !verificationResult.verification?.criteria.some(
          (item) => item.criterion.trim() === criterion.trim(),
        ),
    );
    if (!verificationHasBlockingFindings(verificationResult.verification, requiredCriteria)) {
      return executionResult;
    }
    const failureSummary = [
      formatRunnerResult(verificationResult),
      `验收结论：${verificationResult.verification.summary}`,
      missingCriteria.length ? `验收标准未逐项核对：\n${missingCriteria.join("\n")}` : null,
      verificationResult.verification.issues.length
        ? `问题：\n${verificationResult.verification.issues.join("\n")}`
        : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    if (verificationResult.verification.status === "blocked") {
      await finalize("blocked", failureSummary);
      return null;
    }
    if (repairAttempt >= maxRepairAttempts) {
      await finalize(
        "failed",
        `${failureSummary}\n\n验收修复已达到本 Run 的最大轮次（${maxRepairAttempts}），已停止继续回退。`,
      );
      return null;
    }
    const repairFeedback: AgentVerification = missingCriteria.length
      ? {
          ...verificationResult.verification,
          issues: [
            ...verificationResult.verification.issues,
            `验收标准未在验收报告中逐项出现：${missingCriteria.join("；")}`,
          ],
        }
      : verificationResult.verification;
    repairAttempt += 1;
    context.publish(
      repository.recordRunEvent(
        claimed.run.id,
        "run.agent.execution.repair_requested",
        `验收未通过，回退执行 Agent 修复（第 ${repairAttempt} 轮）`,
        {
          role: "executor",
          repairAttempt,
          verification: repairFeedback,
        },
      ),
    );
    const repairedResult = await runAgentStage(
      context,
      "executor",
      plan,
      executionResult,
      repairFeedback,
    );
    if (repairedResult.outcome !== "succeeded") {
      await finalize(
        repairedResult.outcome === "blocked" ? "blocked" : "failed",
        formatRunnerResult(repairedResult),
      );
      return null;
    }
    executionResult = repairedResult;
    recordExecutionCompleted(executionResult, repairAttempt);
  }
}
