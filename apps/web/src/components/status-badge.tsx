import { statusTone } from "../utils.js";

interface StatusBadgeProps {
  status: string;
  children: React.ReactNode;
  pulse?: boolean;
}

export function StatusBadge({ status, children, pulse = false }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-${statusTone(status)}`}>
      <span className={`status-dot${pulse ? " status-dot-pulse" : ""}`} aria-hidden="true" />
      {children}
    </span>
  );
}
