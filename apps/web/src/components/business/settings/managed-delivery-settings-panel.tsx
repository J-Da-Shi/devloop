import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Form, InputNumber } from "antd";
import { Bot, Save } from "lucide-react";
import { useEffect } from "react";
import type { ManagedDeliverySettings } from "@devloop/shared";
import { api, queryKeys } from "../../../core/index.js";
import { ErrorPanel, LoadingPanel, useNotice } from "../../common/index.js";

interface ManagedDeliverySettingsPanelProps {
  canEdit: boolean;
}

interface ManagedDeliverySettingsFormValues {
  maxTaskBudgetYuan: number;
  warningPercent: number;
  budgetOverrunPercent: number;
  autoRetryLimit: number;
  codexHourlyRateYuan: number;
  claudeHourlyRateYuan: number;
}

const toFormValues = (settings: ManagedDeliverySettings): ManagedDeliverySettingsFormValues => ({
  maxTaskBudgetYuan: settings.maxTaskBudgetCents / 100,
  warningPercent: settings.warningPercent,
  budgetOverrunPercent: settings.budgetOverrunPercent,
  autoRetryLimit: settings.autoRetryLimit,
  codexHourlyRateYuan: settings.runnerHourlyRatesCents.codex / 100,
  claudeHourlyRateYuan: settings.runnerHourlyRatesCents["claude-code"] / 100,
});

export function ManagedDeliverySettingsPanel({ canEdit }: ManagedDeliverySettingsPanelProps) {
  const [form] = Form.useForm<ManagedDeliverySettingsFormValues>();
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const settingsQuery = useQuery({
    queryKey: queryKeys.managedDeliverySettings,
    queryFn: api.managedDeliverySettings,
  });

  useEffect(() => {
    if (settingsQuery.data) form.setFieldsValue(toFormValues(settingsQuery.data.settings));
  }, [form, settingsQuery.data]);

  const mutation = useMutation({
    mutationFn: async (values: ManagedDeliverySettingsFormValues) => {
      const current = settingsQuery.data?.settings;
      if (!current) throw new Error("托管交付设置尚未加载");
      return api.updateManagedDeliverySettings({
        maxTaskBudgetCents: Math.round(values.maxTaskBudgetYuan * 100),
        warningPercent: values.warningPercent,
        budgetOverrunPercent: values.budgetOverrunPercent,
        autoRetryLimit: values.autoRetryLimit,
        runnerHourlyRatesCents: {
          codex: Math.round(values.codexHourlyRateYuan * 100),
          "claude-code": Math.round(values.claudeHourlyRateYuan * 100),
          fake: current.runnerHourlyRatesCents.fake,
        },
        expectedVersion: current.version,
      });
    },
    onSuccess: async ({ settings }) => {
      form.setFieldsValue(toFormValues(settings));
      await queryClient.invalidateQueries({ queryKey: queryKeys.managedDeliverySettings });
      notify("托管交付设置已保存");
    },
    onError: (error) =>
      notify(error instanceof Error ? error.message : "托管交付设置保存失败", "danger"),
  });

  return (
    <section className="tool-panel settings-section settings-section-wide">
      <div className="section-heading">
        <div>
          <h2>AI 托管交付</h2>
          <span>预算估算、预警、自动停止与失败恢复</span>
        </div>
        <Bot size={18} />
      </div>
      {settingsQuery.isPending ? <LoadingPanel label="正在加载托管设置" /> : null}
      {settingsQuery.isError ? <ErrorPanel error={settingsQuery.error} /> : null}
      {settingsQuery.data ? (
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          className="managed-settings-form"
          onFinish={(values) => mutation.mutate(values)}
        >
          <div className="managed-settings-grid">
            <Form.Item
              name="maxTaskBudgetYuan"
              label="单任务最高预算"
              rules={[{ required: true }, { type: "number", min: 1, max: 100_000 }]}
            >
              <InputNumber
                disabled={!canEdit}
                min={1}
                max={100_000}
                precision={2}
                addonBefore="¥"
              />
            </Form.Item>
            <Form.Item
              name="warningPercent"
              label="预算预警线"
              rules={[{ required: true }, { type: "number", min: 10, max: 99 }]}
            >
              <InputNumber disabled={!canEdit} min={10} max={99} precision={0} addonAfter="%" />
            </Form.Item>
            <Form.Item
              name="budgetOverrunPercent"
              label="估算余量"
              rules={[{ required: true }, { type: "number", min: 0, max: 500 }]}
            >
              <InputNumber disabled={!canEdit} min={0} max={500} precision={0} addonAfter="%" />
            </Form.Item>
            <Form.Item
              name="autoRetryLimit"
              label="失败自动重试"
              rules={[{ required: true }, { type: "number", min: 0, max: 10 }]}
            >
              <InputNumber disabled={!canEdit} min={0} max={10} precision={0} addonAfter="次" />
            </Form.Item>
            <Form.Item
              name="codexHourlyRateYuan"
              label="Codex 估算费率"
              rules={[{ required: true }, { type: "number", min: 0, max: 10_000 }]}
            >
              <InputNumber
                disabled={!canEdit}
                min={0}
                max={10_000}
                precision={2}
                addonBefore="¥"
                addonAfter="/小时"
              />
            </Form.Item>
            <Form.Item
              name="claudeHourlyRateYuan"
              label="Claude Code 估算费率"
              rules={[{ required: true }, { type: "number", min: 0, max: 10_000 }]}
            >
              <InputNumber
                disabled={!canEdit}
                min={0}
                max={10_000}
                precision={2}
                addonBefore="¥"
                addonAfter="/小时"
              />
            </Form.Item>
          </div>
          {canEdit ? (
            <div className="managed-settings-actions">
              <Button
                type="primary"
                htmlType="submit"
                icon={<Save size={16} />}
                loading={mutation.isPending}
              >
                保存托管设置
              </Button>
            </div>
          ) : null}
        </Form>
      ) : null}
    </section>
  );
}
