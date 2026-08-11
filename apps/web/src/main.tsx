import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as Tooltip from "@radix-ui/react-tooltip";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NoticeProvider } from "./components/notice-provider.js";
import { router } from "./router.js";
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
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={350}>
        <NoticeProvider>
          <RouterProvider router={router} />
        </NoticeProvider>
      </Tooltip.Provider>
    </QueryClientProvider>
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
