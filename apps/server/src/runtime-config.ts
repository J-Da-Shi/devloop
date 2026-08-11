import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface RuntimeConfig {
  repositoryRoot: string;
  host: string;
  port: number;
  databasePath: string;
  worktreesPath: string;
  migrationsFolder: string;
  webDistPath: string;
  outputSchemaPath: string;
  externalBaseUrl: string | null;
  seed: boolean;
  logLevel: string;
  runner: "codex" | "fake";
  codexExecutable: string;
  codexIgnoreUserConfig: boolean;
  codexTimeoutMs: number;
  agentClaimDelayMs: number;
  fakeRunnerDelayMs: number;
}

const parseInteger = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }
  return value === "true" || value === "1";
};

const parseRunner = (value: string | undefined): RuntimeConfig["runner"] => {
  const runner = value ?? "codex";
  if (runner !== "codex" && runner !== "fake") {
    throw new Error("DEVLOOP_RUNNER 只能是 codex 或 fake");
  }
  return runner;
};

export function loadRuntimeConfig(): RuntimeConfig {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const host = process.env.DEVLOOP_HOST ?? "127.0.0.1";
  const allowLan = parseBoolean(process.env.DEVLOOP_ALLOW_LAN, false);
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !allowLan) {
    throw new Error("Non-loopback binding requires DEVLOOP_ALLOW_LAN=true");
  }

  const dataDirectory = resolve(repositoryRoot, process.env.DEVLOOP_DATA_DIR ?? ".devloop-data");

  return {
    repositoryRoot,
    host,
    port: parseInteger(process.env.DEVLOOP_PORT, 4317, "DEVLOOP_PORT"),
    databasePath: resolve(dataDirectory, "devloop.db"),
    worktreesPath: resolve(dataDirectory, "worktrees"),
    migrationsFolder: resolve(repositoryRoot, "packages/db/drizzle"),
    webDistPath: resolve(repositoryRoot, "apps/web/dist"),
    outputSchemaPath: resolve(repositoryRoot, "schemas/agent-result.v1.schema.json"),
    externalBaseUrl: process.env.DEVLOOP_EXTERNAL_URL ?? null,
    seed: parseBoolean(process.env.DEVLOOP_SEED, false),
    logLevel: process.env.DEVLOOP_LOG_LEVEL ?? "info",
    runner: parseRunner(process.env.DEVLOOP_RUNNER),
    codexExecutable: process.env.DEVLOOP_CODEX_EXECUTABLE ?? "codex",
    codexIgnoreUserConfig: parseBoolean(process.env.DEVLOOP_CODEX_IGNORE_USER_CONFIG, false),
    codexTimeoutMs: parseInteger(
      process.env.DEVLOOP_CODEX_TIMEOUT_MS,
      30 * 60 * 1_000,
      "DEVLOOP_CODEX_TIMEOUT_MS",
    ),
    agentClaimDelayMs: parseInteger(
      process.env.DEVLOOP_AGENT_CLAIM_DELAY_MS,
      5_000,
      "DEVLOOP_AGENT_CLAIM_DELAY_MS",
    ),
    fakeRunnerDelayMs: parseInteger(
      process.env.DEVLOOP_FAKE_RUNNER_DELAY_MS,
      850,
      "DEVLOOP_FAKE_RUNNER_DELAY_MS",
    ),
  };
}
