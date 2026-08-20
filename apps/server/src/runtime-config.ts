import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface RuntimeConfig {
  repositoryRoot: string;
  host: string;
  port: number;
  databasePath: string;
  repositoriesPath: string;
  worktreesPath: string;
  previewsPath: string;
  artifactsPath: string;
  skillsPath: string;
  migrationsFolder: string;
  webDistPath: string;
  outputSchemaPath: string;
  logLevel: string;
  runner: "codex" | "fake";
  codexExecutable: string;
  codexIgnoreUserConfig: boolean;
  codexStallTimeoutMs: number;
  claudeCodeExecutable: string;
  claudeCodeStallTimeoutMs: number;
  agentClaimDelayMs: number;
  fakeRunnerDelayMs: number;
  previewStartupTimeoutMs: number;
  previewDependencyInstallTimeoutMs: number;
  playwrightTimeoutMs: number;
  playwrightTestTimeoutMs: number;
  playwrightExecutable: string | null;
  context: {
    budgetTokens: {
      codex: number;
      "claude-code": number;
      fake: number;
    };
    compressor: {
      endpoint: string | null;
      apiKey: string | null;
      model: string;
      maxCallsPerRun: number;
    };
  };
}

const parseInteger = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
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
  const repositoryRoot = resolve(
    process.env.DEVLOOP_REPOSITORY_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const host = process.env.DEVLOOP_HOST ?? "127.0.0.1";
  const allowLan = parseBoolean(process.env.DEVLOOP_ALLOW_LAN, false);
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !allowLan) {
    throw new Error("监听非回环地址时必须设置 DEVLOOP_ALLOW_LAN=true");
  }

  const dataDirectory = resolve(repositoryRoot, process.env.DEVLOOP_DATA_DIR ?? ".devloop-data");
  return {
    repositoryRoot,
    host,
    port: parseInteger(process.env.DEVLOOP_PORT, 4317, "DEVLOOP_PORT"),
    databasePath: resolve(dataDirectory, "devloop.db"),
    repositoriesPath: resolve(dataDirectory, "repositories"),
    worktreesPath: resolve(dataDirectory, "worktrees"),
    previewsPath: resolve(dataDirectory, "previews"),
    artifactsPath: resolve(dataDirectory, "artifacts"),
    skillsPath: resolve(dataDirectory, "skills"),
    migrationsFolder: resolve(repositoryRoot, "packages/db/drizzle"),
    webDistPath: resolve(repositoryRoot, "apps/web/dist"),
    outputSchemaPath: resolve(repositoryRoot, "schemas/agent-result.v1.schema.json"),
    logLevel: process.env.DEVLOOP_LOG_LEVEL ?? "info",
    runner: parseRunner(process.env.DEVLOOP_RUNNER),
    codexExecutable: process.env.DEVLOOP_CODEX_EXECUTABLE ?? "codex",
    codexIgnoreUserConfig: parseBoolean(process.env.DEVLOOP_CODEX_IGNORE_USER_CONFIG, false),
    codexStallTimeoutMs: parseInteger(
      process.env.DEVLOOP_CODEX_STALL_TIMEOUT_MS ?? process.env.DEVLOOP_CODEX_TIMEOUT_MS,
      30 * 60 * 1_000,
      "DEVLOOP_CODEX_STALL_TIMEOUT_MS",
    ),
    claudeCodeExecutable: process.env.DEVLOOP_CLAUDE_CODE_EXECUTABLE ?? "claude",
    claudeCodeStallTimeoutMs: parseInteger(
      process.env.DEVLOOP_CLAUDE_CODE_STALL_TIMEOUT_MS,
      30 * 60 * 1_000,
      "DEVLOOP_CLAUDE_CODE_STALL_TIMEOUT_MS",
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
    previewStartupTimeoutMs: parseInteger(
      process.env.DEVLOOP_PREVIEW_STARTUP_TIMEOUT_MS,
      90_000,
      "DEVLOOP_PREVIEW_STARTUP_TIMEOUT_MS",
    ),
    previewDependencyInstallTimeoutMs: parseInteger(
      process.env.DEVLOOP_PREVIEW_DEPENDENCY_INSTALL_TIMEOUT_MS,
      10 * 60_000,
      "DEVLOOP_PREVIEW_DEPENDENCY_INSTALL_TIMEOUT_MS",
    ),
    playwrightTimeoutMs: parseInteger(
      process.env.DEVLOOP_PLAYWRIGHT_TIMEOUT_MS,
      60_000,
      "DEVLOOP_PLAYWRIGHT_TIMEOUT_MS",
    ),
    playwrightTestTimeoutMs: parseInteger(
      process.env.DEVLOOP_PLAYWRIGHT_TEST_TIMEOUT_MS,
      10 * 60_000,
      "DEVLOOP_PLAYWRIGHT_TEST_TIMEOUT_MS",
    ),
    playwrightExecutable: process.env.DEVLOOP_PLAYWRIGHT_EXECUTABLE?.trim() || null,
    context: {
      budgetTokens: {
        codex: parseInteger(
          process.env.DEVLOOP_CONTEXT_BUDGET_CODEX,
          60_000,
          "DEVLOOP_CONTEXT_BUDGET_CODEX",
        ),
        "claude-code": parseInteger(
          process.env.DEVLOOP_CONTEXT_BUDGET_CLAUDE_CODE,
          100_000,
          "DEVLOOP_CONTEXT_BUDGET_CLAUDE_CODE",
        ),
        fake: parseInteger(
          process.env.DEVLOOP_CONTEXT_BUDGET_FAKE,
          20_000,
          "DEVLOOP_CONTEXT_BUDGET_FAKE",
        ),
      },
      compressor: {
        endpoint: process.env.DEVLOOP_CONTEXT_COMPRESSOR_ENDPOINT?.trim() || null,
        apiKey: process.env.DEVLOOP_CONTEXT_COMPRESSOR_API_KEY?.trim() || null,
        model: process.env.DEVLOOP_CONTEXT_COMPRESSOR_MODEL?.trim() || "gpt-4o-mini",
        maxCallsPerRun: parseInteger(
          process.env.DEVLOOP_CONTEXT_COMPRESSOR_MAX_CALLS,
          3,
          "DEVLOOP_CONTEXT_COMPRESSOR_MAX_CALLS",
        ),
      },
    },
  };
}
