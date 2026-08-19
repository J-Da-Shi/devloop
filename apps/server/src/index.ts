import { DevLoopRepository, openDatabase } from "@devloop/db";
import { GitService } from "@devloop/git";
import { ClaudeCodeRunner, CodexRunner, FakeRunner, type AgentRunner } from "@devloop/runners";
import { AgentWorker } from "./agent-worker.js";
import { createApp } from "./app.js";
import { DomainEventBus } from "./event-bus.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { SkillService } from "./skill-service.js";
import { ArtifactService } from "./artifact-service.js";
import { PlaywrightValidationService } from "./playwright-validation-service.js";
import { PreviewService } from "./preview-service.js";

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
  const artifactService = new ArtifactService(repository, config.artifactsPath);
  const previewService = new PreviewService(
    gitService,
    config.previewsPath,
    config.previewStartupTimeoutMs,
    config.previewDependencyInstallTimeoutMs,
  );
  const playwrightValidationService = new PlaywrightValidationService(
    previewService,
    artifactService,
    config.playwrightExecutable,
    config.playwrightTimeoutMs,
    config.playwrightTestTimeoutMs,
  );
  const fakeRunner = new FakeRunner(config.fakeRunnerDelayMs);
  const codexRunner = new CodexRunner({
    executable: config.codexExecutable,
    enabled: true,
    ignoreUserConfig: config.codexIgnoreUserConfig,
    stallTimeoutMs: config.codexStallTimeoutMs,
  });
  const claudeCodeRunner = new ClaudeCodeRunner({
    executable: config.claudeCodeExecutable,
    enabled: true,
    stallTimeoutMs: config.claudeCodeStallTimeoutMs,
  });
  const runnerRegistry = new Map<string, AgentRunner>([
    [codexRunner.id, codexRunner],
    [claudeCodeRunner.id, claudeCodeRunner],
    [fakeRunner.id, fakeRunner],
  ]);
  const defaultRunnerId = config.runner === "codex" ? codexRunner.id : fakeRunner.id;
  const runnerCapabilities = await Promise.all(
    [...runnerRegistry.values()].map((runner) => runner.detectCapabilities()),
  );
  const runners = [codexRunner, claudeCodeRunner, fakeRunner];
  const worker = new AgentWorker(repository, runnerRegistry, eventBus, config.outputSchemaPath, {
    claimDelayMs: config.agentClaimDelayMs,
    defaultRunnerId,
    runnerCapabilities,
    gitService,
    worktreesPath: config.worktreesPath,
    skillService,
    playwrightValidationService,
  });

  const app = await createApp({
    config,
    repository,
    gitService,
    skillService,
    runners,
    eventBus,
    worker,
    previewService,
    artifactService,
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
