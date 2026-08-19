import { Card } from "antd";
import { GitBranch, Search } from "lucide-react";
import type { Task } from "@devloop/shared";
import { formatDateTime, taskTypeText } from "../../../core/index.js";

interface TaskCardProps {
  task: Task;
  onOpen(task: Task): void;
}

export function TaskCard({ task, onOpen }: TaskCardProps) {
  return (
    <Card
      size="small"
      hoverable
      className="task-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(task)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(task);
        }
      }}
    >
      <span className="task-card-project">{task.projectName}</span>
      <strong>{task.title}</strong>
      <p>{task.goal}</p>
      <span className="task-card-meta">
        {task.taskType === "RESEARCH" ? (
          <span className="task-card-branch" title={taskTypeText[task.taskType]}>
            <Search size={13} />
            <span>{taskTypeText[task.taskType]}</span>
          </span>
        ) : (
          <span className="task-card-branch" title={task.targetBranch}>
            <GitBranch size={13} />
            <span>{task.targetBranch}</span>
          </span>
        )}
        <span>分数 {task.priority}</span>
        <time>{formatDateTime(task.updatedAt)}</time>
      </span>
    </Card>
  );
}
