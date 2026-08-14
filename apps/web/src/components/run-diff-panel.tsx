import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react";
import { useState } from "react";
import type { RunChangedFile } from "@devloop/shared";
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
}

export function RunDiffPanel({ runId }: RunDiffPanelProps) {
  const filesQuery = useQuery({
    queryKey: queryKeys.runChangedFiles(runId),
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
  return (
    <ul className="diff-file-list">
      {files.map((file) => (
        <DiffFileItem key={file.path} runId={runId} file={file} />
      ))}
    </ul>
  );
}

interface DiffFileItemProps {
  runId: string;
  file: RunChangedFile;
}

function DiffFileItem({ runId, file }: DiffFileItemProps) {
  const [expanded, setExpanded] = useState(false);
  const patchQuery = useQuery({
    queryKey: queryKeys.runFilePatch(runId, file.path),
    queryFn: () => api.runFilePatch(runId, file.path),
    enabled: expanded,
  });
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <li className="diff-file">
      <button
        type="button"
        className="diff-file-header"
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon size={16} aria-hidden="true" />
        <FileDiff size={16} aria-hidden="true" />
        <span className={`diff-status diff-status-${file.status}`}>{statusLabel[file.status]}</span>
        <span className="diff-path">{file.path}</span>
        {file.oldPath ? <span className="diff-old-path">← {file.oldPath}</span> : null}
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

function classifyLine(line: string): "add" | "del" | "hunk" | "meta" | "context" {
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
