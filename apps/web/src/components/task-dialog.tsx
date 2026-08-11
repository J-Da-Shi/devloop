import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, CornerDownLeft, GitMerge, Play, RotateCcw, Save, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { Project, Task } from "@devloop/shared";
import { api, queryKeys } from "../api.js";
import { formatDateTime, runStatusText, taskStatusText } from "../utils.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { ErrorPanel, InlineNotice, LoadingPanel } from "./feedback.js";
import { IconButton } from "./icon-button.js";
import { useNotice } from "./notice-provider.js";
import { StatusBadge } from "./status-badge.js";

const taskFormSchema = z.object({
  projectId: z.string().uuid("请选择项目"),
  title: z.string().trim().min(1, "请输入任务标题").max(160, "标题不能超过 160 个字符"),
  goal: z.string().trim().min(1, "请输入任务目标").max(8_000, "目标内容过长"),
  criteriaText: z.string().trim().min(1, "请至少填写一条验收标准"),
  priority: z.number().int().min(0).max(100),
});

type TaskFormValues = z.infer<typeof taskFormSchema>;
type ConfirmAction = "confirm" | "unconfirm" | "approve" | "apply" | "reject" | null;

interface TaskDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  task: Task | null;
  projects: Project[];
}

const splitCriteria = (value: string): string[] =>
  value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

const roleAllowsEdit = (role: "viewer" | "operator" | "editor"): boolean => role === "editor";

export function TaskDialog({ open, onOpenChange, task, projects }: TaskDialogProps) {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [rejectFeedback, setRejectFeedback] = useState("");
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    staleTime: 60_000,
  });
  const runDetails = useQuery({
    queryKey: queryKeys.run(task?.latestRunId ?? "none"),
    queryFn: () => api.run(task?.latestRunId ?? ""),
    enabled: Boolean(task?.latestRunId),
  });
  const defaults = useMemo<TaskFormValues>(
    () => ({
      projectId: task?.projectId ?? projects[0]?.id ?? "",
      title: task?.title ?? "",
      goal: task?.goal ?? "",
      criteriaText: task?.acceptanceCriteria.join("\n") ?? "",
      priority: task?.priority ?? 50,
    }),
    [projects, task],
  );
  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: defaults,
  });

  useEffect(() => {
    if (open) {
      form.reset(defaults);
      setRejectFeedback("");
    }
  }, [defaults, form, open]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
      queryClient.invalidateQueries({ queryKey: queryKeys.runs }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: async (values: TaskFormValues) => {
      const acceptanceCriteria = splitCriteria(values.criteriaText);
      if (task) {
        return api.updateTask(task.id, {
          title: values.title,
          goal: values.goal,
          acceptanceCriteria,
          priority: values.priority,
          expectedVersion: task.version,
          idempotencyKey: crypto.randomUUID(),
        });
      }
      return api.createTask({
        projectId: values.projectId,
        title: values.title,
        goal: values.goal,
        acceptanceCriteria,
        priority: values.priority,
      });
    },
    onSuccess: async (data) => {
      await invalidate();
      notify(
        data.task.status === "READY"
          ? "分数达到 100，已自动加入待执行"
          : task
            ? "草稿已保存"
            : "任务已创建",
      );
      onOpenChange(false);
    },
    onError: (error) => notify(error instanceof Error ? error.message : "保存失败", "danger"),
  });

  const commandMutation = useMutation({
    mutationFn: async (action: Exclude<ConfirmAction, null>) => {
      if (!task) {
        throw new Error("任务尚未创建");
      }
      const idempotencyKey = crypto.randomUUID();
      if (action === "confirm") {
        const project = projects.find((item) => item.id === task.projectId);
        return api.confirmTask(task.id, {
          expectedVersion: task.version,
          idempotencyKey,
          baseStrategy: "LATEST_ACCEPTED",
          baseRef: project?.defaultBaseRef ?? "HEAD",
        });
      }
      if (action === "unconfirm") {
        return api.unconfirmTask(task.id, { expectedVersion: task.version, idempotencyKey });
      }
      if (!task.latestRunId) {
        throw new Error("任务没有可审核的执行记录");
      }
      if (action === "approve") {
        return api.approveRun(task.latestRunId, {
          expectedVersion: task.version,
          idempotencyKey,
        });
      }
      if (action === "apply") {
        return api.applyRun(task.latestRunId, {
          expectedVersion: task.version,
          idempotencyKey,
        });
      }
      if (!rejectFeedback.trim()) {
        throw new Error("请填写驳回意见");
      }
      return api.rejectRun(task.latestRunId, {
        expectedVersion: task.version,
        idempotencyKey,
        feedback: rejectFeedback.trim(),
      });
    },
    onSuccess: async (data, action) => {
      await invalidate();
      const messages: Record<Exclude<ConfirmAction, null>, string> = {
        confirm: "任务已确认并加入队列",
        unconfirm: "任务已撤回为草稿",
        approve: "执行结果已通过",
        apply:
          "application" in data && data.application.status === "already_applied"
            ? "当前项目目录已经包含该结果"
            : "结果已覆盖到当前项目目录",
        reject: "审核意见已提交，任务将重新排队",
      };
      notify(messages[action]);
      setConfirmAction(null);
      onOpenChange(false);
    },
    onError: (error) => notify(error instanceof Error ? error.message : "操作失败", "danger"),
  });

  const canEdit = session.data ? roleAllowsEdit(session.data.identity.role) : false;
  const isLocalEditor = canEdit && session.data?.identity.local === true;
  const editable = !task || task.status === "DRAFT";
  const pending = saveMutation.isPending || commandMutation.isPending;
  const appliedToProject =
    runDetails.data?.events.some((event) => event.type === "run.applied") ?? false;
  const projectPath = projects.find((project) => project.id === task?.projectId)?.path;
  const confirmCopy = {
    confirm: {
      title: "确认任务并加入队列？",
      description: "确认后将生成不可变 Revision，Worker 空闲时会自动领取。",
      label: "确认并排队",
      danger: false,
    },
    unconfirm: {
      title: "撤回为草稿？",
      description: "任务会离开待执行队列，修改后需要重新确认。",
      label: "撤回任务",
      danger: false,
    },
    approve: {
      title: "通过本次执行结果？",
      description: "任务将进入已完成状态，并推进 DevLoop 的集成基线。",
      label: "通过结果",
      danger: false,
    },
    apply: {
      title: "覆盖到当前项目目录？",
      description: `仅在 ${projectPath ?? "当前项目"} 工作区干净且可以安全快进时执行。不会丢弃未提交内容，不满足条件时会停止。`,
      label: "确认覆盖",
      danger: true,
    },
    reject: {
      title: "驳回并重新排队？",
      description: "审核意见会写入新 Revision，Worker 将按新版本重新执行。",
      label: "驳回结果",
      danger: true,
    },
  } as const;
  const activeCopy = confirmAction ? confirmCopy[confirmAction] : null;

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content task-dialog">
            <div className="dialog-heading">
              <div>
                <Dialog.Title>{task ? task.title : "创建任务"}</Dialog.Title>
                <Dialog.Description>
                  {task
                    ? `${task.projectName} · 更新于 ${formatDateTime(task.updatedAt)}`
                    : "创建一个可确认的任务草稿"}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <IconButton label="关闭" disabled={pending}>
                  <X size={18} />
                </IconButton>
              </Dialog.Close>
            </div>

            {task ? (
              <div className="task-dialog-status">
                <StatusBadge status={task.status} pulse={task.status === "RUNNING"}>
                  {taskStatusText[task.status]}
                </StatusBadge>
                <span>分数 {task.priority}</span>
                <span>版本 {task.version}</span>
              </div>
            ) : null}

            {!canEdit && editable ? (
              <InlineNotice tone="warning">
                当前设备是只读角色，需要在桌面端提升为 editor。
              </InlineNotice>
            ) : null}

            {editable ? (
              <form
                className="form-stack"
                onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}
              >
                <label className="field">
                  <span>项目</span>
                  <select disabled={Boolean(task) || !canEdit} {...form.register("projectId")}>
                    <option value="">选择项目</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  {form.formState.errors.projectId ? (
                    <small className="field-error">{form.formState.errors.projectId.message}</small>
                  ) : null}
                </label>
                <label className="field">
                  <span>标题</span>
                  <input disabled={!canEdit} autoFocus={!task} {...form.register("title")} />
                  {form.formState.errors.title ? (
                    <small className="field-error">{form.formState.errors.title.message}</small>
                  ) : null}
                </label>
                <label className="field">
                  <span>任务目标</span>
                  <textarea disabled={!canEdit} rows={5} {...form.register("goal")} />
                  {form.formState.errors.goal ? (
                    <small className="field-error">{form.formState.errors.goal.message}</small>
                  ) : null}
                </label>
                <label className="field">
                  <span>验收标准</span>
                  <textarea
                    disabled={!canEdit}
                    rows={5}
                    placeholder="每行一条"
                    {...form.register("criteriaText")}
                  />
                  {form.formState.errors.criteriaText ? (
                    <small className="field-error">
                      {form.formState.errors.criteriaText.message}
                    </small>
                  ) : null}
                </label>
                <label className="field field-compact">
                  <span>分数</span>
                  <input
                    disabled={!canEdit}
                    type="number"
                    min="0"
                    max="100"
                    {...form.register("priority", { valueAsNumber: true })}
                  />
                </label>
                <div className="dialog-actions">
                  {task && canEdit ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setConfirmAction("confirm")}
                      disabled={pending || form.formState.isDirty}
                    >
                      <Play size={17} />
                      确认并排队
                    </button>
                  ) : null}
                  {canEdit ? (
                    <button type="submit" className="button button-primary" disabled={pending}>
                      <Save size={17} />
                      {saveMutation.isPending ? "正在保存" : task ? "保存草稿" : "创建草稿"}
                    </button>
                  ) : null}
                </div>
              </form>
            ) : (
              <div className="task-readonly">
                <section>
                  <h3>任务目标</h3>
                  <p>{task?.goal}</p>
                </section>
                <section>
                  <h3>验收标准</h3>
                  <ul>
                    {task?.acceptanceCriteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                </section>
                {task?.latestRunId ? (
                  <section>
                    <h3>最近执行</h3>
                    {runDetails.isPending ? <LoadingPanel label="正在加载执行记录" /> : null}
                    {runDetails.isError ? <ErrorPanel error={runDetails.error} /> : null}
                    {runDetails.data ? (
                      <div className="run-summary-block">
                        <StatusBadge status={runDetails.data.run.status}>
                          {runStatusText[runDetails.data.run.status]}
                        </StatusBadge>
                        <p>{runDetails.data.run.summary ?? "执行尚未生成摘要"}</p>
                        <ol className="event-list compact">
                          {runDetails.data.events.map((event) => (
                            <li key={event.id}>
                              <span>{event.message}</span>
                              <time>{formatDateTime(event.createdAt)}</time>
                            </li>
                          ))}
                        </ol>
                      </div>
                    ) : null}
                  </section>
                ) : null}
                {task?.status === "REVIEW" && canEdit ? (
                  <section className="review-actions">
                    <label className="field">
                      <span>驳回意见</span>
                      <textarea
                        rows={3}
                        value={rejectFeedback}
                        onChange={(event) => setRejectFeedback(event.target.value)}
                        placeholder="驳回时必填"
                      />
                    </label>
                    <div className="dialog-actions">
                      <button
                        type="button"
                        className="button button-danger-quiet"
                        onClick={() => setConfirmAction("reject")}
                        disabled={pending || !rejectFeedback.trim()}
                      >
                        <CornerDownLeft size={17} />
                        驳回
                      </button>
                      <button
                        type="button"
                        className="button button-primary"
                        onClick={() => setConfirmAction("approve")}
                        disabled={pending}
                      >
                        <Check size={17} />
                        通过
                      </button>
                    </div>
                  </section>
                ) : null}
                {task?.status === "READY" && canEdit ? (
                  <div className="dialog-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setConfirmAction("unconfirm")}
                      disabled={pending}
                    >
                      <RotateCcw size={17} />
                      撤回为草稿
                    </button>
                  </div>
                ) : null}
                {task?.status === "COMPLETED" && runDetails.data ? (
                  <section className="apply-actions">
                    <h3>当前项目目录</h3>
                    <InlineNotice tone={appliedToProject ? "success" : "info"}>
                      {appliedToProject
                        ? "结果 Commit 已经应用到当前项目目录。"
                        : isLocalEditor
                          ? "结果 Commit 仍位于 DevLoop 分支，覆盖前会检查工作区和分支关系。"
                          : "覆盖项目目录只能在 Mac 本机客户端执行。"}
                    </InlineNotice>
                    {isLocalEditor && !appliedToProject && runDetails.data.run.resultCommit ? (
                      <div className="dialog-actions">
                        <button
                          type="button"
                          className="button button-danger-quiet"
                          onClick={() => setConfirmAction("apply")}
                          disabled={pending}
                        >
                          <GitMerge size={17} />
                          覆盖到当前项目目录
                        </button>
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {activeCopy ? (
        <ConfirmDialog
          open={Boolean(confirmAction)}
          onOpenChange={(next) => !next && setConfirmAction(null)}
          title={activeCopy.title}
          description={activeCopy.description}
          confirmLabel={activeCopy.label}
          danger={activeCopy.danger}
          pending={commandMutation.isPending}
          onConfirm={() => confirmAction && commandMutation.mutate(confirmAction)}
        />
      ) : null}
    </>
  );
}
