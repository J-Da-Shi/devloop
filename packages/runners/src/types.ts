import type { LlmCompressor, ScratchpadStore } from "@devloop/context";
import type { PreviewConfig, RetryContext, RunnerCapabilities, TaskType } from "@devloop/shared";

export interface RunnerSkill {
  id: string;
  name: string;
  description: string;
  version: number;
  contentHash: string;
  content: string;
}

/**
 * agent-worker 组装后注入到 RunnerInput 的上下文管理句柄。
 * runner 会在 buildTaskPrompt 里把它交给 pipeline，用于 medium 压缩落 ref、logger 采样等。
 */
export interface ContextPipelineRef {
  scratchpad: ScratchpadStore;
  llm: LlmCompressor | null;
  runId: string;
  turn?: number;
  logger?: (event: string, payload: Record<string, unknown>) => void;
}

export interface RunnerInput {
  runId: string;
  taskId: string;
  taskType?: TaskType;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  skills: RunnerSkill[];
  reviewFeedback?: string | null;
  retryContext?: RetryContext | null;
  mode?: "implementation" | "conflict-resolution";
  conflictPaths?: string[];
  worktreePath: string | null;
  outputSchemaPath: string | null;
  signal: AbortSignal;
  onProcessGroupId?: (processGroupId: number | null) => void;
  /** 上下文预算（token 估算），由 agent-worker 按 runner id 从 runtime-config 决定。 */
  contextBudget?: number;
  /** 上下文管理注入点；若省略则 buildTaskPrompt 会退回纯 join。 */
  contextPipeline?: ContextPipelineRef | null;
}

export interface RunnerEvent {
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface RunnerResult {
  outcome: "succeeded" | "blocked" | "failed";
  summary: string;
  risks: string[];
  acceptanceCriteria?: Array<{
    criterion: string;
    status: "passed" | "failed" | "not_verifiable";
    evidence: string;
  }>;
  blockedReason?: string | null;
  preview?: PreviewConfig | null;
}

export interface RunnerHandle {
  result: Promise<RunnerResult>;
  cancel(): void;
}

export interface AgentRunner {
  readonly id: string;
  detectCapabilities(): Promise<RunnerCapabilities>;
  start(input: RunnerInput, emit: (event: RunnerEvent) => void): RunnerHandle;
}
