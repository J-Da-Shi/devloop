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
import {
  formatDateTime,
  formatDuration,
  runStatusText,
  taskTypeText,
  type RunDetails,
} from "../../../core/index.js";
import { RunEventList } from "./run-event-list.js";
import { StatusBadge } from "../../common/index.js";

const reviewDecisionText = {
  APPROVED: "审核通过",
  REJECTED: "审核驳回",
} as const;

interface RunDetailProps {
  details: RunDetails;
}

export function RunDetail({ details }: RunDetailProps) {
  const appliedLocally = details.events.some((event) => event.type === "run.applied");
  const researchTask = details.revision.taskType === "RESEARCH";
  const reviewLabel = details.reviewDecision
    ? reviewDecisionText[details.reviewDecision.decision]
    : details.run.status === "SUCCEEDED" &&
        details.task?.status === "REVIEW" &&
        details.task.latestRunId === details.run.id
      ? "待审核"
      : "无审核记录";

  return (
    <>
      <div className="section-heading">
        <div>
          <h2>{details.revision.title}</h2>
          <span>
            {details.task?.projectName ?? "未知项目"} · Revision #{details.revision.revision} ·{" "}
            {taskTypeText[details.revision.taskType]}
            {details.task?.deletedAt ? " · 任务已删除" : ""}
          </span>
        </div>
        <StatusBadge status={details.run.status}>{runStatusText[details.run.status]}</StatusBadge>
      </div>
      <div className="run-meta-grid">
        <span>
          <small>耗时</small>
          <strong>
            <Clock3 size={14} />
            {formatDuration(details.run.startedAt, details.run.finishedAt)}
          </strong>
        </span>
        <span>
          <small>执行器</small>
          <strong>
            {details.run.runner}
            {details.run.runnerVersion ? ` · ${details.run.runnerVersion}` : ""}
          </strong>
        </span>
        <span>
          <small>任务类型</small>
          <strong>
            {researchTask ? <Search size={14} /> : <FileText size={14} />}
            {taskTypeText[details.revision.taskType]}
          </strong>
        </span>
        <span>
          <small>任务 Revision</small>
          <code>
            <FileText size={14} />#{details.revision.revision} ·{" "}
            {details.revision.specHash.slice(0, 10)}
          </code>
        </span>
        {!researchTask ? (
          <>
            <span>
              <small>基础 Commit</small>
              <code>
                <GitCommitHorizontal size={14} />
                {details.run.baseCommit?.slice(0, 10) ?? "暂无"}
              </code>
            </span>
            <span>
              <small>结果 Commit</small>
              <code>
                <GitCommitHorizontal size={14} />
                {details.run.resultCommit?.slice(0, 10) ?? "暂无"}
              </code>
            </span>
            <span>
              <small>目标分支</small>
              <code>
                <GitBranch size={14} />
                {details.run.targetBranch}
              </code>
            </span>
            <span>
              <small>结果分支</small>
              <code>
                <GitBranch size={14} />
                {details.run.branchName ?? "暂无"}
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
                : (details.run.pushedCommit?.slice(0, 10) ?? "尚未推送")}
            </code>
          </span>
        ) : null}
      </div>
      {details.run.summary ? <p className="run-summary">{details.run.summary}</p> : null}
      <section className="run-audit-section">
        <div className="run-audit-heading">
          <div>
            <h3>本次任务内容</h3>
            <span>确认于 {formatDateTime(details.revision.confirmedAt)}</span>
          </div>
          <code>{details.revision.id.slice(0, 8)}</code>
        </div>
        <div className="run-revision-grid">
          <div className="run-audit-field">
            <small>任务目标</small>
            <p>{details.revision.goal}</p>
          </div>
          <div className="run-audit-field">
            <small>验收标准</small>
            <ol>
              {details.revision.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ol>
          </div>
        </div>
        {details.revision.reviewFeedback ? (
          <div className="run-feedback-block">
            <small>执行前审核反馈</small>
            <p>{details.revision.reviewFeedback}</p>
          </div>
        ) : null}
      </section>
      {details.reviewDecision ? (
        <section className="run-review-section">
          <div className="run-audit-heading">
            <div>
              <h3>审核记录</h3>
              <span>{formatDateTime(details.reviewDecision.createdAt)}</span>
            </div>
            <code>{details.reviewDecision.deviceId ?? "未记录审核设备"}</code>
          </div>
          <div className={`run-review-outcome ${details.reviewDecision.decision.toLowerCase()}`}>
            {details.reviewDecision.decision === "APPROVED" ? (
              <CheckCircle2 size={17} aria-hidden="true" />
            ) : (
              <XCircle size={17} aria-hidden="true" />
            )}
            <strong>{reviewDecisionText[details.reviewDecision.decision]}</strong>
          </div>
          {details.reviewDecision.feedback ? (
            <p className="run-review-feedback">{details.reviewDecision.feedback}</p>
          ) : null}
        </section>
      ) : null}
      <div className="run-log-heading">
        <h3>运行事件</h3>
        <span>{details.events.length} 条</span>
      </div>
      <RunEventList events={details.events} streamKey={details.run.id} label="运行详情日志" />
    </>
  );
}
