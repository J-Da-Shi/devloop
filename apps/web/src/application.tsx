import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { NoticeProvider } from "./components/common/index.js";
import { router } from "./router.js";
import { antdThemes, useAppTheme } from "./theme/index.js";

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

export function Application() {
  const { theme } = useAppTheme();

  return (
    <ConfigProvider locale={zhCN} componentSize="middle" theme={antdThemes[theme]}>
      <AntdApp className="devloop-antd-app">
        <QueryClientProvider client={queryClient}>
          <NoticeProvider>
            <RouterProvider router={router} />
          </NoticeProvider>
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  );
}
