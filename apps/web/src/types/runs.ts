import type { RunConflictResolution } from "@devloop/shared";

export interface RunDiffApprovalState {
  expectedTargetCommit: string | null;
  conflictResolutions: RunConflictResolution[];
  unresolvedPaths: string[];
  agentResolving: boolean;
}
