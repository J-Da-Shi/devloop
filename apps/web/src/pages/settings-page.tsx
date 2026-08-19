import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, InputNumber, Switch } from "antd";
import { workerConcurrencyMax, workerConcurrencyMin } from "@devloop/shared";
import {
  CheckCircle2,
  CircleX,
  Database,
  Gauge,
  Radio,
  Save,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryKeys, useUiStore } from "../core/index.js";
import { ErrorPanel, LoadingPanel, StatusBadge, useNotice } from "../components/common/index.js";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const dashboard = useQuery({ queryKey: queryKeys.dashboard, queryFn: api.dashboard });
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    staleTime: 60_000,
  });
  const realtimeEnabled = useUiStore((state) => state.realtimeEnabled);
  const setRealtimeEnabled = useUiStore((state) => state.setRealtimeEnabled);
  const [concurrencyLimit, setConcurrencyLimit] = useState(workerConcurrencyMin);
  const persistedConcurrencyLimit = dashboard.data?.worker.concurrencyLimit;
  useEffect(() => {
    if (persistedConcurrencyLimit !== undefined) {
      setConcurrencyLimit(persistedConcurrencyLimit);
    }
  }, [persistedConcurrencyLimit]);
  const concurrencyMutation = useMutation({
    mutationFn: (nextLimit: number) => api.setWorkerConcurrency({ concurrencyLimit: nextLimit }),
    onSuccess: async ({ worker }) => {
      setConcurrencyLimit(worker.concurrencyLimit);
      await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
      notify(`任务并发数已调整为 ${worker.concurrencyLimit}`);
    },
    onError: (error) =>
      notify(error instanceof Error ? error.message : "并发配置保存失败", "danger"),
  });
  if (dashboard.isPending || session.isPending) return <LoadingPanel label="正在加载设置" />;
  if (dashboard.isError) return <ErrorPanel error={dashboard.error} />;

  return (
    <div className="settings-grid">
      <section className="tool-panel settings-section">
        <div className="section-heading">
          <h2>连接</h2>
          <Radio size={18} />
        </div>
        <div className="setting-row">
          <span>
            <strong>实时事件</strong>
            <small>SSE 状态同步</small>
          </span>
          <Switch checked={realtimeEnabled} onChange={setRealtimeEnabled} aria-label="实时事件" />
        </div>
        <div className="setting-row">
          <span>
            <strong>服务地址</strong>
            <small>{window.location.origin}</small>
          </span>
          <StatusBadge status="RUNNING">已连接</StatusBadge>
        </div>
        <div className="setting-row">
          <span>
            <strong>当前身份</strong>
            <small>{session.data?.identity.name}</small>
          </span>
          <code>{session.data?.identity.role}</code>
        </div>
        <div className="setting-row">
          <span>
            <strong>访问模式</strong>
            <small>无 DevLoop 账户，由本机、Tailscale 或反向代理保护入口</small>
          </span>
          <StatusBadge status="COMPLETED">单用户</StatusBadge>
        </div>
      </section>
      <section className="tool-panel settings-section">
        <div className="section-heading">
          <h2>任务调度</h2>
          <Gauge size={18} />
        </div>
        <div className="setting-row">
          <span>
            <strong>任务并发数</strong>
            <small>
              {`运行中 ${dashboard.data.worker.activeRunIds.length} 个 · 范围 ${workerConcurrencyMin}-${workerConcurrencyMax}`}
            </small>
          </span>
          <div className="setting-control">
            <InputNumber
              min={workerConcurrencyMin}
              max={workerConcurrencyMax}
              precision={0}
              value={concurrencyLimit}
              onChange={(value) => value !== null && setConcurrencyLimit(value)}
              aria-label="任务并发数"
            />
            <Button
              type="primary"
              icon={<Save size={16} />}
              loading={concurrencyMutation.isPending}
              disabled={concurrencyLimit === dashboard.data.worker.concurrencyLimit}
              onClick={() => concurrencyMutation.mutate(concurrencyLimit)}
            >
              保存
            </Button>
          </div>
        </div>
      </section>
      <section className="tool-panel settings-section">
        <div className="section-heading">
          <h2>执行器</h2>
          <TerminalSquare size={18} />
        </div>
        {dashboard.data.runnerCapabilities.map((runner) => (
          <div key={runner.id} className="setting-row runner-setting">
            <span>
              {runner.available ? <CheckCircle2 size={18} /> : <CircleX size={18} />}
              <span>
                <strong>{runner.id}</strong>
                <small>{runner.version ?? runner.error ?? "不可用"}</small>
              </span>
            </span>
            <code>{runner.features.length} 项能力</code>
          </div>
        ))}
      </section>
      <section className="tool-panel settings-section">
        <div className="section-heading">
          <h2>服务器边界</h2>
          <ShieldCheck size={18} />
        </div>
        <div className="setting-row">
          <span>
            <strong>项目仓库</strong>
            <small>服务器托管目录，不向浏览器公开绝对路径</small>
          </span>
          <StatusBadge status="COMPLETED">受限</StatusBadge>
        </div>
        <div className="setting-row">
          <span>
            <strong>事实存储</strong>
            <small>服务器 SQLite WAL</small>
          </span>
          <Database size={18} />
        </div>
      </section>
    </div>
  );
}
