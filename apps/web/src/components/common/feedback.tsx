import { Alert, Empty, Spin } from "antd";

export function LoadingPanel({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="state-panel" role="status">
      <Spin size="small" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <Empty
      className="state-panel state-panel-empty"
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <span className="empty-state-copy">
          <strong>{title}</strong>
          {detail ? <small>{detail}</small> : null}
        </span>
      }
    />
  );
}

export function ErrorPanel({ error }: { error: unknown }) {
  return (
    <Alert
      className="state-panel state-panel-error"
      type="error"
      showIcon
      title={error instanceof Error ? error.message : "加载失败"}
    />
  );
}

export function InlineNotice({
  tone,
  children,
}: {
  tone: "info" | "success" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const type = tone === "danger" ? "error" : tone;
  return <Alert className={`inline-notice notice-${tone}`} type={type} showIcon title={children} />;
}
