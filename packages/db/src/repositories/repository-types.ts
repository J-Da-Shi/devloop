import type {
  BaseStrategy,
  DomainEvent,
  PairedDevice,
  Project,
  RunApplicationResult,
  RunArtifact,
  RunPublishResult,
  RetryContext,
  Skill,
  SkillVersion,
  Task,
  TaskRun,
  TaskType,
} from "@devloop/shared";

export interface EventfulResult<T> {
  value: T;
  events: DomainEvent[];
  replayed: boolean;
}

export interface RegisteredProjectInput {
  id?: string;
  name: string;
  repositoryUrl: string | null;
  repositoryPath: string;
  defaultBaseRef: string;
  headCommit: string;
  lastFetchedAt?: string | null;
  runner?: string;
}

export interface ProjectExecutionContext {
  project: Project;
  repositoryPath: string;
}

export interface ClaimedTask {
  task: Task;
  run: TaskRun;
  taskType: TaskType;
  projectPath: string;
  projectDefaultBaseRef: string;
  projectRepositoryUrl: string | null;
  projectRunner: string;
  previewCommand: string | null;
  previewWorkingDirectory: string;
  previewHealthPath: string;
  playwrightEnabled: boolean;
  playwrightTestCommand: string | null;
  autoResolveConflicts: boolean;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  reviewFeedback: string | null;
  retryContext: RetryContext | null;
  continuationBaseCommit: string | null;
  continuationResultCommit: string | null;
}

export interface RunApplicationContext {
  projectPath: string;
  targetBranch: string;
  baseCommit: string;
  resultCommit: string;
}

export interface RunPublishContext {
  repositoryPath: string;
  targetBranch: string;
  baseCommit: string;
  resultCommit: string;
}

export interface PublishedRunApproval {
  task: Task;
  publication: RunPublishResult;
}

export interface AppliedRunApproval {
  task: Task;
  application: RunApplicationResult;
}

export interface ResearchRunApproval {
  task: Task;
  research: {
    status: "accepted";
    summary: string;
  };
}

export type RunApprovalResult = PublishedRunApproval | AppliedRunApproval | ResearchRunApproval;

export type RunApprovalContext =
  | { type: "remote"; context: RunPublishContext }
  | { type: "local"; context: RunApplicationContext }
  | { type: "research"; context: { summary: string } };

export interface StoredSkillVersionInput {
  name: string;
  description: string;
  contentHash: string;
  storagePath: string;
}

export interface StoredSkillDetails {
  skill: Skill;
  versions: SkillVersion[];
  storagePath: string;
}

export interface StoredRunArtifact {
  artifact: RunArtifact;
  storagePath: string;
}

export interface TaskRevisionSpecSnapshot {
  taskType: TaskType;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  reviewFeedback: string | null;
  autoResolveConflicts: boolean;
  retryContext: RetryContext | null;
  continuationBaseCommit: string | null;
  continuationResultCommit: string | null;
}

export interface ConfirmTaskInput {
  expectedVersion: number;
  idempotencyKey: string;
  baseStrategy: BaseStrategy;
  baseRef: string;
}

export interface UpdateDraftTaskInput {
  taskType?: TaskType | undefined;
  targetBranch?: string | undefined;
  autoResolveConflicts?: boolean | undefined;
  title?: string | undefined;
  goal?: string | undefined;
  acceptanceCriteria?: string[] | undefined;
  priority?: number | undefined;
  expectedVersion: number;
  idempotencyKey: string;
}
