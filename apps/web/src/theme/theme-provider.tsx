import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";
import type { AppTheme } from "../types/index.js";
import { ThemeContext, type ThemeContextValue } from "./theme-context.js";

const themeStorageKey = "devloop:theme";

const isAppTheme = (value: string | null): value is AppTheme =>
  value === "dark" || value === "light";

const readInitialTheme = (): AppTheme => {
  try {
    const storedTheme = window.localStorage.getItem(themeStorageKey);
    return isAppTheme(storedTheme) ? storedTheme : "dark";
  } catch {
    return "dark";
  }
};

const initialTheme = typeof window === "undefined" ? "dark" : readInitialTheme();

const applyTheme = (theme: AppTheme): void => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#07090d" : "#f3f6f9");
};

if (typeof document !== "undefined") {
  applyTheme(initialTheme);
}

export function AppThemeProvider({ children }: PropsWithChildren) {
  const [theme, setTheme] = useState<AppTheme>(initialTheme);

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // 浏览器禁用本地存储时，主题在当前会话内仍然可用。
    }
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark")),
    }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
