import type { PreviewConfig, RunnerCapabilities, TaskType } from "@devloop/shared";

export interface RunnerSkill {
  id: string;
  name: string;
  description: string;
  version: number;
  contentHash: string;
  content: string;
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
  mode?: "implementation" | "conflict-resolution";
  conflictPaths?: string[];
  worktreePath: string | null;
  outputSchemaPath: string | null;
  signal: AbortSignal;
  onProcessGroupId?: (processGroupId: number | null) => void;
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
