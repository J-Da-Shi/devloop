import { z } from "zod";

export const taskStatuses = [
  "DRAFT",
  "READY",
  "RUNNING",
  "REVIEW",
  "BLOCKED",
  "FAILED",
  "COMPLETED",
  "CANCELLED",
] as const;

export const runStatuses = [
  "CLAIMED",
  "PREPARING",
  "AGENT_RUNNING",
  "VERIFYING",
  "REPAIRING",
  "PREPARING_REVIEW",
  "SUCCEEDED",
  "BLOCKED",
  "FAILED",
  "INTERRUPTED",
  "CANCELLED",
] as const;

export const workerStatuses = ["RUNNING", "PAUSED", "STOPPED", "DEGRADED"] as const;
export const deviceRoles = ["viewer", "operator", "editor"] as const;
export const baseStrategies = ["LATEST_ACCEPTED", "PINNED"] as const;

export const taskStatusSchema = z.enum(taskStatuses);
export const runStatusSchema = z.enum(runStatuses);
export const workerStatusSchema = z.enum(workerStatuses);
export const deviceRoleSchema = z.enum(deviceRoles);
export const baseStrategySchema = z.enum(baseStrategies);

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type WorkerStatus = z.infer<typeof workerStatusSchema>;
export type DeviceRole = z.infer<typeof deviceRoleSchema>;
export type BaseStrategy = z.infer<typeof baseStrategySchema>;

export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBaseRef: string;
  integrationRef: string;
  integrationCommit: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  priority: number;
  activeRevisionId: string | null;
  latestRunId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRevision {
  id: string;
  taskId: string;
  revision: number;
  specHash: string;
  baseRef: string;
  baseStrategy: BaseStrategy;
  confirmedBaseCommit: string | null;
  confirmedAt: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  taskRevisionId: string;
  runner: string;
  status: RunStatus;
  baseCommit: string | null;
  resultCommit: string | null;
  branchName: string | null;
  runnerVersion: string | null;
  executionToken: string;
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  message: string;
  createdAt: string;
}

export interface RunApplicationResult {
  status: "applied" | "already_applied";
  branch: string;
  previousCommit: string;
  currentCommit: string;
}

export interface WorkerState {
  status: WorkerStatus;
  heartbeatAt: string;
  activeRunId: string | null;
  version: number;
}

export interface PairedDevice {
  id: string;
  name: string;
  role: DeviceRole;
  lastSeenAt: string | null;
  revokedAt: string | null;
  version: number;
  createdAt: string;
}

export interface DomainEvent<TPayload = unknown> {
  id: number;
  aggregateType: "project" | "task" | "run" | "worker" | "device";
  aggregateId: string;
  type: string;
  payload: TPayload;
  createdAt: string;
}

export interface RunnerCapabilities {
  id: string;
  available: boolean;
  version: string | null;
  executablePath: string | null;
  features: string[];
  error: string | null;
}

export interface DashboardSnapshot {
  worker: WorkerState;
  projects: Project[];
  tasks: Task[];
  currentRun: TaskRun | null;
  runnerCapabilities: RunnerCapabilities[];
}
