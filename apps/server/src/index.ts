import { DevLoopRepository, openDatabase } from "@devloop/db";
import { GitService } from "@devloop/git";
import { CodexRunner, FakeRunner } from "@devloop/runners";
import { AgentWorker } from "./agent-worker.js";
import { createApp } from "./app.js";
import { DomainEventBus } from "./event-bus.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { SkillService } from "./skill-service.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const database = openDatabase({
    filePath: config.databasePath,
    migrationsFolder: config.migrationsFolder,
  });
  const repository = new DevLoopRepository(database);
  const gitService = new GitService();
  const skillService = new SkillService(repository, config.skillsPath);
  const eventBus = new DomainEventBus();
  const fakeRunner = new FakeRunner(config.fakeRunnerDelayMs);
  const codexRunner = new CodexRunner({
    executable: config.codexExecutable,
    enabled: true,
    ignoreUserConfig: config.codexIgnoreUserConfig,
    timeoutMs: config.codexTimeoutMs,
  });
  const runner = config.runner === "codex" ? codexRunner : fakeRunner;
  const runnerCapabilities = await runner.detectCapabilities();
  const runners = config.runner === "codex" ? [codexRunner, fakeRunner] : [fakeRunner, codexRunner];
  const worker = new AgentWorker(repository, runner, eventBus, config.outputSchemaPath, {
    claimDelayMs: config.agentClaimDelayMs,
    available: runnerCapabilities.available,
    runnerVersion: runnerCapabilities.version,
    gitService,
    worktreesPath: config.worktreesPath,
  });

  const app = await createApp({
    config,
    repository,
    gitService,
    skillService,
    runners,
    eventBus,
    worker,
  });

  app.addHook("onClose", async () => {
    await worker.stop();
    database.close();
  });

  await app.listen({ host: config.host, port: config.port });
  worker.start();

  const close = () => void app.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
