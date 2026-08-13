import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Clock3,
  Columns3,
  FolderGit2,
  History,
  Puzzle,
  Settings,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryKeys } from "../api.js";
import { useUiStore } from "../store.js";
import { ErrorPanel, LoadingPanel } from "./feedback.js";
import { RealtimeSync } from "./realtime-sync.js";

const navigation = [
  { to: "/status", label: "状态", icon: Activity },
  { to: "/board", label: "任务", icon: Columns3 },
  { to: "/projects", label: "项目", icon: FolderGit2 },
  { to: "/skills", label: "技能", icon: Puzzle },
  { to: "/runs", label: "执行", icon: History },
] as const;

const pageTitle: Record<string, string> = {
  "/status": "执行概览",
  "/board": "任务看板",
  "/projects": "项目",
  "/skills": "Skill 管理",
  "/runs": "执行记录",
  "/settings": "设置",
};

function SystemClock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="system-clock">
      <Clock3 size={14} aria-hidden="true" />
      {new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(time)}
    </span>
  );
}

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const realtimeStatus = useUiStore((state) => state.realtimeStatus);
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    retry: false,
    staleTime: 60_000,
  });

  if (session.isPending) {
    return <LoadingPanel label="正在连接 DevLoop 服务器" />;
  }
  if (session.isError) {
    return <ErrorPanel error={session.error} />;
  }

  const connected = realtimeStatus === "connected";
  return (
    <div className="app-shell">
      <RealtimeSync />
      <aside className="sidebar">
        <Link to="/status" className="brand-link" aria-label="DevLoop 执行概览">
          <img src="/devloop-mark.svg" alt="" width="32" height="32" />
          <span>
            <strong>DevLoop</strong>
            <small>个人开发执行工作台</small>
          </span>
        </Link>
        <nav className="sidebar-nav" aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className="nav-link"
                activeProps={{ className: "nav-link active" }}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <Link to="/settings" className="nav-link" activeProps={{ className: "nav-link active" }}>
            <Settings size={18} aria-hidden="true" />
            <span>设置</span>
          </Link>
          <div className="identity-row">
            <span className="identity-avatar">{session.data.identity.name.slice(0, 1)}</span>
            <span>
              <strong>{session.data.identity.name}</strong>
              <small>单用户实例 · {session.data.identity.role}</small>
            </span>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="mobile-brand">
            <img src="/devloop-mark.svg" alt="" width="28" height="28" />
            <strong>DevLoop</strong>
          </div>
          <div className="topbar-title">
            <h1>{pageTitle[pathname] ?? "DevLoop"}</h1>
          </div>
          <div className="topbar-actions">
            <SystemClock />
            <span
              className={`connection-state ${connected ? "online" : "offline"}`}
              aria-live="polite"
            >
              {connected ? <Wifi size={15} /> : <WifiOff size={15} />}
              <span>
                {connected ? "实时" : realtimeStatus === "disabled" ? "已关闭实时" : "重连中"}
              </span>
            </span>
            <Link to="/settings" className="icon-button" aria-label="设置">
              <Settings size={18} />
            </Link>
          </div>
        </header>
        <main className="page-content">
          <Outlet />
        </main>
      </div>

      <nav
        className="mobile-nav"
        aria-label="手机主导航"
        style={{ "--mobile-nav-count": navigation.length } as React.CSSProperties}
      >
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className="mobile-nav-link"
              activeProps={{ className: "mobile-nav-link active" }}
            >
              <Icon size={20} aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
