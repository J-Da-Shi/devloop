import { useQuery } from "@tanstack/react-query";
import { Filter, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { Task, TaskStatus } from "@devloop/shared";
import { api, getDashboardRefetchInterval, queryKeys } from "../api.js";
import { EmptyState, ErrorPanel, LoadingPanel } from "../components/feedback.js";
import { StatusBadge } from "../components/status-badge.js";
import { TaskDialog } from "../components/task-dialog.js";
import { formatDateTime, taskStatusText } from "../utils.js";

const columns: TaskStatus[] = [
  "DRAFT",
  "READY",
  "RUNNING",
  "REVIEW",
  "BLOCKED",
  "FAILED",
  "COMPLETED",
];

export function BoardPage() {
  const [projectFilter, setProjectFilter] = useState("all");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: api.dashboard,
    refetchInterval: (query) => getDashboardRefetchInterval(query.state.data),
    refetchIntervalInBackground: true,
  });
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    staleTime: 60_000,
  });

  const filteredTasks = useMemo(
    () =>
      (dashboard.data?.tasks ?? []).filter(
        (task) => projectFilter === "all" || task.projectId === projectFilter,
      ),
    [dashboard.data?.tasks, projectFilter],
  );

  if (dashboard.isPending) {
    return <LoadingPanel label="正在加载任务看板" />;
  }
  if (dashboard.isError) {
    return <ErrorPanel error={dashboard.error} />;
  }

  const canCreate = session.data?.identity.role === "editor";

  return (
    <div className="page-stack board-page">
      <div className="page-actions">
        <label className="compact-select">
          <Filter size={16} aria-hidden="true" />
          <span className="sr-only">筛选项目</span>
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="all">全部项目</option>
            {dashboard.data.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {canCreate ? (
          <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
            <Plus size={17} />
            创建任务
          </button>
        ) : null}
      </div>

      <section className="board-scroll" aria-label="任务状态看板">
        <div className="board-columns">
          {columns.map((status) => {
            const tasks = filteredTasks.filter((task) => task.status === status);
            return (
              <section key={status} className="board-column">
                <header>
                  <StatusBadge status={status} pulse={status === "RUNNING"}>
                    {taskStatusText[status]}
                  </StatusBadge>
                  <span>{tasks.length}</span>
                </header>
                <div className="board-task-list">
                  {tasks.length === 0 ? (
                    <EmptyState title="暂无任务" />
                  ) : (
                    tasks.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        className="task-card"
                        onClick={() => setSelectedTask(task)}
                      >
                        <span className="task-card-project">{task.projectName}</span>
                        <strong>{task.title}</strong>
                        <p>{task.goal}</p>
                        <span className="task-card-meta">
                          <span>分数 {task.priority}</span>
                          <time>{formatDateTime(task.updatedAt)}</time>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </section>

      <TaskDialog
        open={creating || Boolean(selectedTask)}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setSelectedTask(null);
          }
        }}
        task={selectedTask}
        projects={dashboard.data.projects}
      />
    </div>
  );
}
