import { useQuery } from "@tanstack/react-query";
import { Button, Select } from "antd";
import { Filter, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { Task, TaskStatus } from "@devloop/shared";
import { api, getDashboardRefetchInterval, queryKeys } from "../core/index.js";
import { ErrorPanel, LoadingPanel } from "../components/common/index.js";
import { TaskBoardColumn, TaskDialog } from "../components/business/tasks/index.js";

const columns: TaskStatus[] = [
  "DRAFT",
  "READY",
  "RUNNING",
  "REVIEW",
  "BLOCKED",
  "FAILED",
  "COMPLETED",
  "CANCELLED",
];

export function BoardPage() {
  const [projectFilter, setProjectFilter] = useState("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
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
  const selectedTask = useMemo<Task | null>(
    () => dashboard.data?.tasks.find((task) => task.id === selectedTaskId) ?? null,
    [dashboard.data?.tasks, selectedTaskId],
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
        <div className="compact-select">
          <Filter size={16} aria-hidden="true" />
          <Select
            aria-label="筛选项目"
            value={projectFilter}
            onChange={setProjectFilter}
            options={[
              { label: "全部项目", value: "all" },
              ...dashboard.data.projects.map((project) => ({
                label: project.name,
                value: project.id,
              })),
            ]}
          />
        </div>
        {canCreate ? (
          <Button type="primary" icon={<Plus size={17} />} onClick={() => setCreating(true)}>
            创建任务
          </Button>
        ) : null}
      </div>

      <section className="board-scroll" aria-label="任务状态看板">
        <div className="board-columns">
          {columns.map((status) => (
            <TaskBoardColumn
              key={status}
              status={status}
              tasks={filteredTasks.filter((task) => task.status === status)}
              onSelect={(task) => setSelectedTaskId(task.id)}
            />
          ))}
        </div>
      </section>

      <TaskDialog
        open={creating || Boolean(selectedTaskId)}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setSelectedTaskId(null);
          }
        }}
        task={selectedTask}
        projects={dashboard.data.projects}
      />
    </div>
  );
}
