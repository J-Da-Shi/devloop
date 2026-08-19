import type {
  RunApplicationResult,
  RunChangedFile,
  RunChangedFileStatus,
  RunConflictFile,
  RunConflictPreview,
  RunConflictResolution,
  RunFilePatch,
  RunPublishResult,
} from "@devloop/shared";

export interface GitRepositoryInfo {
  path: string;
  branch: string;
  headCommit: string;
}

export interface GitCapabilities {
  available: boolean;
  version: string | null;
  executablePath: string | null;
  error: string | null;
}

export interface GitExecutionOptions {
  signal?: AbortSignal;
  onProcessGroupId?: (processGroupId: number | null) => void;
}

export interface CloneRepositoryInput {
  repositoryUrl: string;
  destinationPath: string;
  defaultBranch: string;
}

export interface ClonedRepositoryInfo {
  repositoryUrl: string;
  path: string;
  defaultBranch: string;
  headCommit: string;
}

export interface ResolveRemoteTargetBaseInput extends GitExecutionOptions {
  repositoryPath: string;
  targetBranch: string;
  fallbackRef: string;
}

export interface PushResultInput {
  repositoryPath: string;
  targetBranch: string;
  baseCommit: string;
  resultCommit: string;
}

export interface CreateWorktreeInput extends GitExecutionOptions {
  repositoryPath: string;
  worktreePath: string;
  branchName: string;
  baseCommit: string;
}

export interface CreateDetachedWorktreeInput extends GitExecutionOptions {
  repositoryPath: string;
  worktreePath: string;
  commit: string;
}

export interface RemoveManagedWorktreeInput {
  repositoryPath: string;
  worktreePath: string;
  managedRoot: string;
}

export interface CommitWorktreeInput extends GitExecutionOptions {
  worktreePath: string;
  message: string;
}

export interface ApplyCommitInput {
  repositoryPath: string;
  targetBranch: string;
  baseCommit: string;
  resultCommit: string;
  expectedTargetCommit?: string | null;
  conflictResolutions?: RunConflictResolution[];
}

export interface ConflictResolutionWorkspace {
  worktreePath: string;
  files: RunConflictFile[];
}

export interface GeneratedConflictResolutions {
  targetCommit: string;
  resolutions: RunConflictResolution[];
}

export interface ReconcileCommitInput {
  repositoryPath: string;
  targetBranch: string;
  targetCommit: string;
  baseCommit: string;
  resultCommit: string;
}

export type ReconcileCommitResult =
  | {
      status: "clean";
      targetCommit: string;
      resultCommit: string;
      resolutions: [];
    }
  | {
      status: "resolved";
      targetCommit: string;
      resultCommit: string;
      resolutions: RunConflictResolution[];
    };

export interface MoveWorktreeToCommitInput {
  worktreePath: string;
  expectedCommit: string;
  targetCommit: string;
}

export interface ListRunChangedFilesInput {
  repositoryPath: string;
  baseCommit: string;
  resultCommit: string;
}

export interface GetRunFilePatchInput {
  repositoryPath: string;
  baseCommit: string;
  resultCommit: string;
  path: string;
}

export interface ResolveTargetBaseInput extends GitExecutionOptions {
  repositoryPath: string;
  targetBranch: string;
  fallbackRef: string;
}

export interface ResolvedTargetBase {
  targetBranch: string;
  baseCommit: string;
  branchExists: boolean;
}

export type GitApplyErrorCode =
  | "WORKTREE_DIRTY"
  | "DETACHED_HEAD"
  | "INVALID_REPOSITORY"
  | "REPOSITORY_NOT_ROOT"
  | "INVALID_BRANCH"
  | "BRANCH_CHECKED_OUT"
  | "TARGET_BRANCH_CHANGED"
  | "TARGET_COMMIT_MISSING"
  | "BASE_COMMIT_MISSING"
  | "RESULT_COMMIT_MISSING"
  | "INVALID_RESULT_RANGE"
  | "INVALID_REPOSITORY_URL"
  | "REPOSITORY_EXISTS"
  | "REMOTE_ACCESS_FAILED"
  | "REMOTE_PUSH_REJECTED"
  | "APPLY_CONFLICT"
  | "APPLY_FAILED";

export class GitApplyError extends Error {
  public constructor(
    public readonly code: GitApplyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitApplyError";
  }
}

export type {
  RunApplicationResult,
  RunChangedFile,
  RunChangedFileStatus,
  RunConflictFile,
  RunConflictPreview,
  RunConflictResolution,
  RunFilePatch,
  RunPublishResult,
};
