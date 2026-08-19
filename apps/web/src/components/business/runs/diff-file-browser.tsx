import { Button } from "antd";
import { CheckCircle2, FileDiff, TriangleAlert } from "lucide-react";
import type { RunChangedFile, RunConflictFile, RunConflictResolution } from "@devloop/shared";
import { findFileConflict, statusLabel } from "./diff-utils.js";

interface DiffFileBrowserProps {
  runId: string;
  files: RunChangedFile[];
  conflicts: RunConflictFile[];
  selectedPath: string;
  resolutions: Record<string, RunConflictResolution>;
  onSelect(path: string): void;
}

export function DiffFileBrowser({
  runId,
  files,
  conflicts,
  selectedPath,
  resolutions,
  onSelect,
}: DiffFileBrowserProps) {
  return (
    <aside className="diff-file-browser" aria-label="变更文件">
      <div className="diff-file-browser-heading">
        <span>文件</span>
        <span>{files.length}</span>
      </div>
      <div className="diff-file-browser-list" role="tablist" aria-orientation="vertical">
        {files.map((file) => {
          const conflict = findFileConflict(file, conflicts);
          const resolved = conflict ? Boolean(resolutions[conflict.path]) : false;
          const selected = file.path === selectedPath;
          return (
            <Button
              key={file.path}
              type="text"
              block
              role="tab"
              aria-selected={selected}
              aria-controls={`run-diff-detail-${runId}`}
              className={`diff-file-browser-item${selected ? " is-selected" : ""}${
                conflict ? " is-conflicted" : ""
              }${resolved ? " is-resolved" : ""}`}
              onClick={() => onSelect(file.path)}
            >
              <FileDiff size={15} aria-hidden="true" />
              <span className="diff-file-browser-main">
                <span className="diff-file-browser-path" title={file.path}>
                  {file.path}
                </span>
                <span className="diff-file-browser-meta">
                  <span className={`diff-status diff-status-${file.status}`}>
                    {statusLabel[file.status]}
                  </span>
                  {!file.isBinary ? (
                    <span className="diff-stat">
                      <span className="diff-additions">+{file.additions}</span>
                      <span className="diff-deletions">-{file.deletions}</span>
                    </span>
                  ) : (
                    <span>二进制</span>
                  )}
                </span>
              </span>
              {conflict ? (
                resolved ? (
                  <CheckCircle2
                    className="diff-file-state-resolved"
                    size={16}
                    aria-label="已解决"
                  />
                ) : (
                  <TriangleAlert className="diff-file-state-conflict" size={16} aria-label="冲突" />
                )
              ) : null}
            </Button>
          );
        })}
      </div>
    </aside>
  );
}
