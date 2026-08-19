import { Activity } from "lucide-react";

export function ExecutionIdle({ queued }: { queued: boolean }) {
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
