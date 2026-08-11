import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/db/src/schema.ts",
  out: "./packages/db/drizzle",
  dbCredentials: {
    url: "./.devloop-data/devloop.db",
  },
  strict: true,
  verbose: true,
});
