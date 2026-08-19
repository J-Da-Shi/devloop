import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { AppShell } from "./components/layout/index.js";
import { routeDefinitions } from "./routes/index.js";

const rootRoute = createRootRoute({ component: AppShell });
const routes = routeDefinitions.map((definition) => {
  if (definition.kind === "redirect") {
    return createRoute({
      getParentRoute: () => rootRoute,
      path: definition.path,
      beforeLoad: () => {
        throw redirect({ to: definition.redirectTo });
      },
    });
  }
  return createRoute({
    getParentRoute: () => rootRoute,
    path: definition.path,
    component: definition.component,
  });
});
const routeTree = rootRoute.addChildren(routes);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
