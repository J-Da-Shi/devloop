import { Button } from "antd";
import { Cpu, Pause, Play } from "lucide-react";
import type { WorkerState } from "@devloop/shared";
import { formatDateTime, workerStatusText } from "../../../core/index.js";
import { StatusBadge } from "../../common/index.js";

interface WorkerStripProps {
  worker: WorkerState;
  activeRunCount: number;
  loading: boolean;
  onToggle(): void;
}

export function WorkerStrip({ worker, activeRunCount, loading, onToggle }: WorkerStripProps) {
  const running = worker.status === "RUNNING";
  return (
    <section className="worker-strip" aria-live="polite">
      <div className="worker-node-mark">
        <Cpu size={21} aria-hidden="true" />
        <span>本机</span>
      </div>
      <div className="worker-primary">
        <div>
          <small>{activeRunCount > 0 ? "并发执行" : "本机 Worker"}</small>
          <strong>{activeRunCount > 0 ? `${activeRunCount} 个任务正在执行` : "当前空闲"}</strong>
          <span>
            {activeRunCount > 0
              ? `并发槽位 ${activeRunCount}/${worker.concurrencyLimit}`
              : `最近心跳 ${formatDateTime(worker.heartbeatAt)}`}
          </span>
        </div>
      </div>
      <div className="worker-control">
        <StatusBadge status={worker.status} pulse={running}>
          Worker {workerStatusText[worker.status]}
        </StatusBadge>
        <Button
          type={running ? "default" : "primary"}
          icon={running ? <Pause size={17} /> : <Play size={17} />}
          loading={loading}
          onClick={onToggle}
        >
          {running ? "暂停领取" : "继续运行"}
        </Button>
      </div>
    </section>
  );
}
