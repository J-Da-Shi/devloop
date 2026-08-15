import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileDiff, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { RunChangedFile, RunConflictFile } from "@devloop/shared";
import { api, queryKeys } from "../api.js";
import { EmptyState, ErrorPanel, LoadingPanel } from "./feedback.js";

const statusLabel: Record<RunChangedFile["status"], string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  typechange: "类型变更",
};

interface RunDiffPanelProps {
  runId: string;
  reviewing: boolean;
}

export function RunDiffPanel({ runId, reviewing }: RunDiffPanelProps) {
  const filesQuery = useQuery({
    queryKey: [...queryKeys.runChangedFiles(runId), reviewing] as const,
    queryFn: () => api.runChangedFiles(runId),
    enabled: Boolean(runId),
  });

  if (filesQuery.isPending) {
    return <LoadingPanel label="正在加载代码变更" />;
  }
  if (filesQuery.isError) {
    return <ErrorPanel error={filesQuery.error} />;
  }
  const files = filesQuery.data?.files ?? [];
  if (files.length === 0) {
    return <EmptyState title="本次执行未修改任何文件" />;
  }
  const conflictPreview = filesQuery.data?.conflictPreview ?? null;
  return (
    <div className="diff-panel">
      {conflictPreview?.status === "conflicted" ? (
        <div className="diff-conflict-summary" role="alert">
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <strong>检测到 {conflictPreview.files.length} 个冲突文件</strong>
            <span>
              目标分支 <code>{conflictPreview.targetBranch}</code>
              与本次结果修改了相同内容，当前结果无法直接写入。
            </span>
          </div>
        </div>
      ) : conflictPreview?.status === "unavailable" ? (
        <div className="diff-conflict-summary diff-conflict-summary-unavailable" role="alert">
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <strong>冲突预检不可用</strong>
            <span>{conflictPreview.message ?? "暂时无法比较目标分支与本次结果。"}</span>
          </div>
        </div>
      ) : null}
      <ul className="diff-file-list">
        {files.map((file) => (
          <DiffFileItem
            key={file.path}
            runId={runId}
            file={file}
            conflict={conflictPreview?.files.find(
              (item) => item.path === file.path || item.path === file.oldPath,
            )}
          />
        ))}
      </ul>
    </div>
  );
}

interface DiffFileItemProps {
  runId: string;
  file: RunChangedFile;
  conflict: RunConflictFile | undefined;
}

function DiffFileItem({ runId, file, conflict }: DiffFileItemProps) {
  const [expanded, setExpanded] = useState(Boolean(conflict));
  const patchQuery = useQuery({
    queryKey: queryKeys.runFilePatch(runId, file.path),
    queryFn: () => api.runFilePatch(runId, file.path),
    enabled: expanded,
  });
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <li className={`diff-file${conflict ? " diff-file-conflicted" : ""}`}>
      <button
        type="button"
        className="diff-file-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <Icon size={16} aria-hidden="true" />
        <FileDiff size={16} aria-hidden="true" />
        <span className={`diff-status diff-status-${file.status}`}>{statusLabel[file.status]}</span>
        <span className="diff-path">{file.path}</span>
        {file.oldPath ? <span className="diff-old-path">← {file.oldPath}</span> : null}
        {conflict ? (
          <span className="diff-conflict-badge">
            <TriangleAlert size={13} aria-hidden="true" />
            冲突
          </span>
        ) : null}
        {file.isBinary ? (
          <span className="diff-binary">二进制</span>
        ) : (
          <span className="diff-stat">
            <span className="diff-additions">+{file.additions}</span>
            <span className="diff-deletions">-{file.deletions}</span>
          </span>
        )}
      </button>
      {expanded ? (
        <div className="diff-file-body">
          {conflict ? (
            <section className="diff-conflict-preview" aria-label={`${file.path} 冲突预览`}>
              <div className="diff-conflict-preview-heading">
                <TriangleAlert size={15} aria-hidden="true" />
                <strong>冲突预览</strong>
                <span>目标分支与本次结果</span>
              </div>
              {conflict.isBinary ? (
                <p className="diff-binary-message">二进制文件发生冲突，无法显示文本内容。</p>
              ) : conflict.patch ? (
                <UnifiedDiffView patch={conflict.patch} />
              ) : (
                <p className="diff-binary-message">Git 未生成可显示的冲突内容。</p>
              )}
            </section>
          ) : null}
          {conflict ? <div className="diff-section-label">本次执行变更</div> : null}
          {file.isBinary ? (
            <p className="diff-binary-message">二进制文件，不显示 diff。</p>
          ) : patchQuery.isPending ? (
            <LoadingPanel label="正在加载 diff" />
          ) : patchQuery.isError ? (
            <ErrorPanel error={patchQuery.error} />
          ) : patchQuery.data ? (
            <UnifiedDiffView patch={patchQuery.data.patch} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function UnifiedDiffView({ patch }: { patch: string }) {
  if (!patch) {
    return <p className="diff-binary-message">无 diff 内容。</p>;
  }
  const lines = patch.split("\n");
  return (
    <pre className="diff-patch">
      {lines.map((line, index) => {
        const kind = classifyLine(line);
        return (
          <span key={index} className={`diff-line diff-line-${kind}`}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

function classifyLine(line: string): "add" | "del" | "hunk" | "meta" | "conflict" | "context" {
  const conflictContent = line.replace(/^[ +\-]{0,2}/, "");
  if (
    conflictContent.startsWith("<<<<<<<") ||
    conflictContent.startsWith("=======") ||
    conflictContent.startsWith(">>>>>>>")
  ) {
    return "conflict";
  }
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("Binary files")
  ) {
    return "meta";
  }
  return "context";
}
