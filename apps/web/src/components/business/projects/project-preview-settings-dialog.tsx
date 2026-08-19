import { Form, Input, Modal, Switch } from "antd";
import { useEffect } from "react";
import type { Project } from "@devloop/shared";
import type { PreviewFormValues } from "./types.js";

interface ProjectPreviewSettingsDialogProps {
  project: Project | null;
  saving: boolean;
  onClose(): void;
  onSave(project: Project, values: PreviewFormValues): void;
}

export function ProjectPreviewSettingsDialog({
  project,
  saving,
  onClose,
  onSave,
}: ProjectPreviewSettingsDialogProps) {
  const [form] = Form.useForm<PreviewFormValues>();
  const previewCommand = Form.useWatch("previewCommand", form) ?? "";

  useEffect(() => {
    if (!project) return;
    form.setFieldsValue({
      previewCommand: project.previewCommand ?? "",
      previewWorkingDirectory: project.previewWorkingDirectory,
      previewHealthPath: project.previewHealthPath,
      playwrightEnabled: project.playwrightEnabled,
      playwrightTestCommand: project.playwrightTestCommand ?? "",
    });
  }, [form, project]);

  return (
    <Modal
      open={Boolean(project)}
      title={
        <span className="task-dialog-title">
          <strong>预览与自动验证</strong>
          <small>{project?.name}</small>
        </span>
      }
      okText="保存配置"
      cancelText="取消"
      confirmLoading={saving}
      mask={{ closable: !saving }}
      closable={!saving}
      onCancel={() => !saving && onClose()}
      onOk={() => form.submit()}
    >
      <Form<PreviewFormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => project && onSave(project, values)}
      >
        <Form.Item
          label="Web 预览启动命令（高级覆盖，可选）"
          name="previewCommand"
          extra="默认由 Agent 和项目脚本自动识别。仅在识别错误时填写；依赖会按锁文件自动安装，命令只应启动 Web 服务并使用 {{port}}。"
        >
          <Input.TextArea
            rows={2}
            placeholder="npm run dev -- --host 127.0.0.1 --port {{port}}"
            spellCheck={false}
          />
        </Form.Item>
        {previewCommand.trim() ? (
          <div className="form-grid">
            <Form.Item
              label="工作目录"
              name="previewWorkingDirectory"
              rules={[{ required: true, message: "请输入工作目录" }]}
            >
              <Input placeholder="." spellCheck={false} />
            </Form.Item>
            <Form.Item
              label="健康检查路径"
              name="previewHealthPath"
              rules={[
                { required: true, message: "请输入健康检查路径" },
                { pattern: /^\/(?!\/)/, message: "请输入以 / 开头的站内路径" },
              ]}
            >
              <Input placeholder="/" spellCheck={false} />
            </Form.Item>
          </div>
        ) : null}
        <Form.Item
          label="任务完成后自动运行 Playwright"
          name="playwrightEnabled"
          valuePropName="checked"
        >
          <Switch checkedChildren="开启" unCheckedChildren="关闭" />
        </Form.Item>
        <Form.Item label="自定义交互测试命令" name="playwrightTestCommand">
          <Input.TextArea rows={2} placeholder="pnpm playwright test" spellCheck={false} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
