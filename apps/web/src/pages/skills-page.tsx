import * as Switch from "@radix-ui/react-switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Skill, SkillValidationResult } from "@devloop/shared";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileCode2,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, queryKeys } from "../api.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { EmptyState, ErrorPanel, LoadingPanel } from "../components/feedback.js";
import { IconButton } from "../components/icon-button.js";
import { useNotice } from "../components/notice-provider.js";
import { formatDateTime } from "../utils.js";

const newSkillTemplate = `---
name: new-skill
description: 描述这个 Skill 的适用场景
---

# 工作流程

1. 写明需要执行的步骤。
2. 写明需要检查的结果。
`;

interface EditorState {
  target: string | "new" | null;
  content: string;
  baseline: string;
  expectedVersion: number | null;
  currentVersionId: string | null;
}

const emptyEditor: EditorState = {
  target: null,
  content: "",
  baseline: "",
  expectedVersion: null,
  currentVersionId: null,
};

const validationFromError = (error: unknown): SkillValidationResult | null => {
  if (!(error instanceof ApiError) || error.code !== "INVALID_SKILL") {
    return null;
  }
  const details = error.details;
  if (
    typeof details !== "object" ||
    details === null ||
    !("valid" in details) ||
    !("issues" in details)
  ) {
    return null;
  }
  return details as SkillValidationResult;
};

export function SkillsPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const [search, setSearch] = useState("");
  const [pendingTarget, setPendingTarget] = useState<string | "new" | null>(null);
  const [validation, setValidation] = useState<SkillValidationResult | null>(null);
  const [validationState, setValidationState] = useState<"idle" | "waiting" | "checking">(
    "idle",
  );
  const validationRequest = useRef(0);

  const skills = useQuery({ queryKey: queryKeys.skills, queryFn: api.skills });
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    staleTime: 60_000,
  });
  const details = useQuery({
    queryKey: queryKeys.skill(selectedSkillId ?? "none"),
    queryFn: () => api.skill(selectedSkillId ?? ""),
    enabled: selectedSkillId !== null,
  });

  const canEdit = session.data?.identity.role === "editor";
  const isCreating = editor.target === "new";
  const isDirty =
    editor.target === "new"
      ? editor.content !== newSkillTemplate
      : editor.target !== null && editor.content !== editor.baseline;
  const selectedSkill = skills.data?.skills.find((skill) => skill.id === selectedSkillId) ?? null;
  const effectiveValidation = useMemo<SkillValidationResult | null>(() => {
    if (
      validation === null ||
      isCreating ||
      selectedSkill === null ||
      validation.name === null ||
      validation.name === selectedSkill.name
    ) {
      return validation;
    }
    return {
      ...validation,
      valid: false,
      issues: [
        ...validation.issues,
        {
          severity: "error",
          code: "NAME_IMMUTABLE",
          message: `Skill 名称发布后不能从 ${selectedSkill.name} 修改为 ${validation.name}`,
        },
      ],
    };
  }, [isCreating, selectedSkill, validation]);
  const remoteChanged =
    selectedSkillId !== null &&
    editor.target === selectedSkillId &&
    details.data !== undefined &&
    editor.expectedVersion !== details.data.skill.version;

  const filteredSkills = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) {
      return skills.data?.skills ?? [];
    }
    return (skills.data?.skills ?? []).filter(
      (skill) =>
        skill.name.toLocaleLowerCase("zh-CN").includes(keyword) ||
        skill.description.toLocaleLowerCase("zh-CN").includes(keyword),
    );
  }, [search, skills.data?.skills]);

  useEffect(() => {
    if (selectedSkillId !== null || editor.target !== null || !skills.data?.skills[0]) {
      return;
    }
    setSelectedSkillId(skills.data.skills[0].id);
  }, [editor.target, selectedSkillId, skills.data?.skills]);

  useEffect(() => {
    if (!selectedSkillId || !details.data) {
      return;
    }
    setEditor((current) => {
      if (current.target !== selectedSkillId) {
        return {
          target: selectedSkillId,
          content: details.data.content,
          baseline: details.data.content,
          expectedVersion: details.data.skill.version,
          currentVersionId: details.data.skill.currentVersionId,
        };
      }
      const unchanged = current.content === current.baseline;
      if (unchanged && current.expectedVersion !== details.data.skill.version) {
        return {
          target: selectedSkillId,
          content: details.data.content,
          baseline: details.data.content,
          expectedVersion: details.data.skill.version,
          currentVersionId: details.data.skill.currentVersionId,
        };
      }
      return current;
    });
  }, [details.data, selectedSkillId]);

  const runValidation = useCallback(async (content: string) => {
    const requestId = ++validationRequest.current;
    setValidationState("checking");
    try {
      const result = await api.validateSkill({ content });
      if (requestId === validationRequest.current) {
        setValidation(result.validation);
        setValidationState("idle");
      }
    } catch (error) {
      if (requestId === validationRequest.current) {
        setValidation(validationFromError(error));
        setValidationState("idle");
      }
    }
  }, []);

  useEffect(() => {
    if (!canEdit || editor.target === null || !editor.content.trim()) {
      setValidation(null);
      setValidationState("idle");
      return;
    }
    validationRequest.current += 1;
    setValidation(null);
    setValidationState("waiting");
    const timer = window.setTimeout(() => void runValidation(editor.content), 550);
    return () => window.clearTimeout(timer);
  }, [canEdit, editor.content, editor.target, runValidation]);

  const createSkill = useMutation({
    mutationFn: api.createSkill,
    onSuccess: async ({ skill }) => {
      setSelectedSkillId(skill.id);
      setEditor((current) => ({
        target: skill.id,
        content: current.content,
        baseline: current.content,
        expectedVersion: skill.version,
        currentVersionId: skill.currentVersionId,
      }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.skills }),
        queryClient.invalidateQueries({ queryKey: queryKeys.skill(skill.id) }),
      ]);
      notify("Skill 已创建");
    },
    onError: (error) => {
      const nextValidation = validationFromError(error);
      if (nextValidation) {
        setValidation(nextValidation);
      }
      notify(error instanceof Error ? error.message : "Skill 创建失败", "danger");
    },
  });

  const createVersion = useMutation({
    mutationFn: (input: { skillId: string; content: string; expectedVersion: number }) =>
      api.createSkillVersion(input.skillId, {
        content: input.content,
        expectedVersion: input.expectedVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async ({ skill }) => {
      setEditor((current) => ({
        ...current,
        baseline: current.content,
        expectedVersion: skill.version,
        currentVersionId: skill.currentVersionId,
      }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.skills }),
        queryClient.invalidateQueries({ queryKey: queryKeys.skill(skill.id) }),
      ]);
      notify(`Skill v${skill.currentVersion} 已发布`);
    },
    onError: (error) => {
      const nextValidation = validationFromError(error);
      if (nextValidation) {
        setValidation(nextValidation);
      }
      notify(error instanceof Error ? error.message : "Skill 版本发布失败", "danger");
    },
  });

  const updateSkill = useMutation({
    mutationFn: (input: { skill: Skill; enabled: boolean }) =>
      api.updateSkill(input.skill.id, {
        enabled: input.enabled,
        expectedVersion: input.skill.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async ({ skill }) => {
      setEditor((current) =>
        current.target === skill.id
          ? { ...current, expectedVersion: skill.version }
          : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.skills }),
        queryClient.invalidateQueries({ queryKey: queryKeys.skill(skill.id) }),
      ]);
      notify(skill.enabled ? "Skill 已启用" : "Skill 已停用");
    },
    onError: (error) =>
      notify(error instanceof Error ? error.message : "Skill 状态更新失败", "danger"),
  });

  const openTarget = (target: string | "new") => {
    if (target === "new") {
      setSelectedSkillId(null);
      setEditor({
        target: "new",
        content: newSkillTemplate,
        baseline: newSkillTemplate,
        expectedVersion: null,
        currentVersionId: null,
      });
      return;
    }
    setSelectedSkillId(target);
    setEditor(emptyEditor);
  };

  const requestTarget = (target: string | "new") => {
    if (target === editor.target) {
      return;
    }
    if (isDirty) {
      setPendingTarget(target);
      return;
    }
    openTarget(target);
  };

  const reloadCurrent = () => {
    if (!details.data || !selectedSkillId) {
      return;
    }
    setEditor({
      target: selectedSkillId,
      content: details.data.content,
      baseline: details.data.content,
      expectedVersion: details.data.skill.version,
      currentVersionId: details.data.skill.currentVersionId,
    });
    notify("已载入最新版本", "info");
  };

  const pending = createSkill.isPending || createVersion.isPending;
  const canPublish =
    canEdit === true &&
    effectiveValidation?.valid === true &&
    !remoteChanged &&
    !pending &&
    (isCreating || isDirty);

  if (skills.isPending || session.isPending) {
    return <LoadingPanel label="正在加载 Skill" />;
  }
  if (skills.isError) {
    return <ErrorPanel error={skills.error} />;
  }

  return (
    <div className="skills-page">
      <section className="skill-registry tool-panel" aria-label="Skill 列表">
        <div className="skill-registry-heading">
          <div>
            <span className="skill-section-kicker">REGISTRY</span>
            <h2>Skill</h2>
          </div>
          <span className="skill-count">{skills.data.skills.length}</span>
        </div>

        <label className="skill-search">
          <span className="sr-only">搜索 Skill</span>
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索名称或描述"
          />
        </label>

        <div className="skill-list">
          {filteredSkills.length === 0 ? (
            <div className="skill-list-empty">{search ? "没有匹配结果" : "暂无 Skill"}</div>
          ) : (
            filteredSkills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className={`skill-list-item${selectedSkillId === skill.id ? " active" : ""}`}
                aria-pressed={selectedSkillId === skill.id}
                onClick={() => requestTarget(skill.id)}
              >
                <span className={`skill-state-dot${skill.enabled ? " enabled" : ""}`} />
                <span className="skill-list-copy">
                  <strong>{skill.name}</strong>
                  <small>{skill.description}</small>
                </span>
                <code>v{skill.currentVersion}</code>
              </button>
            ))
          )}
        </div>

        {canEdit ? (
          <button
            type="button"
            className="button button-secondary skill-create-button"
            onClick={() => requestTarget("new")}
          >
            <Plus size={17} aria-hidden="true" />
            新建 Skill
          </button>
        ) : (
          <div className="skill-readonly-note">当前实例为只读权限</div>
        )}
      </section>

      <section className="skill-workspace tool-panel" aria-label="Skill 编辑器">
        {selectedSkillId && (details.isPending || editor.target !== selectedSkillId) ? (
          <LoadingPanel label="正在读取 SKILL.md" />
        ) : details.isError && selectedSkillId ? (
          <ErrorPanel error={details.error} />
        ) : editor.target === null ? (
          <EmptyState title="选择一个 Skill" detail="从左侧列表打开现有内容" />
        ) : (
          <>
            <header className="skill-editor-header">
              <div className="skill-editor-title">
                <span className="skill-file-icon">
                  <FileCode2 size={19} aria-hidden="true" />
                </span>
                <span>
                  <span className="skill-section-kicker">SKILL.md</span>
                  <strong>{isCreating ? validation?.name ?? "未命名 Skill" : selectedSkill?.name}</strong>
                </span>
              </div>
              <div className="skill-editor-actions">
                {!isCreating && details.data ? (
                  <label className="skill-enable-control">
                    <span>{details.data.skill.enabled ? "已启用" : "已停用"}</span>
                    <Switch.Root
                      className="switch-root"
                      checked={details.data.skill.enabled}
                      disabled={!canEdit || updateSkill.isPending}
                      aria-label={details.data.skill.enabled ? "停用 Skill" : "启用 Skill"}
                      onCheckedChange={(enabled) =>
                        updateSkill.mutate({ skill: details.data.skill, enabled })
                      }
                    >
                      <Switch.Thumb className="switch-thumb" />
                    </Switch.Root>
                  </label>
                ) : null}
                <IconButton
                  label={isCreating ? "恢复模板" : "放弃未发布修改"}
                  disabled={!canEdit || (!isCreating && !isDirty)}
                  onClick={() =>
                    setEditor((current) => ({
                      ...current,
                      content: isCreating ? newSkillTemplate : current.baseline,
                    }))
                  }
                >
                  <RefreshCw size={17} />
                </IconButton>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!canEdit || validationState === "checking" || !editor.content.trim()}
                  onClick={() => void runValidation(editor.content)}
                >
                  {validationState === "checking" ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <CheckCircle2 size={16} />
                  )}
                  校验
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!canPublish}
                  onClick={() => {
                    if (isCreating) {
                      createSkill.mutate({ content: editor.content });
                    } else if (selectedSkillId && editor.expectedVersion !== null) {
                      createVersion.mutate({
                        skillId: selectedSkillId,
                        content: editor.content,
                        expectedVersion: editor.expectedVersion,
                      });
                    }
                  }}
                >
                  {pending ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
                  {isCreating ? "创建" : "发布新版本"}
                </button>
              </div>
            </header>

            {remoteChanged ? (
              <div className="skill-conflict-banner" role="alert">
                <AlertTriangle size={17} aria-hidden="true" />
                <span>该 Skill 已在其他位置更新，重新载入后才能继续发布。</span>
                <button type="button" className="button button-secondary" onClick={reloadCurrent}>
                  载入最新版本
                </button>
              </div>
            ) : null}

            <div className="skill-editor-meta">
              <span>
                <strong>{editor.content.split("\n").length}</strong>
                行
              </span>
              <span>
                <strong>{editor.content.length}</strong>
                字符
              </span>
              {!isCreating && details.data ? (
                <span>
                  <strong>v{details.data.skill.currentVersion}</strong>
                  当前版本
                </span>
              ) : null}
              <span className="skill-validation-summary" aria-live="polite">
                {validationState === "waiting" || validationState === "checking" ? (
                  <>
                    <LoaderCircle className="spin" size={14} /> 等待校验
                  </>
                ) : effectiveValidation?.valid ? (
                  <>
                    <CheckCircle2 size={14} /> 校验通过
                  </>
                ) : effectiveValidation ? (
                  <>
                    <CircleAlert size={14} /> 需要修正
                  </>
                ) : canEdit ? (
                  "尚未校验"
                ) : (
                  "只读"
                )}
              </span>
            </div>

            <label className="skill-code-editor">
              <span className="sr-only">SKILL.md 内容</span>
              <textarea
                value={editor.content}
                readOnly={!canEdit}
                spellCheck={false}
                onChange={(event) =>
                  setEditor((current) => ({ ...current, content: event.target.value }))
                }
              />
            </label>

            <div className="skill-inspector">
              <section className="skill-validation-panel">
                <div className="skill-inspector-heading">
                  <span>
                    <CheckCircle2 size={16} aria-hidden="true" />
                    校验结果
                  </span>
                  {effectiveValidation?.contentHash ? (
                    <code>{effectiveValidation.contentHash.slice(0, 12)}</code>
                  ) : null}
                </div>
                {!canEdit ? (
                  <div className="skill-inspector-empty">已发布内容</div>
                ) : validationState !== "idle" ? (
                  <div className="skill-inspector-empty">
                    <LoaderCircle className="spin" size={16} /> 正在检查内容
                  </div>
                ) : !effectiveValidation ? (
                  <div className="skill-inspector-empty">等待内容校验</div>
                ) : effectiveValidation.issues.length === 0 ? (
                  <div className="skill-validation-ok">
                    <CheckCircle2 size={17} aria-hidden="true" />
                    <span>
                      <strong>{effectiveValidation.name}</strong>
                      <small>{effectiveValidation.description}</small>
                    </span>
                  </div>
                ) : (
                  <ul className="skill-issue-list">
                    {effectiveValidation.issues.map((issue) => (
                      <li key={`${issue.code}-${issue.message}`} className={issue.severity}>
                        {issue.severity === "error" ? (
                          <CircleAlert size={16} aria-hidden="true" />
                        ) : (
                          <AlertTriangle size={16} aria-hidden="true" />
                        )}
                        <span>
                          <strong>{issue.code}</strong>
                          <small>{issue.message}</small>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="skill-history-panel">
                <div className="skill-inspector-heading">
                  <span>
                    <History size={16} aria-hidden="true" />
                    版本历史
                  </span>
                  <span>{details.data?.versions.length ?? 0}</span>
                </div>
                {isCreating ? (
                  <div className="skill-inspector-empty">创建后生成 v1</div>
                ) : (
                  <div className="skill-version-list">
                    {details.data?.versions.map((version) => (
                      <div
                        key={version.id}
                        className={`skill-version-row${
                          version.id === editor.currentVersionId ? " current" : ""
                        }`}
                      >
                        <span className="skill-version-number">v{version.version}</span>
                        <span>
                          <code>{version.contentHash.slice(0, 10)}</code>
                          <small>
                            <Clock3 size={12} aria-hidden="true" />
                            {formatDateTime(version.createdAt)}
                          </small>
                        </span>
                        {version.id === editor.currentVersionId ? <strong>当前</strong> : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </section>

      <ConfirmDialog
        open={pendingTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTarget(null);
          }
        }}
        title="放弃未发布修改？"
        description="当前编辑内容尚未发布，切换后这些修改不会保留。"
        confirmLabel="放弃并切换"
        danger
        onConfirm={() => {
          if (pendingTarget) {
            openTarget(pendingTarget);
          }
          setPendingTarget(null);
        }}
      />
    </div>
  );
}
