import type { LlmCompressor, ScratchpadStore } from "@devloop/context";
import type { GitService } from "@devloop/git";
import type { RunnerCapabilities } from "@devloop/shared";
import type { RunnerHandle } from "@devloop/runners";
import type { PlaywrightValidationService } from "../preview/playwright-validation-service.js";
import type { SkillService } from "../skills/skill-service.js";

export interface ContextBudgets {
  codex: number;
  "claude-code": number;
  fake: number;
  [key: string]: number;
}

export interface AgentWorkerOptions {
  /** 启用规划、执行、验收三个 Agent 阶段；关闭时保持历史单阶段兼容行为。 */
  rolePipelineEnabled?: boolean;
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
  /** 验收失败后在同一 Run 内回退执行阶段的最大修复轮次。 */
  rolePipelineMaxRepairAttempts?: number;
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
