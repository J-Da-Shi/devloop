import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

export type AppRoutePath =
  "/" | "/status" | "/board" | "/projects" | "/skills" | "/runs" | "/settings";

export type AppPagePath = Exclude<AppRoutePath, "/">;
export type AppRouteNavigation = "main" | "footer";

export interface AppRedirectRouteDefinition {
  kind: "redirect";
  path: "/";
  redirectTo: "/status";
}

export interface AppPageRouteDefinition {
  kind: "page";
  path: AppPagePath;
  title: string;
  label: string;
  icon: LucideIcon;
  component: ComponentType;
  navigation: AppRouteNavigation;
}

export type AppRouteDefinition = AppRedirectRouteDefinition | AppPageRouteDefinition;
