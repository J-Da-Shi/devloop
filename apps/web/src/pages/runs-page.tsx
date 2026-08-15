import { useQuery } from "@tanstack/react-query";
import { Clock3, GitBranch, GitCommitHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryKeys } from "../api.js";
import { EmptyState, ErrorPanel, LoadingPanel } from "../components/feedback.js";
import { RunEventList } from "../components/run-event-list.js";
import { StatusBadge } from "../components/status-badge.js";
import { formatDateTime, formatDuration, runStatusText } from "../utils.js";

export function RunsPage() {
  const runs = useQuery({ queryKey: queryKeys.runs, queryFn: api.runs });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && runs.data?.runs[0]) {
      setSelectedId(runs.data.runs[0].id);
    }
  }, [runs.data?.runs, selectedId]);
  const details = useQuery({
    queryKey: queryKeys.run(selectedId ?? "none"),
    queryFn: () => api.run(selectedId ?? ""),
    enabled: Boolean(selectedId),
  });
  const appliedLocally =
    details.data?.events.some((event) => event.type === "run.applied") ?? false;

  if (runs.isPending) return <LoadingPanel label="正在加载执行记录" />;
  if (runs.isError) return <ErrorPanel error={runs.error} />;
  if (runs.data.runs.length === 0) return <EmptyState title="还没有执行记录" />;

  return (
    <div className="runs-layout">
      <section className="run-list" aria-label="执行记录列表">
        {runs.data.runs.map((run) => (
          <button
            key={run.id}
            type="button"
            className={`run-row${selectedId === run.id ? " active" : ""}`}
            onClick={() => setSelectedId(run.id)}
          >
            <span>
              <strong>{run.id.slice(0, 8)}</strong>
              <small>{formatDateTime(run.startedAt)}</small>
            </span>
            <StatusBadge status={run.status}>{runStatusText[run.status]}</StatusBadge>
          </button>
        ))}
      </section>
      <section className="tool-panel run-detail-panel">
        {details.isPending ? <LoadingPanel label="正在加载执行详情" /> : null}
        {details.isError ? <ErrorPanel error={details.error} /> : null}
        {details.data ? (
          <>
            <div className="section-heading">
              <div>
                <h2>{details.data.task?.title ?? "未知任务"}</h2>
                <span>
                  {details.data.task?.projectName}
                  {details.data.task?.deletedAt ? " · 任务已删除" : ""}
                </span>
              </div>
              <StatusBadge status={details.data.run.status}>
                {runStatusText[details.data.run.status]}
              </StatusBadge>
            </div>
            <div className="run-meta-grid">
              <span>
                <small>耗时</small>
                <strong>
                  <Clock3 size={14} />
                  {formatDuration(details.data.run.startedAt, details.data.run.finishedAt)}
                </strong>
              </span>
              <span>
                <small>执行器</small>
                <strong>
                  {details.data.run.runner}
                  {details.data.run.runnerVersion ? ` · ${details.data.run.runnerVersion}` : ""}
                </strong>
              </span>
              <span>
                <small>基础 Commit</small>
                <code>
                  <GitCommitHorizontal size={14} />
                  {details.data.run.baseCommit?.slice(0, 10) ?? "暂无"}
                </code>
              </span>
              <span>
                <small>结果 Commit</small>
                <code>
                  <GitCommitHorizontal size={14} />
                  {details.data.run.resultCommit?.slice(0, 10) ?? "暂无"}
                </code>
              </span>
              <span>
                <small>目标分支</small>
                <code>
                  <GitBranch size={14} />
                  {details.data.run.targetBranch}
                </code>
              </span>
              <span>
                <small>结果分支</small>
                <code>
                  <GitBranch size={14} />
                  {details.data.run.branchName ?? "暂无"}
                </code>
              </span>
              <span>
                <small>{appliedLocally ? "本地写入" : "远程推送"}</small>
                <code>
                  <GitCommitHorizontal size={14} />
                  {appliedLocally
                    ? "已写入项目"
                    : (details.data.run.pushedCommit?.slice(0, 10) ?? "尚未推送")}
                </code>
              </span>
            </div>
            {details.data.run.summary ? (
              <p className="run-summary">{details.data.run.summary}</p>
            ) : null}
            <RunEventList
              events={details.data.events}
              streamKey={details.data.run.id}
              label="运行详情日志"
            />
          </>
        ) : null}
      </section>
    </div>
  );
}
