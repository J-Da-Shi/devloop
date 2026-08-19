import { Button, Flex } from "antd";
import type { TaskRun } from "@devloop/shared";
import { formatDateTime, runStatusText } from "../../../core/index.js";
import { StatusBadge } from "../../common/index.js";

interface RunListProps {
  runs: TaskRun[];
  selectedId: string | null;
  onSelect(runId: string): void;
}

export function RunList({ runs, selectedId, onSelect }: RunListProps) {
  return (
    <Flex vertical className="run-list" aria-label="执行记录列表">
      {runs.map((run) => (
        <Button
          key={run.id}
          type="text"
          block
          className={`run-row${selectedId === run.id ? " active" : ""}`}
          onClick={() => onSelect(run.id)}
        >
          <span>
            <strong>{run.id.slice(0, 8)}</strong>
            <small>{formatDateTime(run.startedAt)}</small>
          </span>
          <StatusBadge status={run.status}>{runStatusText[run.status]}</StatusBadge>
        </Button>
      ))}
    </Flex>
  );
}
