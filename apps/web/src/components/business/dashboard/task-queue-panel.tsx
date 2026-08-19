import { Button } from "antd";
import type { Task } from "@devloop/shared";
import { taskStatusText } from "../../../core/index.js";
import { EmptyState, StatusBadge } from "../../common/index.js";

interface TaskQueuePanelProps {
  title: string;
  tasks: Task[];
  emptyTitle: string;
  queue?: boolean;
  onSelect(task: Task): void;
}

export function TaskQueuePanel({
  title,
  tasks,
  emptyTitle,
  queue = false,
  onSelect,
}: TaskQueuePanelProps) {
  return (
    <section className="tool-panel compact-panel">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
        </div>
        <span>{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <EmptyState title={emptyTitle} />
      ) : (
        <div className="compact-list">
          {tasks.map((task, index) => (
            <Button
              key={task.id}
              type="text"
              className="compact-row"
              onClick={() => onSelect(task)}
            >
              {queue ? <span className="queue-index">{index + 1}</span> : null}
              <span>
                <strong>{task.title}</strong>
                <small>
                  {task.projectName}
                  {queue ? ` · 分数 ${task.priority}` : ""}
                </small>
              </span>
              {!queue ? (
                <StatusBadge status={task.status}>{taskStatusText[task.status]}</StatusBadge>
              ) : null}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
