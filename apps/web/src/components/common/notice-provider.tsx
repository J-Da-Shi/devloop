import { message as antdMessage } from "antd";
import { createContext, useCallback, useContext, useMemo } from "react";

type NoticeTone = "success" | "danger" | "info";

interface NoticeContextValue {
  notify(message: string, tone?: NoticeTone): void;
}

const NoticeContext = createContext<NoticeContextValue | null>(null);

export function NoticeProvider({ children }: { children: React.ReactNode }) {
  const [messageApi, contextHolder] = antdMessage.useMessage();
  const notify = useCallback(
    (content: string, tone: NoticeTone = "success") => {
      void messageApi.open({
        type: tone === "danger" ? "error" : tone,
        content,
        duration: 4.5,
      });
    },
    [messageApi],
  );
  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <NoticeContext.Provider value={value}>
      {contextHolder}
      {children}
    </NoticeContext.Provider>
  );
}

export function useNotice(): NoticeContextValue {
  const context = useContext(NoticeContext);
  if (!context) {
    throw new Error("useNotice 必须在 NoticeProvider 内使用");
  }
  return context;
}
