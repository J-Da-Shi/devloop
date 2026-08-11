import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { AppShell } from "./components/app-shell.js";
import { BoardPage } from "./pages/board-page.js";
import { DevicesPage } from "./pages/devices-page.js";
import { PairPage } from "./pages/pair-page.js";
import { ProjectsPage } from "./pages/projects-page.js";
import { RunsPage } from "./pages/runs-page.js";
import { SettingsPage } from "./pages/settings-page.js";
import { StatusPage } from "./pages/status-page.js";

function RootComponent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return pathname === "/pair" ? <Outlet /> : <AppShell />;
}

const rootRoute = createRootRoute({ component: RootComponent });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/status" });
  },
});
const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/status",
  component: StatusPage,
});
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/board",
  component: BoardPage,
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
});
const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  component: RunsPage,
});
const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices",
  component: DevicesPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});
const pairRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pair",
  component: PairPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  statusRoute,
  boardRoute,
  projectsRoute,
  runsRoute,
  devicesRoute,
  settingsRoute,
  pairRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
