import type { RunStatus, TaskStatus } from "./domain.js";

export const taskStatusLabels: Record<TaskStatus, string> = {
  DRAFT: "Draft",
  READY: "Ready",
  RUNNING: "Running",
  REVIEW: "Review",
  BLOCKED: "Blocked",
  FAILED: "Failed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const runStatusLabels: Record<RunStatus, string> = {
  CLAIMED: "Claimed",
  PREPARING: "Preparing",
  AGENT_RUNNING: "Agent running",
  VERIFYING: "Verifying",
  REPAIRING: "Repairing",
  PREPARING_REVIEW: "Preparing review",
  SUCCEEDED: "Succeeded",
  BLOCKED: "Blocked",
  FAILED: "Failed",
  INTERRUPTED: "Interrupted",
  CANCELLED: "Cancelled",
};

export const boardStatuses: TaskStatus[] = [
  "DRAFT",
  "READY",
  "RUNNING",
  "REVIEW",
  "BLOCKED",
  "COMPLETED",
];
