import { Button, Form, Input, InputNumber, Select, Switch } from "antd";
import { Play, Save } from "lucide-react";
import type { Project, Task } from "@devloop/shared";
import type { UseFormReturn } from "react-hook-form";
import { Controller } from "react-hook-form";
import type { TaskFormValues } from "./task-form.js";
import { taskTypeOptions } from "./task-form.js";

interface TaskEditorFormProps {
  form: UseFormReturn<TaskFormValues>;
  projects: Project[];
  task: Task | null;
  canEdit: boolean;
  selectedTaskType: TaskFormValues["taskType"];
  pending: boolean;
  saving: boolean;
  onSubmit(): void;
  onConfirm(): void;
}

export function TaskEditorForm({
  form,
  projects,
  task,
  canEdit,
  selectedTaskType,
  pending,
  saving,
  onSubmit,
  onConfirm,
}: TaskEditorFormProps) {
  return (
    <div className="task-dialog-scroll-region">
      <Form className="form-stack" layout="vertical" requiredMark={false} onFinish={onSubmit}>
        <Form.Item label="任务类型" htmlFor="task-type" required>
          <Controller
            control={form.control}
            name="taskType"
            render={({ field }) => (
              <Select {...field} id="task-type" disabled={!canEdit} options={taskTypeOptions} />
            )}
          />
        </Form.Item>
        <Form.Item
          label="项目"
          required
          validateStatus={form.formState.errors.projectId ? "error" : ""}
          help={form.formState.errors.projectId?.message}
        >
          <Controller
            control={form.control}
            name="projectId"
            render={({ field }) => (
              <Select
                {...field}
                disabled={Boolean(task) || !canEdit}
                placeholder="选择项目"
                options={projects.map((project) => ({
                  label: `${project.name}${project.repositoryUrl === null ? "（本地）" : ""}`,
                  value: project.id,
                }))}
                onChange={(value) => {
                  field.onChange(value);
                  const project = projects.find((item) => item.id === value);
                  form.setValue("targetBranch", project?.defaultBaseRef ?? "HEAD", {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                }}
              />
            )}
          />
        </Form.Item>
        {selectedTaskType === "DEVELOPMENT" ? (
          <Form.Item
            label="目标分支"
            required
            validateStatus={form.formState.errors.targetBranch ? "error" : ""}
            help={form.formState.errors.targetBranch?.message}
          >
            <Controller
              control={form.control}
              name="targetBranch"
              render={({ field }) => (
                <Input {...field} disabled={!canEdit} placeholder="例如 feature/mobile-editor" />
              )}
            />
          </Form.Item>
        ) : null}
        <Form.Item
          label="标题"
          required
          validateStatus={form.formState.errors.title ? "error" : ""}
          help={form.formState.errors.title?.message}
        >
          <Controller
            control={form.control}
            name="title"
            render={({ field }) => <Input {...field} disabled={!canEdit} autoFocus={!task} />}
          />
        </Form.Item>
        <Form.Item
          label="任务目标"
          required
          validateStatus={form.formState.errors.goal ? "error" : ""}
          help={form.formState.errors.goal?.message}
        >
          <Controller
            control={form.control}
            name="goal"
            render={({ field }) => <Input.TextArea {...field} disabled={!canEdit} rows={5} />}
          />
        </Form.Item>
        <Form.Item
          label="验收标准"
          required
          validateStatus={form.formState.errors.criteriaText ? "error" : ""}
          help={form.formState.errors.criteriaText?.message}
        >
          <Controller
            control={form.control}
            name="criteriaText"
            render={({ field }) => (
              <Input.TextArea {...field} disabled={!canEdit} rows={5} placeholder="每行一条" />
            )}
          />
        </Form.Item>
        <Form.Item label="分数" className="field-compact">
          <Controller
            control={form.control}
            name="priority"
            render={({ field }) => (
              <InputNumber
                ref={field.ref}
                name={field.name}
                value={field.value}
                disabled={!canEdit}
                min={0}
                max={100}
                onBlur={field.onBlur}
                onChange={(value) => field.onChange(value ?? 0)}
              />
            )}
          />
        </Form.Item>
        {selectedTaskType === "DEVELOPMENT" ? (
          <Form.Item
            label="自动解决冲突"
            htmlFor="task-auto-resolve-conflicts"
            tooltip="Codex 完成开发后会检查目标分支；存在冲突时先自动解决，再进入待审核。"
            className="field-compact"
          >
            <Controller
              control={form.control}
              name="autoResolveConflicts"
              render={({ field }) => (
                <Switch
                  id="task-auto-resolve-conflicts"
                  checked={field.value}
                  disabled={!canEdit}
                  checkedChildren="开启"
                  unCheckedChildren="关闭"
                  onChange={field.onChange}
                />
              )}
            />
          </Form.Item>
        ) : null}
        <div className="dialog-actions">
          {task && canEdit ? (
            <Button
              icon={<Play size={17} />}
              onClick={onConfirm}
              disabled={pending || form.formState.isDirty}
            >
              确认并排队
            </Button>
          ) : null}
          {canEdit ? (
            <Button
              type="primary"
              htmlType="submit"
              icon={<Save size={17} />}
              loading={saving}
              disabled={pending && !saving}
            >
              {task ? "保存草稿" : "创建草稿"}
            </Button>
          ) : null}
        </div>
      </Form>
    </div>
  );
}
