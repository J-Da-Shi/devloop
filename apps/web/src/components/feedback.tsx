import { AlertCircle, Inbox, LoaderCircle } from "lucide-react";

export function LoadingPanel({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="state-panel" role="status">
      <LoaderCircle className="spin" size={20} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="state-panel state-panel-empty">
      <Inbox size={22} aria-hidden="true" />
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

export function ErrorPanel({ error }: { error: unknown }) {
  return (
    <div className="state-panel state-panel-error" role="alert">
      <AlertCircle size={20} aria-hidden="true" />
      <span>{error instanceof Error ? error.message : "加载失败"}</span>
    </div>
  );
}

export function InlineNotice({
  tone,
  children,
}: {
  tone: "info" | "success" | "warning" | "danger";
  children: React.ReactNode;
}) {
  return (
    <div className={`inline-notice notice-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {children}
    </div>
  );
}
