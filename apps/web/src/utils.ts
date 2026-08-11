import type { RunStatus, TaskStatus, WorkerStatus } from "@devloop/shared";

export const taskStatusText: Record<TaskStatus, string> = {
  DRAFT: "草稿",
  READY: "待执行",
  RUNNING: "执行中",
  REVIEW: "待审核",
  BLOCKED: "已阻塞",
  FAILED: "失败",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

export const runStatusText: Record<RunStatus, string> = {
  CLAIMED: "已领取",
  PREPARING: "准备中",
  AGENT_RUNNING: "Agent 执行中",
  VERIFYING: "验证中",
  REPAIRING: "修复中",
  PREPARING_REVIEW: "整理审核材料",
  SUCCEEDED: "执行成功",
  BLOCKED: "已阻塞",
  FAILED: "执行失败",
  INTERRUPTED: "已中断",
  CANCELLED: "已取消",
};

export const workerStatusText: Record<WorkerStatus, string> = {
  RUNNING: "运行中",
  PAUSED: "已暂停",
  STOPPED: "已停止",
  DEGRADED: "状态异常",
};

export const formatDateTime = (value: string | null): string => {
  if (!value) {
    return "暂无";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
};

export const formatDuration = (startedAt: string, finishedAt: string | null): string => {
  const milliseconds = new Date(finishedAt ?? Date.now()).getTime() - new Date(startedAt).getTime();
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
};

export const shortCommit = (value: string | null): string => (value ? value.slice(0, 8) : "暂无");

export const statusTone = (status: string): string => {
  if (["RUNNING", "AGENT_RUNNING", "PREPARING", "VERIFYING", "REPAIRING"].includes(status)) {
    return "running";
  }
  if (["COMPLETED", "SUCCEEDED"].includes(status)) {
    return "success";
  }
  if (["READY", "REVIEW", "PREPARING_REVIEW", "CLAIMED"].includes(status)) {
    return "info";
  }
  if (["BLOCKED", "PAUSED", "INTERRUPTED"].includes(status)) {
    return "warning";
  }
  if (["FAILED", "CANCELLED", "DEGRADED", "STOPPED"].includes(status)) {
    return "danger";
  }
  return "neutral";
};
