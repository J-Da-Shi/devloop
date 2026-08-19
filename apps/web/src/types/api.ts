import type {
  DeviceRole,
  PlaywrightValidationReport,
  ReviewDecision,
  RunApplicationResult,
  RunArtifact,
  RunChangedFile,
  RunConflictAgentResolution,
  RunConflictPreview,
  RunEvent,
  RunPreviewConfig,
  RunPublishResult,
  Task,
  TaskRevision,
  TaskRun,
} from "@devloop/shared";

export interface RequestIdentity {
  id: string;
  name: string;
  role: DeviceRole;
  kind: "owner";
}

export interface RunDetails {
  run: TaskRun;
  task: Task | null;
  revision: TaskRevision;
  reviewDecision: ReviewDecision | null;
  events: RunEvent[];
  validation: {
    report: PlaywrightValidationReport | null;
    artifacts: RunArtifact[];
  };
  previewConfiguration: RunPreviewConfig | null;
}

export interface RunApprovalResponse {
  task: Task;
  publication?: RunPublishResult;
  application?: RunApplicationResult;
  research?: { status: "accepted"; summary: string };
  replayed: boolean;
}

export interface RunChangedFilesResponse {
  files: RunChangedFile[];
  conflictPreview: RunConflictPreview | null;
  agentResolution: RunConflictAgentResolution | null;
}
