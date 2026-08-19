import { Activity, Clock3, Columns3, FolderGit2, History, Puzzle, Settings } from "lucide-react";
import { BoardPage } from "../pages/board-page.js";
import { ProjectsPage } from "../pages/projects-page.js";
import { RunsPage } from "../pages/runs-page.js";
import { SettingsPage } from "../pages/settings-page.js";
import { SkillsPage } from "../pages/skills-page.js";
import { StatusPage } from "../pages/status-page.js";
import type { AppRouteDefinition } from "../types/index.js";

export const routeDefinitions = [
  {
    kind: "redirect",
    path: "/",
    redirectTo: "/status",
  },
  {
    kind: "page",
    path: "/status",
    title: "执行概览",
    label: "状态",
    icon: Activity,
    component: StatusPage,
    navigation: "main",
  },
  {
    kind: "page",
    path: "/board",
    title: "任务看板",
    label: "任务",
    icon: Columns3,
    component: BoardPage,
    navigation: "main",
  },
  {
    kind: "page",
    path: "/projects",
    title: "项目",
    label: "项目",
    icon: FolderGit2,
    component: ProjectsPage,
    navigation: "main",
  },
  {
    kind: "page",
    path: "/skills",
    title: "Skill 管理",
    label: "技能",
    icon: Puzzle,
    component: SkillsPage,
    navigation: "main",
  },
  {
    kind: "page",
    path: "/runs",
    title: "执行记录",
    label: "执行",
    icon: History,
    component: RunsPage,
    navigation: "main",
  },
  {
    kind: "page",
    path: "/settings",
    title: "设置",
    label: "设置",
    icon: Settings,
    component: SettingsPage,
    navigation: "footer",
  },
] as const satisfies readonly AppRouteDefinition[];

export type RegisteredRouteDefinition = (typeof routeDefinitions)[number];
export type RegisteredPageRoute = Extract<RegisteredRouteDefinition, { kind: "page" }>;
export type RegisteredMainRoute = Extract<
  RegisteredRouteDefinition,
  { kind: "page"; navigation: "main" }
>;

export const mainNavigation = routeDefinitions.filter(
  (route): route is RegisteredMainRoute => route.kind === "page" && route.navigation === "main",
);

export const footerNavigation = routeDefinitions.filter(
  (route): route is Extract<RegisteredRouteDefinition, { kind: "page"; navigation: "footer" }> =>
    route.kind === "page" && route.navigation === "footer",
);

export const getPageTitle = (pathname: string): string =>
  routeDefinitions.find(
    (route): route is RegisteredPageRoute => route.kind === "page" && route.path === pathname,
  )?.title ?? "DevLoop";
