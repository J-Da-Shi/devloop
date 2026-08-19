import type { Task, TaskStatus } from "@devloop/shared";
import { taskStatusText } from "../../../core/index.js";
import { EmptyState, StatusBadge } from "../../common/index.js";
import { TaskCard } from "./task-card.js";

interface TaskBoardColumnProps {
  status: TaskStatus;
  tasks: Task[];
  onSelect(task: Task): void;
}

export function TaskBoardColumn({ status, tasks, onSelect }: TaskBoardColumnProps) {
  return (
    <section className="board-column">
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
          tasks.map((task) => <TaskCard key={task.id} task={task} onOpen={onSelect} />)
        )}
      </div>
    </section>
  );
}
