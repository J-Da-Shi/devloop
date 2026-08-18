import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NoticeProvider } from "./components/notice-provider.js";
import { router } from "./router.js";
import "antd/dist/reset.css";
import "./styles.css";

const desktopApi = window.devloopDesktop;
if (desktopApi) {
  const rootElement = document.documentElement;
  const updateFullScreenState = (isFullScreen: boolean): void => {
    rootElement.classList.toggle("desktop-full-screen", isFullScreen);
  };

  rootElement.classList.add("desktop-client");
  if (desktopApi.platform === "darwin") {
    rootElement.classList.add("desktop-macos");
    desktopApi.onFullScreenChange(updateFullScreenState);
    void desktopApi.isFullScreen().then(updateFullScreenState);
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: (failureCount, error) =>
        !(error instanceof Error && "status" in error && error.status === 401) && failureCount < 2,
    },
    mutations: { retry: false },
  },
});

const root = document.getElementById("root");
if (!root) {
  throw new Error("找不到应用挂载节点");
}

createRoot(root).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      componentSize="middle"
      theme={{
        token: {
          colorPrimary: "#111827",
          colorInfo: "#2563eb",
          colorSuccess: "#16a34a",
          colorWarning: "#d97706",
          colorError: "#dc2626",
          colorText: "#111827",
          colorTextSecondary: "#6b7280",
          colorBorder: "#d1d5db",
          colorBorderSecondary: "#e5e7eb",
          colorBgLayout: "#f9fafb",
          colorBgContainer: "#ffffff",
          borderRadius: 6,
          borderRadiusLG: 8,
          controlHeight: 40,
          controlHeightSM: 32,
          controlHeightLG: 44,
          fontFamily:
            'Inter, "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: 13,
        },
        components: {
          Button: { fontWeight: 650 },
          Card: { bodyPadding: 16, headerHeight: 48 },
          Form: { itemMarginBottom: 14, labelColor: "#4b5563" },
          Modal: { titleFontSize: 18 },
        },
      }}
    >
      <AntdApp className="devloop-antd-app">
        <QueryClientProvider client={queryClient}>
          <NoticeProvider>
            <RouterProvider router={router} />
          </NoticeProvider>
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
);

// Service Worker 曾经被用来做离线缓存，但打包升级后 SW 里的旧 index.html 会引用
// 已消失的 asset hash，让页面白屏。桌面版本身在本机运行、不需要离线兜底，因此主动
// 注销任何遗留的 SW 并清空其缓存，避免旧版本的用户升级后卡住。
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
      await Promise.all(registrations.map((registration) => registration.unregister()));
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    });
  });
}
