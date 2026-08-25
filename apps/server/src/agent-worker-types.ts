import type { LlmCompressor, ScratchpadStore } from "@devloop/context";
import type { GitService } from "@devloop/git";
import type { RunnerCapabilities } from "@devloop/shared";
import type { RunnerHandle } from "@devloop/runners";
import type { PlaywrightValidationService } from "./playwright-validation-service.js";
import type { SkillService } from "./skill-service.js";

export interface ContextBudgets {
  codex: number;
  "claude-code": number;
  fake: number;
  [key: string]: number;
}

export interface AgentWorkerOptions {
  claimDelayMs?: number;
  now?: () => number;
  defaultRunnerId?: string;
  runnerCapabilities?: RunnerCapabilities[];
  gitService?: Pick<
    GitService,
    | "fetchRepository"
    | "resolveRemoteTargetBase"
    | "resolveTargetBase"
    | "createWorktree"
    | "commitWorktree"
    | "reconcileCommitConflicts"
    | "moveWorktreeToCommit"
  >;
  worktreesPath?: string;
  terminateProcessGroup?: (processGroupId: number) => void;
  skillService?: Pick<SkillService, "listEnabledForExecution">;
  playwrightValidationService?: Pick<PlaywrightValidationService, "validate">;
  scratchpad?: ScratchpadStore;
  llmCompressor?: LlmCompressor;
  contextBudgets?: ContextBudgets;
  budgetCheckIntervalMs?: number;
  budgetNow?: () => number;
  managedRetryDelayMs?: number;
}

export interface ActiveExecution {
  taskId: string;
  runId: string;
  executionToken: string;
  controller: AbortController;
  handle: RunnerHandle | null;
  processGroupId: number | null;
  cancelled: boolean;
  budgetExceeded: boolean;
}
