import type { TaskStatus } from "./domain.js";

const allowedTaskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  DRAFT: new Set(["READY", "CANCELLED"]),
  READY: new Set(["DRAFT", "RUNNING", "CANCELLED"]),
  RUNNING: new Set(["REVIEW", "BLOCKED", "FAILED", "CANCELLED"]),
  REVIEW: new Set(["COMPLETED", "READY", "CANCELLED"]),
  BLOCKED: new Set(["DRAFT", "READY"]),
  FAILED: new Set(["DRAFT", "READY"]),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTaskTransitions[from].has(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}
