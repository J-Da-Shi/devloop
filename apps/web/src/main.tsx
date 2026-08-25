import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Application } from "./application.js";
import { AppThemeProvider } from "./theme/index.js";
import "antd/dist/reset.css";
import "./styles.css";
import "./styles/index.scss";

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

const root = document.getElementById("root");
if (!root) {
  throw new Error("找不到应用挂载节点");
}

createRoot(root).render(
  <StrictMode>
    <AppThemeProvider>
      <Application />
    </AppThemeProvider>
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
