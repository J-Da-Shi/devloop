import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@devloop/shared": fromRoot("./packages/shared/src/index.ts"),
      "@devloop/db": fromRoot("./packages/db/src/index.ts"),
      "@devloop/workflow": fromRoot("./packages/workflow/src/index.ts"),
      "@devloop/git": fromRoot("./packages/git/src/index.ts"),
      "@devloop/runners": fromRoot("./packages/runners/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
