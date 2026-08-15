import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Statistic } from "antd";
import {
  Activity,
  CheckCircle2,
  Clock3,
  Cpu,
  ListChecks,
  Pause,
  Play,
  ShieldAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { Task } from "@devloop/shared";
import { api, getDashboardRefetchInterval, queryKeys } from "../api.js";
import { EmptyState, ErrorPanel, LoadingPanel } from "../components/feedback.js";
import { useNotice } from "../components/notice-provider.js";
import { RunEventList } from "../components/run-event-list.js";
import { StatusBadge } from "../components/status-badge.js";
import { TaskDialog } from "../components/task-dialog.js";
import {
  formatDateTime,
  formatDuration,
  runStatusText,
  taskStatusText,
  workerStatusText,
} from "../utils.js";

function ExecutionIdle({ queued }: { queued: boolean }) {
  return (
    <div className="execution-idle" role="status">
      <div className={`signal-monitor${queued ? " queued" : ""}`} aria-hidden="true">
        {[22, 46, 30, 62, 38, 54, 26, 44, 20].map((height, index) => (
          <span key={`${height}-${index}`} style={{ height }} />
        ))}
        <Activity size={24} />
      </div>
      <span className="execution-state">系统已就绪</span>
      <strong>等待下一个任务</strong>
      <small>{queued ? "队首任务即将由 Worker 领取" : "当前执行队列为空"}</small>
    </div>
  );
}

export function StatusPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: api.dashboard,
    refetchInterval: (query) => getDashboardRefetchInterval(query.state.data),
    refetchIntervalInBackground: true,
  });
  const currentRunId = dashboard.data?.currentRun?.id ?? null;
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

  const { worker, currentRun, tasks, projects } = dashboard.data;
  const currentTask = currentRun
    ? (tasks.find((task) => task.id === currentRun.taskId) ?? null)
    : null;
  const queuedTasks = tasks.filter((task) => task.status === "READY").slice(0, 4);
  const reviewTasks = tasks.filter((task) => task.status === "REVIEW").slice(0, 4);
  const workerRunning = worker.status === "RUNNING";

  return (
    <div className="page-stack">
      <section className="worker-strip" aria-live="polite">
        <div className="worker-node-mark">
          <Cpu size={21} aria-hidden="true" />
          <span>本机</span>
        </div>
        <div className="worker-primary">
          <div>
            <small>{currentTask ? "当前任务" : "本机 Worker"}</small>
            <strong>{currentTask ? currentTask.title : "当前空闲"}</strong>
            <span>
              {currentRun
                ? `${runStatusText[currentRun.status]} · 已运行 ${formatDuration(currentRun.startedAt, currentRun.finishedAt)}`
                : `最近心跳 ${formatDateTime(worker.heartbeatAt)}`}
            </span>
          </div>
        </div>
        <div className="worker-control">
          <StatusBadge status={worker.status} pulse={workerRunning}>
            Worker {workerStatusText[worker.status]}
          </StatusBadge>
          <Button
            type={workerRunning ? "default" : "primary"}
            icon={workerRunning ? <Pause size={17} /> : <Play size={17} />}
            loading={workerMutation.isPending}
            onClick={() => workerMutation.mutate(workerRunning ? "PAUSED" : "RUNNING")}
          >
            {workerRunning ? "暂停领取" : "继续运行"}
          </Button>
        </div>
      </section>

      <section className="metric-grid" aria-label="任务统计">
        {statistics.map((statistic) => {
          const Icon = statistic.icon;
          return (
            <div key={statistic.label} className={`metric-item metric-${statistic.tone}`}>
              <span className="metric-icon">
                <Icon size={18} aria-hidden="true" />
              </span>
              <Statistic
                title={statistic.label}
                value={statistic.value}
              />
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
                  ? `${currentRun.runner}${currentRun.runnerVersion ? ` · ${currentRun.runnerVersion}` : ""}`
                  : "无运行实例"}
              </span>
            </div>
            {currentRun ? (
              <StatusBadge status={currentRun.status} pulse={!currentRun.finishedAt}>
                {runStatusText[currentRun.status]}
              </StatusBadge>
            ) : null}
          </div>
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
          <section className="tool-panel compact-panel">
            <div className="section-heading">
              <div>
                <h2>待审核</h2>
              </div>
              <span>{reviewTasks.length}</span>
            </div>
            {reviewTasks.length === 0 ? (
              <EmptyState title="没有待审核任务" />
            ) : (
              <div className="compact-list">
                {reviewTasks.map((task) => (
                  <Button
                    key={task.id}
                    type="text"
                    className="compact-row"
                    onClick={() => setSelectedTask(task)}
                  >
                    <span>
                      <strong>{task.title}</strong>
                      <small>{task.projectName}</small>
                    </span>
                    <StatusBadge status={task.status}>{taskStatusText[task.status]}</StatusBadge>
                  </Button>
                ))}
              </div>
            )}
          </section>

          <section className="tool-panel compact-panel">
            <div className="section-heading">
              <div>
                <h2>执行队列</h2>
              </div>
              <span>{queuedTasks.length}</span>
            </div>
            {queuedTasks.length === 0 ? (
              <EmptyState title="队列为空" />
            ) : (
              <div className="compact-list">
                {queuedTasks.map((task, index) => (
                  <Button
                    key={task.id}
                    type="text"
                    className="compact-row"
                    onClick={() => setSelectedTask(task)}
                  >
                    <span className="queue-index">{index + 1}</span>
                    <span>
                      <strong>{task.title}</strong>
                      <small>
                        {task.projectName} · 分数 {task.priority}
                      </small>
                    </span>
                  </Button>
                ))}
              </div>
            )}
          </section>
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
