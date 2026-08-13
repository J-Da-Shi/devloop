import type { RunStatus, TaskStatus } from "./domain.js";

export const taskStatusLabels: Record<TaskStatus, string> = {
  DRAFT: "草稿",
  READY: "待执行",
  RUNNING: "执行中",
  REVIEW: "待审核",
  BLOCKED: "已阻塞",
  FAILED: "失败",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

export const runStatusLabels: Record<RunStatus, string> = {
  CLAIMED: "已领取",
  PREPARING: "准备中",
  AGENT_RUNNING: "Agent 执行中",
  VERIFYING: "验证中",
  REPAIRING: "修复中",
  PREPARING_REVIEW: "整理审核结果",
  SUCCEEDED: "执行成功",
  BLOCKED: "已阻塞",
  FAILED: "失败",
  INTERRUPTED: "已中断",
  CANCELLED: "已取消",
};

export const boardStatuses: TaskStatus[] = [
  "DRAFT",
  "READY",
  "RUNNING",
  "REVIEW",
  "BLOCKED",
  "COMPLETED",
];
