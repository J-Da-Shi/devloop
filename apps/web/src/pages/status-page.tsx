import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Statistic, Tabs } from "antd";
import { CheckCircle2, Clock3, ListChecks, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { Task } from "@devloop/shared";
import {
  api,
  formatDateTime,
  getDashboardRefetchInterval,
  queryKeys,
  runStatusText,
} from "../core/index.js";
import { ErrorPanel, LoadingPanel, StatusBadge, useNotice } from "../components/common/index.js";
import {
  ExecutionIdle,
  TaskQueuePanel,
  WorkerStrip,
} from "../components/business/dashboard/index.js";
import { RunEventList } from "../components/business/runs/index.js";
import { TaskDialog } from "../components/business/tasks/index.js";

export function StatusPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: api.dashboard,
    refetchInterval: (query) => getDashboardRefetchInterval(query.state.data),
    refetchIntervalInBackground: true,
  });
  const activeRuns = dashboard.data?.activeRuns ?? [];
  const currentRun = activeRuns.find((run) => run.id === selectedRunId) ?? activeRuns[0] ?? null;
  const currentRunId = currentRun?.id ?? null;
  const runDetails = useQuery({
    queryKey: queryKeys.run(currentRunId ?? "none"),
    queryFn: () => api.run(currentRunId ?? ""),
    enabled: Boolean(currentRunId),
    refetchInterval: currentRunId ? 5_000 : false,
  });
  const workerMutation = useMutation({
    mutationFn: api.setWorkerStatus,
    onSuccess: async (_data, status) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
      notify(status === "RUNNING" ? "Worker 已继续运行" : "Worker 已暂停");
    },
    onError: (error) => notify(error instanceof Error ? error.message : "操作失败", "danger"),
  });

  const statistics = useMemo(() => {
    const tasks = dashboard.data?.tasks ?? [];
    return [
      {
        label: "待执行",
        value: tasks.filter((task) => task.status === "READY").length,
        icon: Clock3,
        tone: "info",
      },
      {
        label: "待审核",
        value: tasks.filter((task) => task.status === "REVIEW").length,
        icon: ListChecks,
        tone: "warning",
      },
      {
        label: "阻塞或失败",
        value: tasks.filter((task) => task.status === "BLOCKED" || task.status === "FAILED").length,
        icon: ShieldAlert,
        tone: "danger",
      },
      {
        label: "已完成",
        value: tasks.filter((task) => task.status === "COMPLETED").length,
        icon: CheckCircle2,
        tone: "success",
      },
    ];
  }, [dashboard.data?.tasks]);

  if (dashboard.isPending) {
    return <LoadingPanel label="正在读取执行状态" />;
  }
  if (dashboard.isError) {
    return <ErrorPanel error={dashboard.error} />;
  }

  const { worker, tasks, projects } = dashboard.data;
  const currentTask = currentRun
    ? (tasks.find((task) => task.id === currentRun.taskId) ?? null)
    : null;
  const queuedTasks = tasks.filter((task) => task.status === "READY").slice(0, 4);
  const reviewTasks = tasks.filter((task) => task.status === "REVIEW").slice(0, 4);
  const workerRunning = worker.status === "RUNNING";

  return (
    <div className="page-stack">
      <WorkerStrip
        worker={worker}
        activeRunCount={activeRuns.length}
        loading={workerMutation.isPending}
        onToggle={() => workerMutation.mutate(workerRunning ? "PAUSED" : "RUNNING")}
      />

      <section className="metric-grid" aria-label="任务统计">
        {statistics.map((statistic) => {
          const Icon = statistic.icon;
          return (
            <div key={statistic.label} className={`metric-item metric-${statistic.tone}`}>
              <span className="metric-icon">
                <Icon size={18} aria-hidden="true" />
              </span>
              <Statistic title={statistic.label} value={statistic.value} />
            </div>
          );
        })}
      </section>

      <div className="dashboard-grid">
        <section className="tool-panel run-panel">
          <div className="section-heading">
            <div>
              <h2>当前执行</h2>
              <span>
                {currentRun
                  ? `${activeRuns.length}/${worker.concurrencyLimit} 个槽位使用中 · ${currentRun.runner}${currentRun.runnerVersion ? ` · ${currentRun.runnerVersion}` : ""}`
                  : "无运行实例"}
              </span>
            </div>
            {currentRun ? (
              <StatusBadge status={currentRun.status} pulse={!currentRun.finishedAt}>
                {runStatusText[currentRun.status]}
              </StatusBadge>
            ) : null}
          </div>
          {activeRuns.length > 1 ? (
            <Tabs
              className="active-run-tabs"
              activeKey={currentRun ? currentRun.id : activeRuns[0]!.id}
              onChange={setSelectedRunId}
              items={activeRuns.map((run) => {
                const task = tasks.find((item) => item.id === run.taskId);
                return {
                  key: run.id,
                  label: <span title={task?.title}>{task?.title ?? run.id.slice(0, 8)}</span>,
                };
              })}
            />
          ) : null}
          {!currentRun ? (
            <ExecutionIdle queued={queuedTasks.length > 0} />
          ) : runDetails.isPending ? (
            <LoadingPanel label="正在加载执行事件" />
          ) : runDetails.isError ? (
            <ErrorPanel error={runDetails.error} />
          ) : (
            <div className="current-run-content">
              <div className="run-meta-grid">
                <span>
                  <small>任务</small>
                  <strong>{currentTask?.title ?? "未知任务"}</strong>
                </span>
                <span>
                  <small>开始时间</small>
                  <strong>{formatDateTime(currentRun.startedAt)}</strong>
                </span>
                <span>
                  <small>目标分支</small>
                  <code>{currentRun.targetBranch}</code>
                </span>
                <span>
                  <small>基础 Commit</small>
                  <code>{currentRun.baseCommit?.slice(0, 10) ?? "暂无"}</code>
                </span>
              </div>
              <RunEventList
                events={runDetails.data.events}
                streamKey={runDetails.data.run.id}
                label="当前执行日志"
              />
            </div>
          )}
        </section>

        <div className="dashboard-side">
          <TaskQueuePanel
            title="待审核"
            tasks={reviewTasks}
            emptyTitle="没有待审核任务"
            onSelect={setSelectedTask}
          />
          <TaskQueuePanel
            title="执行队列"
            tasks={queuedTasks}
            emptyTitle="队列为空"
            queue
            onSelect={setSelectedTask}
          />
        </div>
      </div>

      <TaskDialog
        open={Boolean(selectedTask)}
        onOpenChange={(open) => !open && setSelectedTask(null)}
        task={selectedTask}
        projects={projects}
      />
    </div>
  );
}
