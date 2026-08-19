import { useQuery } from "@tanstack/react-query";
import { Segmented } from "antd";
import { CheckCircle2, FileDiff, GitMerge, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { RunChangedFile, RunConflictFile, RunConflictResolution } from "@devloop/shared";
import { api, queryKeys } from "../../../core/index.js";
import { ErrorPanel, LoadingPanel } from "../../common/index.js";
import { ConflictResolver } from "./conflict-resolver.js";
import { statusLabel } from "./diff-utils.js";
import { UnifiedDiffView } from "./unified-diff-view.js";

interface DiffFileDetailProps {
  runId: string;
  panelId: string;
  file: RunChangedFile;
  conflict: RunConflictFile | undefined;
  draft: string | undefined;
  resolution: RunConflictResolution | undefined;
  onDraftChange(path: string, content: string): void;
  onResolve(resolution: RunConflictResolution): void;
}

export function DiffFileDetail({
  runId,
  panelId,
  file,
  conflict,
  draft,
  resolution,
  onDraftChange,
  onResolve,
}: DiffFileDetailProps) {
  const [view, setView] = useState<"resolve" | "changes">(conflict ? "resolve" : "changes");
  const patchQuery = useQuery({
    queryKey: queryKeys.runFilePatch(runId, file.path),
    queryFn: () => api.runFilePatch(runId, file.path),
    enabled: view === "changes" && !file.isBinary,
  });

  return (
    <section id={panelId} className="diff-file-detail" role="tabpanel">
      <header className="diff-file-detail-heading">
        <div className="diff-file-detail-title">
          <FileDiff size={16} aria-hidden="true" />
          <code title={file.path}>{file.path}</code>
          {file.oldPath ? <span>来自 {file.oldPath}</span> : null}
        </div>
        <div className="diff-file-detail-meta">
          <span className={`diff-status diff-status-${file.status}`}>
            {statusLabel[file.status]}
          </span>
          {conflict ? (
            <span className={`diff-conflict-badge${resolution ? " is-resolved" : ""}`}>
              {resolution ? (
                <CheckCircle2 size={13} aria-hidden="true" />
              ) : (
                <TriangleAlert size={13} aria-hidden="true" />
              )}
              {resolution ? "已解决" : "冲突"}
            </span>
          ) : null}
        </div>
      </header>

      {conflict ? (
        <Segmented
          className="diff-view-tabs"
          value={view}
          onChange={(value) => setView(value as "resolve" | "changes")}
          options={[
            {
              value: "resolve",
              label: (
                <span>
                  <GitMerge size={14} aria-hidden="true" />
                  解决冲突
                </span>
              ),
            },
            {
              value: "changes",
              label: (
                <span>
                  <FileDiff size={14} aria-hidden="true" />
                  本次变更
                </span>
              ),
            },
          ]}
        />
      ) : null}

      <div className="diff-file-detail-body">
        {conflict && view === "resolve" ? (
          <ConflictResolver
            conflict={conflict}
            draft={draft}
            resolution={resolution}
            onDraftChange={(content) => onDraftChange(conflict.path, content)}
            onResolve={onResolve}
          />
        ) : file.isBinary ? (
          <p className="diff-binary-message">二进制文件，不显示 diff。</p>
        ) : patchQuery.isPending ? (
          <LoadingPanel label="正在加载 diff" />
        ) : patchQuery.isError ? (
          <ErrorPanel error={patchQuery.error} />
        ) : patchQuery.data ? (
          <UnifiedDiffView patch={patchQuery.data.patch} />
        ) : null}
      </div>
    </section>
  );
}
