import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Modal, Segmented, Tag, Tooltip } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import {
  Check,
  CheckCircle2,
  Bot,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileDiff,
  GitMerge,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RunChangedFile,
  RunConflictAgentResolution,
  RunConflictFile,
  RunConflictPreview,
  RunConflictResolution,
} from "@devloop/shared";
import { api, queryKeys } from "../api.js";
import {
  findConflictBlocks,
  hasUnresolvedConflictMarkers,
  resolveConflictBlock,
  type ConflictChoice,
} from "../conflict-resolution.js";
import { parseUnifiedDiff } from "../unified-diff.js";
import { EmptyState, ErrorPanel, LoadingPanel } from "./feedback.js";
import { useNotice } from "./notice-provider.js";

const statusLabel: Record<RunChangedFile["status"], string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  typechange: "类型变更",
};
const noConflicts: RunConflictFile[] = [];

export interface RunDiffApprovalState {
  expectedTargetCommit: string | null;
  conflictResolutions: RunConflictResolution[];
  unresolvedPaths: string[];
  agentResolving: boolean;
}

interface RunDiffPanelProps {
  runId: string;
  reviewing: boolean;
  taskVersion: number | undefined;
  canResolveConflicts?: boolean;
  onApprovalStateChange?: ((state: RunDiffApprovalState | null) => void) | undefined;
}

export function RunDiffPanel({
  runId,
  reviewing,
  taskVersion,
  canResolveConflicts = false,
  onApprovalStateChange,
}: RunDiffPanelProps) {
  const filesQuery = useQuery({
    queryKey: [...queryKeys.runChangedFiles(runId), reviewing] as const,
    queryFn: () => api.runChangedFiles(runId),
    enabled: Boolean(runId),
    refetchOnWindowFocus: reviewing,
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
  const agentResolution = filesQuery.data?.agentResolution ?? null;
  const workspaceKey = [
    runId,
    reviewing ? "review" : "readonly",
    conflictPreview?.status ?? "none",
    conflictPreview?.targetCommit ?? "new-branch",
    conflictPreview?.files.map((file) => file.path).join("\0") ?? "",
    agentResolution?.completedAt ?? "manual",
  ].join(":");

  return (
    <DiffReview
      key={workspaceKey}
      runId={runId}
      files={files}
      conflictPreview={conflictPreview}
      agentResolution={agentResolution}
      taskVersion={taskVersion}
      canResolveConflicts={canResolveConflicts}
      onApprovalStateChange={onApprovalStateChange}
    />
  );
}

interface DiffReviewProps {
  runId: string;
  files: RunChangedFile[];
  conflictPreview: RunConflictPreview | null;
  agentResolution: RunConflictAgentResolution | null;
  taskVersion: number | undefined;
  canResolveConflicts: boolean;
  onApprovalStateChange?: ((state: RunDiffApprovalState | null) => void) | undefined;
}

function DiffReview({
  runId,
  files,
  conflictPreview,
  agentResolution,
  taskVersion,
  canResolveConflicts,
  onApprovalStateChange,
}: DiffReviewProps) {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const conflicts = conflictPreview?.status === "conflicted" ? conflictPreview.files : noConflicts;
  const storedResolutions =
    agentResolution &&
    conflictPreview &&
    agentResolution.targetCommit === conflictPreview.targetCommit
      ? agentResolution.resolutions
      : [];
  const firstConflictedFile = files.find((file) => findFileConflict(file, conflicts));
  const [selectedPath, setSelectedPath] = useState(
    firstConflictedFile?.path ?? files[0]?.path ?? "",
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      conflicts
        .filter((conflict) => conflict.content !== null)
        .map((conflict) => {
          const resolution = storedResolutions.find((item) => item.path === conflict.path);
          return [
            conflict.path,
            resolution?.strategy === "content" ? resolution.content : (conflict.content ?? ""),
          ];
        }),
    ),
  );
  const [resolutions, setResolutions] = useState<Record<string, RunConflictResolution>>(() =>
    Object.fromEntries(storedResolutions.map((resolution) => [resolution.path, resolution])),
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0];
  const selectedConflict = selectedFile ? findFileConflict(selectedFile, conflicts) : undefined;
  const resolutionList = useMemo(() => Object.values(resolutions), [resolutions]);
  const unresolvedPaths = useMemo(
    () =>
      conflicts.filter((conflict) => !resolutions[conflict.path]).map((conflict) => conflict.path),
    [conflicts, resolutions],
  );
  const agentSuggestionApplied =
    Boolean(agentResolution) &&
    storedResolutions.length > 0 &&
    storedResolutions.length === conflicts.length &&
    conflicts.every((conflict) =>
      conflictResolutionsEqual(
        resolutions[conflict.path],
        storedResolutions.find((resolution) => resolution.path === conflict.path),
      ),
    );
  const totalAdditions = files.reduce((total, file) => total + file.additions, 0);
  const totalDeletions = files.reduce((total, file) => total + file.deletions, 0);
  const agentMutation = useMutation({
    mutationFn: async () => {
      if (
        conflictPreview?.status !== "conflicted" ||
        !conflictPreview.targetCommit ||
        taskVersion === undefined
      ) {
        throw new Error("当前冲突内容尚未准备完成");
      }
      return api.resolveRunConflicts(runId, {
        expectedVersion: taskVersion,
        expectedTargetCommit: conflictPreview.targetCommit,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.runChangedFiles(runId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) }),
      ]);
      notify("Agent 已生成冲突解决建议，请人工复核后再写入");
    },
    onError: (error) =>
      notify(error instanceof Error ? error.message : "Agent 解决冲突失败", "danger"),
  });

  useEffect(() => {
    if (conflictPreview?.status === "clean" || conflictPreview?.status === "conflicted") {
      onApprovalStateChange?.({
        expectedTargetCommit: conflictPreview.targetCommit,
        conflictResolutions: resolutionList,
        unresolvedPaths,
        agentResolving: agentMutation.isPending,
      });
      return;
    }
    onApprovalStateChange?.(null);
  }, [
    agentMutation.isPending,
    conflictPreview,
    onApprovalStateChange,
    resolutionList,
    unresolvedPaths,
  ]);

  useEffect(
    () => () => {
      onApprovalStateChange?.(null);
    },
    [onApprovalStateChange],
  );

  const updateDraft = (path: string, content: string) => {
    setDrafts((current) => ({ ...current, [path]: content }));
    setResolutions((current) => {
      if (!current[path]) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  };

  const setResolution = (resolution: RunConflictResolution) => {
    setResolutions((current) => ({ ...current, [resolution.path]: resolution }));
  };

  if (!selectedFile) return null;

  const conflictSummary =
    conflictPreview?.status === "conflicted" ? (
      <Alert
        className={`diff-conflict-summary${unresolvedPaths.length === 0 ? " is-resolved" : ""}`}
        type={unresolvedPaths.length === 0 ? "success" : "warning"}
        showIcon
        title={
          <strong>
            {unresolvedPaths.length === 0
              ? agentSuggestionApplied
                ? "Agent 已生成冲突解决建议"
                : "所有冲突已解决"
              : `还有 ${unresolvedPaths.length} 个冲突文件待解决`}
          </strong>
        }
        description={
          <span>
            目标分支 <code>{conflictPreview.targetBranch}</code>
            {unresolvedPaths.length === 0
              ? agentSuggestionApplied
                ? " 的建议已填入编辑器，请逐文件复核；只有人工点击通过后才会写入。"
                : " 的解决结果将在审批时重新校验。"
              : " 未解决时写入接口会继续返回冲突。"}
          </span>
        }
      />
    ) : conflictPreview?.status === "unavailable" ? (
      <Alert
        className="diff-conflict-summary diff-conflict-summary-unavailable"
        type="warning"
        showIcon
        title={<strong>冲突预检不可用</strong>}
        description={conflictPreview.message ?? "暂时无法比较目标分支与本次结果。"}
      />
    ) : null;

  return (
    <div className="diff-panel">
      <div className="diff-preview-launcher">
        <div className="diff-preview-launcher-main">
          <FileDiff size={18} aria-hidden="true" />
          <div>
            <strong>{files.length} 个变更文件</strong>
            <span>
              <span className="diff-additions">+{totalAdditions}</span>
              <span className="diff-deletions">-{totalDeletions}</span>
            </span>
          </div>
        </div>
        {conflictPreview?.status === "conflicted" ? (
          <Tag
            variant="filled"
            className={`diff-preview-conflict-state${unresolvedPaths.length === 0 ? " is-resolved" : ""}`}
          >
            {unresolvedPaths.length === 0 ? (
              <CheckCircle2 size={14} aria-hidden="true" />
            ) : (
              <TriangleAlert size={14} aria-hidden="true" />
            )}
            {unresolvedPaths.length === 0 ? "冲突已解决" : `${unresolvedPaths.length} 个冲突`}
          </Tag>
        ) : null}
        <div className="diff-preview-actions">
          {conflictPreview?.status === "conflicted" && canResolveConflicts ? (
            <Button
              icon={<Bot size={16} aria-hidden="true" />}
              loading={agentMutation.isPending}
              disabled={!conflictPreview.targetCommit}
              onClick={() => agentMutation.mutate()}
            >
              {agentMutation.isPending
                ? "Agent 解决中"
                : agentResolution
                  ? "重新交给 Agent"
                  : "交给 Agent 解决"}
            </Button>
          ) : null}
          <Button
            icon={<Eye size={16} aria-hidden="true" />}
            className="diff-preview-button"
            onClick={() => setPreviewOpen(true)}
          >
            预览代码
          </Button>
        </div>
      </div>

      <Modal
        open={previewOpen}
        width={1220}
        footer={null}
        onCancel={() => setPreviewOpen(false)}
        className="diff-dialog"
        title={
          <span className="diff-dialog-title">
            <strong>代码变更预览</strong>
            <small>
              {files.length} 个文件 · +{totalAdditions} -{totalDeletions}
            </small>
          </span>
        }
      >
        <div className="diff-dialog-body">
          {conflictSummary}
          <div className="diff-workspace">
            <aside className="diff-file-browser" aria-label="变更文件">
              <div className="diff-file-browser-heading">
                <span>文件</span>
                <span>{files.length}</span>
              </div>
              <div className="diff-file-browser-list" role="tablist" aria-orientation="vertical">
                {files.map((file) => {
                  const conflict = findFileConflict(file, conflicts);
                  const resolved = conflict ? Boolean(resolutions[conflict.path]) : false;
                  const selected = file.path === selectedFile.path;
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
                      onClick={() => setSelectedPath(file.path)}
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
                          <TriangleAlert
                            className="diff-file-state-conflict"
                            size={16}
                            aria-label="冲突"
                          />
                        )
                      ) : null}
                    </Button>
                  );
                })}
              </div>
            </aside>

            <DiffFileDetail
              key={`${selectedFile.path}:${selectedConflict?.path ?? "clean"}`}
              runId={runId}
              panelId={`run-diff-detail-${runId}`}
              file={selectedFile}
              conflict={selectedConflict}
              draft={selectedConflict ? drafts[selectedConflict.path] : undefined}
              resolution={selectedConflict ? resolutions[selectedConflict.path] : undefined}
              onDraftChange={updateDraft}
              onResolve={setResolution}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

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

function DiffFileDetail({
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

interface ConflictResolverProps {
  conflict: RunConflictFile;
  draft: string | undefined;
  resolution: RunConflictResolution | undefined;
  onDraftChange(content: string): void;
  onResolve(resolution: RunConflictResolution): void;
}

function ConflictResolver({
  conflict,
  draft,
  resolution,
  onDraftChange,
  onResolve,
}: ConflictResolverProps) {
  const editorRef = useRef<TextAreaRef>(null);
  const positionedRef = useRef(false);
  const [activeBlockIndex, setActiveBlockIndex] = useState(0);

  useEffect(() => {
    if (positionedRef.current || draft === undefined) return;
    const firstBlock = findConflictBlocks(draft)[0];
    const editor = editorRef.current?.resizableTextArea?.textArea;
    if (!firstBlock || !editor) return;
    const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 18;
    const linesBeforeConflict = draft.slice(0, firstBlock.startOffset).split("\n").length - 1;
    editor.scrollTop = Math.max(0, linesBeforeConflict * lineHeight - editor.clientHeight * 0.2);
    editor.setSelectionRange(firstBlock.startOffset, firstBlock.endOffset);
    positionedRef.current = true;
  }, [draft]);

  if (draft === undefined) {
    return (
      <div className="diff-conflict-fallback">
        <TriangleAlert size={20} aria-hidden="true" />
        <strong>{conflict.isBinary ? "二进制冲突" : "文件无法在线编辑"}</strong>
        <span>
          {conflict.isBinary
            ? "请选择保留目标分支版本或采用本次结果。"
            : "文件内容过大或无法读取，只能选择其中一侧的完整版本。"}
        </span>
        <div className="diff-conflict-side-actions">
          <Button
            className={resolution?.strategy === "target" ? "is-selected" : ""}
            onClick={() => onResolve({ path: conflict.path, strategy: "target" })}
          >
            {conflict.targetExists ? "保留目标分支版本" : "保持目标分支删除"}
          </Button>
          <Button
            className={resolution?.strategy === "result" ? "is-selected" : ""}
            onClick={() => onResolve({ path: conflict.path, strategy: "result" })}
          >
            {conflict.resultExists ? "采用本次结果版本" : "采用本次结果删除"}
          </Button>
        </div>
      </div>
    );
  }

  const blocks = findConflictBlocks(draft);
  const safeBlockIndex = Math.min(activeBlockIndex, Math.max(blocks.length - 1, 0));
  const unresolvedMarkers = hasUnresolvedConflictMarkers(draft);
  const contentResolved = resolution?.strategy === "content";

  const selectBlock = (index: number) => {
    const block = blocks[index];
    if (!block) return;
    setActiveBlockIndex(index);
    const editor = editorRef.current?.resizableTextArea?.textArea;
    editor?.focus();
    editor?.setSelectionRange(block.startOffset, block.endOffset);
  };

  const applyChoice = (choice: ConflictChoice) => {
    const nextDraft = resolveConflictBlock(draft, safeBlockIndex, choice);
    onDraftChange(nextDraft);
    setActiveBlockIndex(
      Math.min(safeBlockIndex, Math.max(findConflictBlocks(nextDraft).length - 1, 0)),
    );
  };

  return (
    <div className="diff-conflict-editor">
      <div className="diff-conflict-toolbar">
        <div className="diff-conflict-block-nav">
          <Tooltip title="上一个冲突块">
            <Button
              type="text"
              shape="circle"
              size="small"
              className="diff-editor-icon-button"
              aria-label="上一个冲突块"
              icon={<ChevronLeft size={15} aria-hidden="true" />}
              disabled={blocks.length === 0 || safeBlockIndex === 0}
              onClick={() => selectBlock(safeBlockIndex - 1)}
            />
          </Tooltip>
          <span>
            {blocks.length > 0 ? `冲突块 ${safeBlockIndex + 1} / ${blocks.length}` : "无冲突块"}
          </span>
          <Tooltip title="下一个冲突块">
            <Button
              type="text"
              shape="circle"
              size="small"
              className="diff-editor-icon-button"
              aria-label="下一个冲突块"
              icon={<ChevronRight size={15} aria-hidden="true" />}
              disabled={blocks.length === 0 || safeBlockIndex >= blocks.length - 1}
              onClick={() => selectBlock(safeBlockIndex + 1)}
            />
          </Tooltip>
        </div>
        <div className="diff-conflict-choice-actions">
          <Button size="small" disabled={blocks.length === 0} onClick={() => applyChoice("target")}>
            采用目标
          </Button>
          <Button size="small" disabled={blocks.length === 0} onClick={() => applyChoice("result")}>
            采用本次
          </Button>
          <Button size="small" disabled={blocks.length === 0} onClick={() => applyChoice("both")}>
            保留双方
          </Button>
        </div>
      </div>

      <Input.TextArea
        ref={editorRef}
        className={`diff-conflict-textarea${contentResolved ? " is-resolved" : ""}`}
        aria-label={`${conflict.path} 冲突内容`}
        spellCheck={false}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
      />

      <div className="diff-conflict-editor-footer">
        <span className={unresolvedMarkers ? "is-unresolved" : "is-ready"}>
          {unresolvedMarkers ? (
            <TriangleAlert size={14} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={14} aria-hidden="true" />
          )}
          {unresolvedMarkers
            ? "仍包含冲突标记"
            : contentResolved
              ? "已标记为解决"
              : "冲突标记已清除"}
        </span>
        <Button
          type="primary"
          className="diff-mark-resolved"
          icon={<Check size={15} aria-hidden="true" />}
          disabled={unresolvedMarkers || contentResolved}
          onClick={() => onResolve({ path: conflict.path, strategy: "content", content: draft })}
        >
          {contentResolved ? "已解决" : "标记为已解决"}
        </Button>
      </div>
    </div>
  );
}

function findFileConflict(
  file: RunChangedFile,
  conflicts: RunConflictFile[],
): RunConflictFile | undefined {
  return conflicts.find(
    (conflict) => conflict.path === file.path || conflict.path === file.oldPath,
  );
}

function conflictResolutionsEqual(
  left: RunConflictResolution | undefined,
  right: RunConflictResolution | undefined,
): boolean {
  if (!left || !right || left.path !== right.path || left.strategy !== right.strategy) {
    return false;
  }
  return (
    left.strategy !== "content" || right.strategy !== "content" || left.content === right.content
  );
}

function UnifiedDiffView({ patch }: { patch: string }) {
  if (!patch) {
    return <p className="diff-binary-message">无 diff 内容。</p>;
  }
  const lines = parseUnifiedDiff(patch);
  return (
    <table className="diff-patch" aria-label="代码 diff，左侧依次显示旧行号和新行号">
      <tbody>
        {lines.map((line, index) => (
          <tr key={index} className={"diff-line diff-line-" + line.kind}>
            <td className="diff-line-number diff-line-number-old" aria-hidden="true">
              {line.oldLineNumber ?? ""}
            </td>
            <td className="diff-line-number diff-line-number-new" aria-hidden="true">
              {line.newLineNumber ?? ""}
            </td>
            <td className="diff-line-content">{line.text || " "}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
