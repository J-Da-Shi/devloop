import { useQuery } from "@tanstack/react-query";
import { Button, Flex } from "antd";
import {
  CheckCircle2,
  Clock3,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  MessageSquareText,
  Search,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryKeys } from "../api.js";
import { EmptyState, ErrorPanel, LoadingPanel } from "../components/feedback.js";
import { RunEventList } from "../components/run-event-list.js";
import { StatusBadge } from "../components/status-badge.js";
import { formatDateTime, formatDuration, runStatusText, taskTypeText } from "../utils.js";

const reviewDecisionText = {
  APPROVED: "审核通过",
  REJECTED: "审核驳回",
} as const;

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
  const researchTask = details.data?.revision.taskType === "RESEARCH";
  const reviewLabel = details.data?.reviewDecision
    ? reviewDecisionText[details.data.reviewDecision.decision]
    : details.data?.run.status === "SUCCEEDED" &&
        details.data.task?.status === "REVIEW" &&
        details.data.task.latestRunId === details.data.run.id
      ? "待审核"
      : "无审核记录";

  if (runs.isPending) return <LoadingPanel label="正在加载执行记录" />;
  if (runs.isError) return <ErrorPanel error={runs.error} />;
  if (runs.data.runs.length === 0) return <EmptyState title="还没有执行记录" />;

  return (
    <div className="runs-layout">
      <Flex vertical className="run-list" aria-label="执行记录列表">
        {runs.data.runs.map((run) => (
          <Button
            key={run.id}
            type="text"
            block
            className={`run-row${selectedId === run.id ? " active" : ""}`}
            onClick={() => setSelectedId(run.id)}
          >
            <span>
              <strong>{run.id.slice(0, 8)}</strong>
              <small>{formatDateTime(run.startedAt)}</small>
            </span>
            <StatusBadge status={run.status}>{runStatusText[run.status]}</StatusBadge>
          </Button>
        ))}
      </Flex>
      <section className="tool-panel run-detail-panel">
        {details.isPending ? <LoadingPanel label="正在加载执行详情" /> : null}
        {details.isError ? <ErrorPanel error={details.error} /> : null}
        {details.data ? (
          <>
            <div className="section-heading">
              <div>
                <h2>{details.data.revision.title}</h2>
                <span>
                  {details.data.task?.projectName ?? "未知项目"} · Revision #
                  {details.data.revision.revision} · {taskTypeText[details.data.revision.taskType]}
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
                <small>任务类型</small>
                <strong>
                  {researchTask ? <Search size={14} /> : <FileText size={14} />}
                  {taskTypeText[details.data.revision.taskType]}
                </strong>
              </span>
              <span>
                <small>任务 Revision</small>
                <code>
                  <FileText size={14} />#{details.data.revision.revision} ·{" "}
                  {details.data.revision.specHash.slice(0, 10)}
                </code>
              </span>
              {!researchTask ? (
                <>
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
                </>
              ) : null}
              <span>
                <small>审核决定</small>
                <strong>
                  <MessageSquareText size={14} />
                  {reviewLabel}
                </strong>
              </span>
              {!researchTask ? (
                <span>
                  <small>{appliedLocally ? "本地写入" : "远程推送"}</small>
                  <code>
                    <GitCommitHorizontal size={14} />
                    {appliedLocally
                      ? "已写入项目"
                      : (details.data.run.pushedCommit?.slice(0, 10) ?? "尚未推送")}
                  </code>
                </span>
              ) : null}
            </div>
            {details.data.run.summary ? (
              <p className="run-summary">{details.data.run.summary}</p>
            ) : null}
            <section className="run-audit-section">
              <div className="run-audit-heading">
                <div>
                  <h3>本次任务内容</h3>
                  <span>确认于 {formatDateTime(details.data.revision.confirmedAt)}</span>
                </div>
                <code>{details.data.revision.id.slice(0, 8)}</code>
              </div>
              <div className="run-revision-grid">
                <div className="run-audit-field">
                  <small>任务目标</small>
                  <p>{details.data.revision.goal}</p>
                </div>
                <div className="run-audit-field">
                  <small>验收标准</small>
                  <ol>
                    {details.data.revision.acceptanceCriteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ol>
                </div>
              </div>
              {details.data.revision.reviewFeedback ? (
                <div className="run-feedback-block">
                  <small>执行前审核反馈</small>
                  <p>{details.data.revision.reviewFeedback}</p>
                </div>
              ) : null}
            </section>
            {details.data.reviewDecision ? (
              <section className="run-review-section">
                <div className="run-audit-heading">
                  <div>
                    <h3>审核记录</h3>
                    <span>{formatDateTime(details.data.reviewDecision.createdAt)}</span>
                  </div>
                  <code>{details.data.reviewDecision.deviceId ?? "未记录审核设备"}</code>
                </div>
                <div
                  className={`run-review-outcome ${details.data.reviewDecision.decision.toLowerCase()}`}
                >
                  {details.data.reviewDecision.decision === "APPROVED" ? (
                    <CheckCircle2 size={17} aria-hidden="true" />
                  ) : (
                    <XCircle size={17} aria-hidden="true" />
                  )}
                  <strong>{reviewDecisionText[details.data.reviewDecision.decision]}</strong>
                </div>
                {details.data.reviewDecision.feedback ? (
                  <p className="run-review-feedback">{details.data.reviewDecision.feedback}</p>
                ) : null}
              </section>
            ) : null}
            <div className="run-log-heading">
              <h3>运行事件</h3>
              <span>{details.data.events.length} 条</span>
            </div>
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
