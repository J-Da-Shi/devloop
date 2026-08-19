import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Avatar, Button, Tag, Tooltip } from "antd";
import { Clock3, Settings, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryKeys, useUiStore } from "../../core/index.js";
import { footerNavigation, getPageTitle, mainNavigation } from "../../routes/index.js";
import { ErrorPanel, LoadingPanel } from "../common/index.js";
import { RealtimeSync } from "./realtime-sync.js";

function SystemClock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <Tag className="system-clock" icon={<Clock3 size={14} aria-hidden="true" />}>
      {new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(time)}
    </Tag>
  );
}

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pageContentRef = useRef<HTMLElement>(null);
  const realtimeStatus = useUiStore((state) => state.realtimeStatus);
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (pageContentRef.current) {
      pageContentRef.current.scrollTop = 0;
    }
  }, [pathname]);

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
          {mainNavigation.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
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
          {footerNavigation.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                className="nav-link"
                activeProps={{ className: "nav-link active" }}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
          <div className="identity-row">
            <Avatar className="identity-avatar" shape="square" size={32}>
              {session.data.identity.name.slice(0, 1)}
            </Avatar>
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
            <h1>{getPageTitle(pathname)}</h1>
          </div>
          <div className="topbar-actions">
            <SystemClock />
            <Tag
              variant="filled"
              icon={connected ? <Wifi size={15} /> : <WifiOff size={15} />}
              className={`connection-state ${connected ? "online" : "offline"}`}
              aria-live="polite"
            >
              {connected ? "实时" : realtimeStatus === "disabled" ? "已关闭实时" : "重连中"}
            </Tag>
            <Link to={footerNavigation[0]?.path ?? "/settings"} aria-label="设置">
              <Tooltip title="设置">
                <Button
                  type="text"
                  shape="circle"
                  className="icon-button"
                  icon={<Settings size={18} />}
                  aria-label="设置"
                />
              </Tooltip>
            </Link>
          </div>
        </header>
        <main ref={pageContentRef} className="page-content">
          <Outlet />
        </main>
      </div>

      <nav
        className="mobile-nav"
        aria-label="手机主导航"
        style={{ "--mobile-nav-count": mainNavigation.length } as React.CSSProperties}
      >
        {mainNavigation.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.path}
              to={item.path}
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
