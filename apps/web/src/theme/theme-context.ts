import { createContext, useContext } from "react";
import type { AppTheme } from "../types/index.js";

export interface ThemeContextValue {
  theme: AppTheme;
  setTheme(theme: AppTheme): void;
  toggleTheme(): void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useAppTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useAppTheme 必须在 AppThemeProvider 内使用");
  }
  return value;
}
