import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { IconButton } from "./icon-button.js";

type NoticeTone = "success" | "danger" | "info";

interface Notice {
  id: number;
  tone: NoticeTone;
  message: string;
}

interface NoticeContextValue {
  notify(message: string, tone?: NoticeTone): void;
}

const NoticeContext = createContext<NoticeContextValue | null>(null);

export function NoticeProvider({ children }: { children: React.ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(1);
  const remove = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);
  const notify = useCallback(
    (message: string, tone: NoticeTone = "success") => {
      const id = nextId.current++;
      setNotices((current) => [...current, { id, tone, message }]);
      window.setTimeout(() => remove(id), 4_500);
    },
    [remove],
  );
  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <NoticeContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {notices.map((notice) => {
          const Symbol =
            notice.tone === "success"
              ? CheckCircle2
              : notice.tone === "danger"
                ? CircleAlert
                : Info;
          return (
            <div key={notice.id} className={`toast toast-${notice.tone}`}>
              <Symbol size={18} aria-hidden="true" />
              <span>{notice.message}</span>
              <IconButton label="关闭通知" onClick={() => remove(notice.id)}>
                <X size={16} />
              </IconButton>
            </div>
          );
        })}
      </div>
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
