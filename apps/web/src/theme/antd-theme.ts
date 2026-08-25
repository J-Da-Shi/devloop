import { theme as antdTheme, type ThemeConfig } from "antd";
import type { AppTheme } from "../types/index.js";

const sharedComponents: ThemeConfig["components"] = {
  Button: {
    fontWeight: 650,
    primaryShadow: "none",
    dangerShadow: "none",
  },
  Card: {
    bodyPadding: 16,
    headerHeight: 48,
  },
  Form: {
    itemMarginBottom: 14,
  },
  Modal: {
    titleFontSize: 18,
  },
};

const sharedTokens: ThemeConfig["token"] = {
  borderRadius: 6,
  borderRadiusLG: 8,
  controlHeight: 40,
  controlHeightSM: 32,
  controlHeightLG: 44,
  fontFamily: 'Inter, "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: 13,
};

export const antdThemes: Record<AppTheme, ThemeConfig> = {
  dark: {
    algorithm: antdTheme.darkAlgorithm,
    token: {
      ...sharedTokens,
      colorBgBase: "#07090d",
      colorBgLayout: "#07090d",
      colorBgContainer: "#121820",
      colorBgElevated: "#18202a",
      colorBgSpotlight: "#202a35",
      colorText: "#ffffff",
      colorTextSecondary: "#cbd5e1",
      colorTextTertiary: "#94a3b8",
      colorTextQuaternary: "#69737e",
      colorBorder: "#3b4856",
      colorBorderSecondary: "#28313a",
      colorPrimary: "#2563eb",
      colorPrimaryHover: "#3b82f6",
      colorPrimaryActive: "#1d4ed8",
      colorInfo: "#38bdf8",
      colorSuccess: "#34d399",
      colorWarning: "#f5b942",
      colorError: "#dc2626",
      controlOutline: "rgba(56, 189, 248, 0.38)",
    },
    components: {
      ...sharedComponents,
      Button: {
        ...sharedComponents?.Button,
        defaultBg: "#293442",
        defaultColor: "#ffffff",
        defaultBorderColor: "#3b4856",
        defaultHoverBg: "#354355",
        defaultHoverColor: "#ffffff",
        defaultHoverBorderColor: "#64748b",
      },
      Form: {
        ...sharedComponents?.Form,
        labelColor: "#f8fafc",
      },
    },
  },
  light: {
    algorithm: antdTheme.defaultAlgorithm,
    token: {
      ...sharedTokens,
      colorBgBase: "#ffffff",
      colorBgLayout: "#f3f6f9",
      colorBgContainer: "#ffffff",
      colorBgElevated: "#ffffff",
      colorBgSpotlight: "#111827",
      colorText: "#111827",
      colorTextSecondary: "#4b5563",
      colorTextTertiary: "#6b7280",
      colorTextQuaternary: "#9ca3af",
      colorBorder: "#d1d5db",
      colorBorderSecondary: "#e5e7eb",
      colorPrimary: "#1d4ed8",
      colorPrimaryHover: "#2563eb",
      colorPrimaryActive: "#1e40af",
      colorInfo: "#0369a1",
      colorSuccess: "#047857",
      colorWarning: "#9a5a00",
      colorError: "#c93434",
      controlOutline: "rgba(37, 99, 235, 0.22)",
    },
    components: {
      ...sharedComponents,
      Form: {
        ...sharedComponents?.Form,
        labelColor: "#374151",
      },
    },
  },
};
