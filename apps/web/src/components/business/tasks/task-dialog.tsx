import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Form, Input, Modal } from "antd";
import { Ban, Check, CornerDownLeft, GitBranch, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import type { Project, RunApplicationResult, RunPublishResult, Task } from "@devloop/shared";
import {
  api,
  formatDateTime,
  queryKeys,
  runStatusText,
  taskStatusText,
  taskTypeText,
} from "../../../core/index.js";
import {
  ConfirmDialog,
  ErrorPanel,
  InlineNotice,
  LoadingPanel,
  StatusBadge,
  useNotice,
} from "../../common/index.js";
import { RunDiffPanel, RunEventList, RunValidationPanel } from "../runs/index.js";
import type { RunDiffApprovalState } from "../../../types/index.js";
import { TaskEditorForm } from "./task-editor-form.js";
import {
  splitCriteria,
  taskFormSchema,
  type ConfirmAction,
  type TaskFormValues,
} from "../../../types/index.js";

interface TaskDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  task: Task | null;
  projects: Project[];
}

const roleAllowsEdit = (role: "viewer" | "operator" | "editor"): boolean => role === "editor";

export function TaskDialog({ open, onOpenChange, task, projects }: TaskDialogProps) {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [rejectFeedback, setRejectFeedback] = useState("");
  const [diffApprovalState, setDiffApprovalState] = useState<RunDiffApprovalState | null>(null);
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
  const defaults = useMemo<TaskFormValues>(() => {
    const projectId = task?.projectId ?? projects[0]?.id ?? "";
    const project = projects.find((item) => item.id === projectId);
    return {
      projectId,
      taskType: task?.taskType ?? "DEVELOPMENT",
      targetBranch: task?.targetBranch ?? project?.defaultBaseRef ?? "HEAD",
      title: task?.title ?? "",
      goal: task?.goal ?? "",
      criteriaText: task?.acceptanceCriteria.join("\n") ?? "",
      priority: task?.priority ?? 50,
      autoResolveConflicts: task?.autoResolveConflicts ?? true,
    };
  }, [projects, task]);
  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: defaults,
  });
  const selectedTaskType = form.watch("taskType");

  useEffect(() => {
    if (open) {
      form.reset(defaults);
      setRejectFeedback("");
      setDiffApprovalState(null);
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
          taskType: values.taskType,
          targetBranch: values.targetBranch,
          title: values.title,
          goal: values.goal,
          acceptanceCriteria,
          priority: values.priority,
          autoResolveConflicts: values.autoResolveConflicts,
          expectedVersion: task.version,
          idempotencyKey: crypto.randomUUID(),
        });
      }
      return api.createTask({
        projectId: values.projectId,
        taskType: values.taskType,
        targetBranch: values.targetBranch,
        title: values.title,
        goal: values.goal,
        acceptanceCriteria,
        priority: values.priority,
        autoResolveConflicts: values.autoResolveConflicts,
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
      if (action === "confirm" || action === "retry") {
        const project = projects.find((item) => item.id === task.projectId);
        return api.confirmTask(task.id, {
          expectedVersion: task.version,
          idempotencyKey,
          baseStrategy: "LATEST_ACCEPTED",
          baseRef: task.targetBranch ?? project?.defaultBaseRef ?? "HEAD",
        });
      }
      if (action === "unconfirm" || action === "revise") {
        return api.unconfirmTask(task.id, { expectedVersion: task.version, idempotencyKey });
      }
      if (action === "continue") {
        return api.continueTask(task.id, { expectedVersion: task.version, idempotencyKey });
      }
      if (action === "cancel") {
        return api.cancelTask(task.id, { expectedVersion: task.version, idempotencyKey });
      }
      if (action === "delete") {
        return api.deleteTask(task.id, { expectedVersion: task.version, idempotencyKey });
      }
      if (!task.latestRunId) {
        throw new Error("任务没有可审核的执行记录");
      }
      if (action === "approve") {
        return api.approveRun(task.latestRunId, {
          expectedVersion: task.version,
          idempotencyKey,
          ...(localProject && diffApprovalState
            ? {
                expectedTargetCommit: diffApprovalState.expectedTargetCommit,
                conflictResolutions: diffApprovalState.conflictResolutions,
              }
            : {}),
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
      const publication =
        action === "approve" && "publication" in data
          ? (data.publication as RunPublishResult | undefined)
          : null;
      const application =
        action === "approve" && "application" in data
          ? (data.application as RunApplicationResult | undefined)
          : null;
      const research =
        action === "approve" && "research" in data
          ? (data.research as { status: "accepted"; summary: string } | undefined)
          : null;
      const messages: Record<Exclude<ConfirmAction, null>, string> = {
        confirm: "任务已确认并加入队列",
        unconfirm: "任务已撤回为草稿",
        continue: "已进入新一轮草稿，请补充需求后确认排队",
        retry: researchTask
          ? "已带上上次失败诊断并重新加入队列"
          : "已从上次失败的保存进度继续加入队列",
        revise: "任务已退回草稿，可修改后重新排队",
        cancel: "执行已取消，Worktree 和日志已保留",
        delete: "任务已删除，执行历史仍会保留",
        approve:
          research?.status === "accepted"
            ? "研究总结已通过审核"
            : application?.status === "already_applied"
              ? `本地分支 ${application.branch} 已包含该结果`
              : application
                ? `结果已写入本地分支 ${application.branch}`
                : publication?.status === "already_pushed"
                  ? `远程分支 ${publication.branch} 已包含该结果`
                  : `结果已推送到远程分支 ${publication?.branch ?? targetBranch}`,
        reject: "审核意见已提交，任务将重新排队",
      };
      notify(messages[action]);
      setConfirmAction(null);
      if (action !== "approve" && action !== "continue") {
        onOpenChange(false);
      }
    },
    onError: (error, action) => {
      if (action === "approve" && task?.latestRunId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.runChangedFiles(task.latestRunId),
        });
      }
      notify(error instanceof Error ? error.message : "操作失败", "danger");
    },
  });

  const canEdit = session.data ? roleAllowsEdit(session.data.identity.role) : false;
  const canOperate = session.data ? session.data.identity.role !== "viewer" : false;
  const editable = !task || task.status === "DRAFT";
  const canRecover = Boolean(
    task && (task.status === "BLOCKED" || task.status === "FAILED") && canEdit,
  );
  const canCancel = Boolean(task?.status === "RUNNING" && canOperate);
  const canDelete = Boolean(task && task.status !== "RUNNING" && canEdit);
  const pending = saveMutation.isPending || commandMutation.isPending;
  const taskProject = projects.find((project) => project.id === task?.projectId);
  const researchTask = (task?.taskType ?? selectedTaskType) === "RESEARCH";
  const localProject = !researchTask && taskProject?.repositoryUrl === null;
  const targetBranch = task?.targetBranch ?? runDetails.data?.run.targetBranch ?? "目标分支";
  const unresolvedConflictCount = diffApprovalState?.unresolvedPaths.length ?? 0;
  const agentResolving = diffApprovalState?.agentResolving ?? false;
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
    continue: {
      title: researchTask ? "基于当前总结继续研究？" : "基于当前完成结果继续迭代？",
      description: researchTask
        ? "任务会转为可编辑草稿，已有总结、来源记录和审核结果全部保留。补充研究要求后可再次执行。"
        : "任务会转为可编辑草稿，已有 Revision、执行记录和审核结果全部保留。补充新需求并确认后，下一轮会以目标分支最新接受的代码为基础。",
      label: researchTask ? "继续研究" : "继续迭代",
      danger: false,
    },
    retry: {
      title: "从上次失败处继续重试？",
      description: researchTask
        ? "系统会保存上次失败的摘要和日志，并将它们带入下一轮研究。"
        : "系统会保存上次失败的摘要和日志；已保存的代码进度会先与最新目标分支对齐，再继续执行。",
      label: "继续重试",
      danger: false,
    },
    revise: {
      title: "退回草稿并修改？",
      description: "任务会转为可编辑草稿，已有 Run 和失败记录继续保留。",
      label: "退回草稿",
      danger: false,
    },
    cancel: {
      title: "取消当前执行？",
      description: researchTask
        ? "Agent 进程会被终止，任务和 Run 将进入已取消状态；隔离工作区和运行日志会保留。"
        : "Codex CLI 会被终止，任务和 Run 将进入已取消状态；Worktree、代码修改和运行日志会保留。",
      label: "确认取消",
      danger: true,
    },
    delete: {
      title: "删除这个任务？",
      description: researchTask
        ? "任务会从看板和调度队列中移除，但 Revision、研究总结和运行日志仍会保留。"
        : "任务会从看板和调度队列中移除，但 Revision、执行记录、日志和 Git 结果仍会保留。",
      label: "确认删除",
      danger: true,
    },
    approve: {
      title: researchTask
        ? "通过这份研究总结？"
        : localProject
          ? "通过并写入本地项目？"
          : "通过并推送本次结果？",
      description: researchTask
        ? "通过后任务将标记为已完成，不会向项目分支写入任何文件。"
        : localProject
          ? unresolvedConflictCount > 0
            ? `仍有 ${unresolvedConflictCount} 个冲突文件未解决，继续写入会被拒绝。`
            : `DevLoop 会把结果安全写入本地分支 ${targetBranch}。目标文件存在未提交修改或分支已变化时会停止，不会覆盖现有工作。`
          : `DevLoop 会把结果安全推送到远程分支 ${targetBranch}。远程分支已前进时不会强制覆盖，任务会继续停留在审核状态。`,
      label: researchTask ? "通过总结" : localProject ? "通过并写入" : "通过并推送",
      danger: false,
    },
    reject: {
      title: researchTask ? "驳回并重新研究？" : "驳回并重新排队？",
      description: "审核意见会写入新 Revision，Worker 将按新版本重新执行。",
      label: "驳回结果",
      danger: true,
    },
  } as const;
  const activeCopy = confirmAction ? confirmCopy[confirmAction] : null;

  return (
    <>
      <Modal
        open={open}
        width={900}
        footer={null}
        closable={!pending}
        keyboard={!pending}
        mask={{ closable: !pending }}
        onCancel={() => !pending && onOpenChange(false)}
        className="task-dialog"
        title={
          <span className="task-dialog-title">
            <strong>{task ? task.title : "创建任务"}</strong>
            <small>
              {task
                ? `${task.projectName} · 更新于 ${formatDateTime(task.updatedAt)}`
                : "创建一个可确认的任务草稿"}
            </small>
          </span>
        }
      >
        {task ? (
          <div className="task-dialog-status">
            <StatusBadge status={task.status} pulse={task.status === "RUNNING"}>
              {taskStatusText[task.status]}
            </StatusBadge>
            <span>分数 {task.priority}</span>
            <span>版本 {task.version}</span>
            <span>{taskTypeText[task.taskType]}</span>
            {task.taskType === "DEVELOPMENT" ? (
              <span>{task.autoResolveConflicts ? "自动解决冲突" : "人工解决冲突"}</span>
            ) : null}
          </div>
        ) : null}

        {!canEdit && editable ? (
          <InlineNotice tone="warning">当前实例处于只读模式，无法修改任务。</InlineNotice>
        ) : null}

        {editable ? (
          <TaskEditorForm
            form={form}
            projects={projects}
            task={task}
            canEdit={canEdit}
            selectedTaskType={selectedTaskType}
            pending={pending}
            saving={saveMutation.isPending}
            onSubmit={() => {
              void form.handleSubmit((values) => saveMutation.mutate(values))();
            }}
            onConfirm={() => setConfirmAction("confirm")}
          />
        ) : (
          <>
            <div className="task-readonly task-readonly-summary" aria-label="任务概要">
              <section>
                <h3>{researchTask ? "任务类型" : "目标分支"}</h3>
                {researchTask ? (
                  <p>{task ? taskTypeText[task.taskType] : "互联网研究"}</p>
                ) : (
                  <code>
                    <GitBranch size={15} />
                    {task?.targetBranch}
                  </code>
                )}
              </section>
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
            </div>
            <div className="task-dialog-scroll-region">
              <div className="task-readonly task-readonly-details">
                {task?.latestRunId ? (
                  <section>
                    <h3>{researchTask ? "最近研究" : "最近执行"}</h3>
                    {runDetails.isPending ? <LoadingPanel label="正在加载执行记录" /> : null}
                    {runDetails.isError ? <ErrorPanel error={runDetails.error} /> : null}
                    {runDetails.data ? (
                      <div className="run-summary-block">
                        <StatusBadge status={runDetails.data.run.status}>
                          {runStatusText[runDetails.data.run.status]}
                        </StatusBadge>
                        <p>{runDetails.data.run.summary ?? "执行尚未生成摘要"}</p>
                        <RunEventList
                          events={runDetails.data.events}
                          streamKey={runDetails.data.run.id}
                          compact
                          label="最近执行日志"
                          title="执行日志"
                        />
                      </div>
                    ) : null}
                  </section>
                ) : null}
                {!researchTask && task?.latestRunId && runDetails.data?.run.resultCommit ? (
                  <section>
                    <h3>代码变更</h3>
                    <RunDiffPanel
                      runId={task.latestRunId}
                      reviewing={task.status === "REVIEW"}
                      taskVersion={task.version}
                      canResolveConflicts={Boolean(
                        localProject && task.status === "REVIEW" && canEdit,
                      )}
                      onApprovalStateChange={
                        localProject && task.status === "REVIEW" ? setDiffApprovalState : undefined
                      }
                    />
                  </section>
                ) : null}
                {!researchTask &&
                task?.latestRunId &&
                runDetails.data &&
                (runDetails.data.run.status === "SUCCEEDED" ||
                  runDetails.data.events.some((event) =>
                    event.type.startsWith("run.playwright."),
                  )) ? (
                  <RunValidationPanel
                    runId={task.latestRunId}
                    report={runDetails.data.validation.report}
                    artifacts={runDetails.data.validation.artifacts}
                    previewConfiguration={runDetails.data.previewConfiguration}
                    previewTitle={task.title}
                    canPreview={canOperate && runDetails.data.run.status === "SUCCEEDED"}
                  />
                ) : null}
                {task?.status === "REVIEW" && canEdit ? (
                  <section className="review-actions">
                    <Form.Item label="驳回意见" required>
                      <Input.TextArea
                        rows={3}
                        value={rejectFeedback}
                        onChange={(event) => setRejectFeedback(event.target.value)}
                        placeholder="驳回时必填"
                      />
                    </Form.Item>
                    <div className="dialog-actions">
                      <Button
                        danger
                        icon={<CornerDownLeft size={17} />}
                        onClick={() => setConfirmAction("reject")}
                        disabled={pending || agentResolving || !rejectFeedback.trim()}
                      >
                        驳回
                      </Button>
                      <Button
                        type="primary"
                        icon={<Check size={17} />}
                        onClick={() => setConfirmAction("approve")}
                        disabled={pending || agentResolving}
                      >
                        {researchTask ? "通过总结" : localProject ? "通过并写入" : "通过并推送"}
                      </Button>
                    </div>
                  </section>
                ) : null}
                {task?.status === "READY" && canEdit ? (
                  <div className="dialog-actions">
                    <Button
                      icon={<RotateCcw size={17} />}
                      onClick={() => setConfirmAction("unconfirm")}
                      disabled={pending}
                    >
                      撤回为草稿
                    </Button>
                  </div>
                ) : null}
                {canRecover ? (
                  <div className="dialog-actions">
                    <Button
                      icon={<Pencil size={17} />}
                      onClick={() => setConfirmAction("revise")}
                      disabled={pending}
                    >
                      修改后重试
                    </Button>
                    <Button
                      type="primary"
                      icon={<RotateCcw size={17} />}
                      onClick={() => setConfirmAction("retry")}
                      disabled={pending}
                    >
                      直接重试
                    </Button>
                  </div>
                ) : null}
                {task?.status === "COMPLETED" && runDetails.data ? (
                  <section className="apply-actions">
                    <h3>
                      {researchTask ? "研究结果" : localProject ? "本地目标分支" : "远程目标分支"}
                    </h3>
                    <InlineNotice tone="success">
                      {researchTask
                        ? "本次研究总结已通过审核，项目分支未被修改。"
                        : localProject
                          ? `本次 Run 结果已写入本地分支 ${runDetails.data.run.targetBranch}。`
                          : `本次 Run 结果已推送到 ${runDetails.data.run.targetBranch}${
                              runDetails.data.run.pushedCommit
                                ? `，Commit ${runDetails.data.run.pushedCommit.slice(0, 10)}`
                                : ""
                            }。`}
                    </InlineNotice>
                    {canEdit ? (
                      <div className="dialog-actions">
                        <Button
                          type="primary"
                          icon={<Pencil size={17} />}
                          onClick={() => setConfirmAction("continue")}
                          disabled={pending}
                        >
                          {researchTask ? "继续研究" : "继续迭代"}
                        </Button>
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </div>
            </div>
          </>
        )}

        {task && (canCancel || canDelete) ? (
          <div className="task-destructive-actions">
            {canCancel ? (
              <Button
                danger
                icon={<Ban size={17} />}
                onClick={() => setConfirmAction("cancel")}
                disabled={pending}
              >
                取消执行
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                danger
                icon={<Trash2 size={17} />}
                onClick={() => setConfirmAction("delete")}
                disabled={pending || agentResolving}
              >
                删除任务
              </Button>
            ) : null}
          </div>
        ) : null}
      </Modal>

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
