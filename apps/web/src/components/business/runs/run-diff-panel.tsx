import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Modal, Tag } from "antd";
import { Bot, CheckCircle2, Eye, FileDiff, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  RunChangedFile,
  RunConflictAgentResolution,
  RunConflictFile,
  RunConflictPreview,
  RunConflictResolution,
} from "@devloop/shared";
import { api, queryKeys } from "../../../core/index.js";
import { EmptyState, ErrorPanel, LoadingPanel, useNotice } from "../../common/index.js";
import { DiffFileBrowser } from "./diff-file-browser.js";
import { DiffFileDetail } from "./diff-file-detail.js";
import { conflictResolutionsEqual, findFileConflict } from "./diff-utils.js";

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
            <DiffFileBrowser
              runId={runId}
              files={files}
              conflicts={conflicts}
              selectedPath={selectedFile.path}
              resolutions={resolutions}
              onSelect={setSelectedPath}
            />
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
