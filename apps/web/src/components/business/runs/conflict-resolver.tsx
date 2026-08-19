import { Button, Input, Tooltip } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RunConflictFile, RunConflictResolution } from "@devloop/shared";
import {
  findConflictBlocks,
  hasUnresolvedConflictMarkers,
  resolveConflictBlock,
} from "../../../core/index.js";
import type { ConflictChoice } from "../../../types/index.js";

interface ConflictResolverProps {
  conflict: RunConflictFile;
  draft: string | undefined;
  resolution: RunConflictResolution | undefined;
  onDraftChange(content: string): void;
  onResolve(resolution: RunConflictResolution): void;
}

export function ConflictResolver({
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
