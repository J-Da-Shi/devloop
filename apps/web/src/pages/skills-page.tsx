import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Switch } from "antd";
import type { Skill, SkillValidationResult } from "@devloop/shared";
import {
  CheckCircle2,
  CircleAlert,
  FileCode2,
  LoaderCircle,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, queryKeys } from "../core/index.js";
import type { SkillEditorState, SkillValidationState } from "../types/index.js";
import {
  ConfirmDialog,
  EmptyState,
  ErrorPanel,
  IconButton,
  LoadingPanel,
  useNotice,
} from "../components/common/index.js";
import { SkillInspector, SkillRegistry } from "../components/business/skills/index.js";

const newSkillTemplate = `---
name: new-skill
description: 描述这个 Skill 的适用场景
---

# 工作流程

1. 写明需要执行的步骤。
2. 写明需要检查的结果。
`;

const emptyEditor: SkillEditorState = {
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
  const [editor, setEditor] = useState<SkillEditorState>(emptyEditor);
  const [search, setSearch] = useState("");
  const [pendingTarget, setPendingTarget] = useState<string | "new" | null>(null);
  const [validation, setValidation] = useState<SkillValidationResult | null>(null);
  const [validationState, setValidationState] = useState<SkillValidationState>("idle");
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
        current.target === skill.id ? { ...current, expectedVersion: skill.version } : current,
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
      <SkillRegistry
        skills={filteredSkills}
        totalCount={skills.data.skills.length}
        selectedSkillId={selectedSkillId}
        search={search}
        canEdit={canEdit === true}
        onSearch={setSearch}
        onSelect={requestTarget}
      />

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
                  <strong>
                    {isCreating ? (validation?.name ?? "未命名 Skill") : selectedSkill?.name}
                  </strong>
                </span>
              </div>
              <div className="skill-editor-actions">
                {!isCreating && details.data ? (
                  <span className="skill-enable-control">
                    <span>{details.data.skill.enabled ? "已启用" : "已停用"}</span>
                    <Switch
                      checked={details.data.skill.enabled}
                      disabled={!canEdit || updateSkill.isPending}
                      aria-label={details.data.skill.enabled ? "停用 Skill" : "启用 Skill"}
                      loading={updateSkill.isPending}
                      onChange={(enabled) =>
                        updateSkill.mutate({ skill: details.data.skill, enabled })
                      }
                    />
                  </span>
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
                <Button
                  icon={validationState === "checking" ? undefined : <CheckCircle2 size={16} />}
                  loading={validationState === "checking"}
                  disabled={!canEdit || validationState === "checking" || !editor.content.trim()}
                  onClick={() => void runValidation(editor.content)}
                >
                  校验
                </Button>
                <Button
                  type="primary"
                  icon={pending ? undefined : <Upload size={16} />}
                  loading={pending}
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
                  {isCreating ? "创建" : "发布新版本"}
                </Button>
              </div>
            </header>

            {remoteChanged ? (
              <Alert
                className="skill-conflict-banner"
                type="warning"
                showIcon
                title="该 Skill 已在其他位置更新，重新载入后才能继续发布。"
                action={
                  <Button size="small" onClick={reloadCurrent}>
                    载入最新版本
                  </Button>
                }
              />
            ) : null}

            <div className="skill-editor-meta">
              <span>
                <strong>{editor.content.split("\n").length}</strong>行
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

            <div className="skill-code-editor">
              <Input.TextArea
                aria-label="SKILL.md 内容"
                value={editor.content}
                readOnly={!canEdit}
                spellCheck={false}
                onChange={(event) =>
                  setEditor((current) => ({ ...current, content: event.target.value }))
                }
              />
            </div>

            <SkillInspector
              canEdit={canEdit === true}
              isCreating={isCreating}
              validationState={validationState}
              validation={effectiveValidation}
              details={details.data}
              currentVersionId={editor.currentVersionId}
            />
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
