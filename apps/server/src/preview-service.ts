import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GitService } from "@devloop/git";
import { terminateProcessGroup } from "@devloop/runners";
import type { PreviewConfigSource, RunPreview, RunPreviewConfig } from "@devloop/shared";

export interface StartPreviewInput {
  runId: string;
  repositoryPath: string;
  resultCommit: string;
  command: string | null;
  workingDirectory: string;
  healthPath: string;
  source?: PreviewConfigSource;
  signal?: AbortSignal;
}

export interface ActivePreview extends RunPreview {
  workingDirectory: string;
  configuration: RunPreviewConfig;
}

export interface PreviewDependencyInstallation {
  command: string;
  workingDirectory: string;
  lockfile: string;
}

interface PreviewSession extends ActivePreview {
  repositoryPath: string;
  worktreePath: string;
  child: ChildProcess;
  logs: string;
  ready: boolean;
  stopping: boolean;
  exited: boolean;
  exitCode: number | null;
  exitPromise: Promise<void>;
  startupPromise: Promise<void>;
  cleanupPromise: Promise<void> | null;
}

const maxPreviewLogLength = 24_000;

const dependencyInstallers = [
  { lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
  { lockfile: "package-lock.json", command: "npm ci" },
  { lockfile: "yarn.lock", command: "yarn install --frozen-lockfile" },
  { lockfile: "bun.lockb", command: "bun install --frozen-lockfile" },
  { lockfile: "bun.lock", command: "bun install --frozen-lockfile" },
] as const;

const ignoredSearchDirectories = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".devloop-runtime",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
]);
const maxPreviewManifestDepth = 5;
const maxPreviewManifests = 48;

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

interface PreviewPackageManifest {
  scripts: Record<string, string>;
}

interface PreviewScriptCandidate {
  directory: string;
  script: string;
  packageManager: PackageManager;
  score: number;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const inheritedEnvironmentNames = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "PNPM_HOME",
] as const;
const publicEnvironmentPrefixes = ["VITE_", "NEXT_PUBLIC_", "PUBLIC_"] as const;

export const buildPreviewEnvironment = (overrides: Record<string, string>): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of inheritedEnvironmentNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      publicEnvironmentPrefixes.some((prefix) => name.startsWith(prefix))
    ) {
      environment[name] = value;
    }
  }
  return { ...environment, ...overrides };
};

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

export const findPreviewDependencyInstallation = async (
  worktreePath: string,
  workingDirectory: string,
): Promise<PreviewDependencyInstallation | null> => {
  const root = resolve(worktreePath);
  let candidate = resolve(root, workingDirectory);
  const candidateRelativePath = relative(root, candidate);
  if (candidateRelativePath.startsWith("..") || isAbsolute(candidateRelativePath)) return null;
  while (true) {
    for (const installer of dependencyInstallers) {
      if (await isFile(join(candidate, installer.lockfile))) {
        return {
          command: installer.command,
          workingDirectory: candidate,
          lockfile: installer.lockfile,
        };
      }
    }
    if (candidate === root) return null;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
};

const packageManagerForLockfile = (lockfile: string | null): PackageManager => {
  switch (lockfile) {
    case "pnpm-lock.yaml":
      return "pnpm";
    case "package-lock.json":
      return "npm";
    case "yarn.lock":
      return "yarn";
    case "bun.lockb":
    case "bun.lock":
      return "bun";
    default:
      return "npm";
  }
};

const parsePreviewPackageManifest = (content: string): PreviewPackageManifest | null => {
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const scriptsValue = record.scripts;
    const scripts =
      scriptsValue && typeof scriptsValue === "object" && !Array.isArray(scriptsValue)
        ? Object.fromEntries(
            Object.entries(scriptsValue).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
    return { scripts };
  } catch {
    return null;
  }
};

const frameworkForPreviewScript = (
  command: string,
): { score: number; nextStyleArguments: boolean } | null => {
  const lowered = command.toLowerCase();
  if (/[\r\n;&|`<>]|\$\(|\$\{/.test(command)) return null;
  if (/\b(?:concurrently|electron|turbo|nx\s+run-many)\b/.test(lowered)) return null;
  const definitions = [
    { pattern: /\bvite(?:\s|$)/, nextStyleArguments: false },
    { pattern: /\bnext\s+(?:dev|start)\b/, nextStyleArguments: true },
    {
      pattern: /\bnuxt\s+(?:dev|start)\b/,
      nextStyleArguments: false,
    },
    {
      pattern: /\bastro\s+(?:dev|preview)\b/,
      nextStyleArguments: false,
    },
    {
      pattern: /\b(?:svelte-kit|vite)\s+dev\b/,
      nextStyleArguments: false,
    },
    {
      pattern: /\b(?:remix\s+vite:dev|(?:remix|vite)\s+dev)\b/,
      nextStyleArguments: false,
    },
    {
      pattern: /\bwebpack(?:-cli)?\s+serve\b/,
      nextStyleArguments: false,
    },
    { pattern: /\bparcel\b/, nextStyleArguments: false },
    {
      pattern: /\bstorybook\s+dev\b/,
      nextStyleArguments: false,
    },
  ];
  for (const definition of definitions) {
    if (definition.pattern.test(lowered)) {
      return {
        score: 100,
        nextStyleArguments: definition.nextStyleArguments,
      };
    }
  }
  return null;
};

const buildPreviewScriptCommand = (
  packageManager: PackageManager,
  script: string,
  nextStyleArguments: boolean,
): string => {
  const argumentsList = nextStyleArguments
    ? "--hostname 127.0.0.1 --port {{port}}"
    : "--host 127.0.0.1 --port {{port}}";
  switch (packageManager) {
    case "pnpm":
      return `pnpm run ${script} -- ${argumentsList}`;
    case "yarn":
      return `yarn run ${script} ${argumentsList}`;
    case "bun":
      return `bun run ${script} -- ${argumentsList}`;
    default:
      return `npm run ${script} -- ${argumentsList}`;
  }
};

const previewPackageManifests = async (
  root: string,
): Promise<Array<{ directory: string; manifest: PreviewPackageManifest }>> => {
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const manifests: Array<{ directory: string; manifest: PreviewPackageManifest }> = [];
  while (queue.length && manifests.length < maxPreviewManifests) {
    const current = queue.shift();
    if (!current) break;
    const packageJson = join(current.directory, "package.json");
    try {
      const manifest = parsePreviewPackageManifest(await readFile(packageJson, "utf8"));
      if (manifest) manifests.push({ directory: current.directory, manifest });
    } catch {
      // 当前目录不是 Node.js 包，继续向下检查。
    }
    if (current.depth >= maxPreviewManifestDepth) continue;
    try {
      const entries = await readdir(current.directory, { withFileTypes: true, encoding: "utf8" });
      for (const entry of entries) {
        if (!entry.isDirectory() || ignoredSearchDirectories.has(entry.name)) continue;
        queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 });
      }
    } catch {
      continue;
    }
  }
  return manifests;
};

export const detectPreviewConfig = async (
  worktreePath: string,
): Promise<RunPreviewConfig | null> => {
  const root = resolve(worktreePath);
  const manifests = await previewPackageManifests(root);
  const candidates: PreviewScriptCandidate[] = [];
  for (const { directory, manifest } of manifests) {
    const installation = await findPreviewDependencyInstallation(root, directory);
    const packageManager = packageManagerForLockfile(installation?.lockfile ?? null);
    for (const script of ["dev", "preview", "start"] as const) {
      const command = manifest.scripts[script];
      if (!command) continue;
      const framework = frameworkForPreviewScript(command);
      if (!framework) continue;
      const relativeDirectory = relative(root, directory);
      const directoryPreference = /(?:^|\/)(?:web|frontend|client|app)(?:\/|$)/i.test(
        relativeDirectory,
      )
        ? 8
        : 0;
      const scriptPreference = script === "dev" ? 3 : script === "preview" ? 2 : 1;
      candidates.push({
        directory,
        script,
        packageManager,
        score: framework.score + directoryPreference + scriptPreference,
      });
    }
  }
  const candidate = candidates.sort((left, right) => right.score - left.score)[0];
  if (!candidate) return null;
  const manifest = manifests.find((item) => item.directory === candidate.directory)?.manifest;
  const script = manifest?.scripts[candidate.script];
  if (!script) return null;
  const framework = frameworkForPreviewScript(script);
  if (!framework) return null;
  const workingDirectory = relative(root, candidate.directory) || ".";
  return {
    source: "detected",
    command: buildPreviewScriptCommand(
      candidate.packageManager,
      candidate.script,
      framework.nextStyleArguments,
    ),
    workingDirectory,
    healthPath: "/",
  };
};

export class PreviewStartError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PreviewStartError";
  }
}

export class PreviewNotDetectedError extends PreviewStartError {
  public constructor(message: string) {
    super(message);
    this.name = "PreviewNotDetectedError";
  }
}

export class PreviewService {
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly previewIdByRunId = new Map<string, string>();
  private readonly starts = new Map<string, Promise<ActivePreview>>();

  public constructor(
    private readonly gitService: Pick<
      GitService,
      "createDetachedWorktree" | "removeManagedWorktree"
    >,
    private readonly previewsRoot: string,
    private readonly startupTimeoutMs = 90_000,
    private readonly dependencyInstallTimeoutMs = 10 * 60_000,
  ) {}

  async start(input: StartPreviewInput): Promise<ActivePreview> {
    const pending = this.starts.get(input.runId);
    if (pending) return pending;
    const starting = this.startSession(input);
    this.starts.set(input.runId, starting);
    try {
      return await starting;
    } finally {
      if (this.starts.get(input.runId) === starting) {
        this.starts.delete(input.runId);
      }
    }
  }

  private async startSession(input: StartPreviewInput): Promise<ActivePreview> {
    const existingId = this.previewIdByRunId.get(input.runId);
    const existing = existingId ? this.sessions.get(existingId) : null;
    if (existing && !existing.stopping && !existing.exited) {
      await existing.startupPromise;
      return this.toActivePreview(existing);
    }

    const id = randomUUID();
    const worktreePath = resolve(this.previewsRoot, id);
    let session: PreviewSession | null = null;
    this.assertManagedPreviewPath(worktreePath);
    try {
      await this.gitService.createDetachedWorktree({
        repositoryPath: input.repositoryPath,
        worktreePath,
        commit: input.resultCommit,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      input.signal?.throwIfAborted();
      const configuration = input.command
        ? {
            source: input.source ?? "project",
            command: input.command,
            workingDirectory: input.workingDirectory,
            healthPath: input.healthPath,
          }
        : await detectPreviewConfig(worktreePath);
      if (!configuration) {
        throw new PreviewNotDetectedError(
          "未能自动识别可启动的 Web 预览；请在项目的高级预览设置中提供启动命令。",
        );
      }
      const workingDirectory = this.resolveWorkingDirectory(
        worktreePath,
        configuration.workingDirectory,
      );
      const workingDirectoryStat = await stat(workingDirectory);
      if (!workingDirectoryStat.isDirectory()) {
        throw new PreviewStartError("配置的预览工作目录不是目录");
      }
      await this.prepareDependencies(worktreePath, workingDirectory, input.signal);
      const port = await this.allocatePort();
      const command = configuration.command.replaceAll("{{port}}", String(port));
      const baseUrl = `http://127.0.0.1:${port}`;
      const healthUrl = new URL(configuration.healthPath, baseUrl);
      if (healthUrl.origin !== baseUrl) {
        throw new PreviewStartError("健康检查路径必须指向当前预览服务");
      }
      const child = spawn(command, {
        cwd: workingDirectory,
        env: buildPreviewEnvironment({
          NODE_ENV: "development",
          HOST: "127.0.0.1",
          PORT: String(port),
          DEVLOOP_PREVIEW_HOST: "127.0.0.1",
          DEVLOOP_PREVIEW_PORT: String(port),
          DEVLOOP_PREVIEW_URL: baseUrl,
        }),
        shell: true,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let resolveExit!: () => void;
      const exitPromise = new Promise<void>((resolvePromise) => {
        resolveExit = resolvePromise;
      });
      const createdSession: PreviewSession = {
        id,
        runId: input.runId,
        url: baseUrl,
        status: "starting",
        startedAt: new Date().toISOString(),
        workingDirectory,
        configuration,
        repositoryPath: input.repositoryPath,
        worktreePath,
        child,
        logs: "",
        ready: false,
        stopping: false,
        exited: false,
        exitCode: null,
        exitPromise,
        startupPromise: Promise.resolve(),
        cleanupPromise: null,
      };
      session = createdSession;
      const appendLog = (source: string, value: unknown): void => {
        createdSession.logs = `${createdSession.logs}${source}: ${String(value)}`.slice(
          -maxPreviewLogLength,
        );
      };
      child.stdout?.on("data", (chunk) => appendLog("stdout", chunk));
      child.stderr?.on("data", (chunk) => appendLog("stderr", chunk));
      child.once("error", (error) => {
        appendLog("error", error.message);
        createdSession.exited = true;
        resolveExit();
      });
      child.once("exit", (code, signal) => {
        createdSession.exited = true;
        createdSession.exitCode = code;
        if (signal) appendLog("signal", signal);
        resolveExit();
        if (createdSession.ready && !createdSession.stopping) {
          void this.cleanup(createdSession).catch(() => undefined);
        }
      });
      createdSession.startupPromise = this.waitUntilHealthy(
        createdSession,
        healthUrl.toString(),
        input.signal,
      );
      this.sessions.set(id, createdSession);
      this.previewIdByRunId.set(input.runId, id);

      await createdSession.startupPromise;
      createdSession.ready = true;
      createdSession.status = "running";
      return this.toActivePreview(createdSession);
    } catch (error) {
      if (session) {
        await this.cleanup(session).catch(() => undefined);
      } else {
        await this.gitService
          .removeManagedWorktree({
            repositoryPath: input.repositoryPath,
            worktreePath,
            managedRoot: this.previewsRoot,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  get(previewId: string): RunPreview | null {
    const session = this.sessions.get(previewId);
    return session && !session.stopping && !session.exited ? this.toRunPreview(session) : null;
  }

  async stop(previewId: string): Promise<boolean> {
    const session = this.sessions.get(previewId);
    if (!session) return false;
    await this.cleanup(session);
    return true;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((session) => this.cleanup(session)));
  }

  private async waitUntilHealthy(
    session: PreviewSession,
    healthUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError = "服务尚未响应";
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (session.exited) {
        throw new PreviewStartError(
          `预览命令提前退出${session.exitCode === null ? "" : `（退出码 ${session.exitCode}）`}${
            session.logs ? `\n${session.logs}` : ""
          }`,
        );
      }
      try {
        const timeoutSignal = AbortSignal.timeout(2_000);
        const response = await fetch(healthUrl, {
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        });
        if (response.ok) return;
        lastError = `健康检查返回 HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(250);
    }
    throw new PreviewStartError(
      `等待预览服务启动超时：${lastError}${session.logs ? `\n${session.logs}` : ""}`,
    );
  }

  private async prepareDependencies(
    worktreePath: string,
    workingDirectory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const installation = await findPreviewDependencyInstallation(worktreePath, workingDirectory);
    if (!installation) return;

    signal?.throwIfAborted();
    const result = await this.runPreparationCommand(installation, signal);
    if (result.exitCode !== 0) {
      throw new PreviewStartError(
        `安装预览依赖失败（${installation.lockfile}，退出码 ${result.exitCode ?? "未知"}）${
          result.output ? `\n${result.output}` : ""
        }`,
      );
    }
  }

  private runPreparationCommand(
    installation: PreviewDependencyInstallation,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string }> {
    signal?.throwIfAborted();
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(installation.command, {
        cwd: installation.workingDirectory,
        env: buildPreviewEnvironment({
          NODE_ENV: "development",
          DEVLOOP_PREVIEW_DEPENDENCY_INSTALL: "true",
        }),
        shell: true,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let terminationTimeout: NodeJS.Timeout | undefined;
      let pendingError: Error | null = null;

      const appendOutput = (source: string, value: unknown): void => {
        output = `${output}${source}: ${String(value)}`.slice(-maxPreviewLogLength);
      };
      const abort = (): void => {
        const reason = signal?.reason;
        const error = reason instanceof Error ? reason : new Error("预览依赖安装已取消");
        if (!(reason instanceof Error)) error.name = "AbortError";
        stop(error);
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (terminationTimeout) clearTimeout(terminationTimeout);
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const stop = (error: Error): void => {
        if (pendingError) return;
        pendingError = error;
        if (child.pid) terminateProcessGroup(child.pid);
        terminationTimeout = setTimeout(() => finish(() => rejectPromise(error)), 6_000);
        terminationTimeout.unref();
      };

      child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
      child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));
      child.once("error", (error) => {
        finish(() =>
          rejectPromise(
            new PreviewStartError(
              `无法启动预览依赖安装命令 ${installation.command}：${error.message}`,
            ),
          ),
        );
      });
      child.once("exit", (exitCode, exitSignal) => {
        if (exitSignal) appendOutput("signal", exitSignal);
        if (pendingError) {
          const error = pendingError;
          finish(() => rejectPromise(error));
          return;
        }
        finish(() => resolvePromise({ exitCode, output }));
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (settled) return;
      timeout = setTimeout(() => {
        stop(
          new PreviewStartError(
            `等待预览依赖安装超时（${this.dependencyInstallTimeoutMs}ms）：${installation.command}${
              output ? `\n${output}` : ""
            }`,
          ),
        );
      }, this.dependencyInstallTimeoutMs);
      timeout.unref();
      if (signal?.aborted) abort();
    });
  }

  private cleanup(session: PreviewSession): Promise<void> {
    session.cleanupPromise ??= (async () => {
      session.stopping = true;
      if (!session.exited && session.child.pid) {
        terminateProcessGroup(session.child.pid);
        await Promise.race([session.exitPromise, delay(6_000)]);
      }
      this.sessions.delete(session.id);
      if (this.previewIdByRunId.get(session.runId) === session.id) {
        this.previewIdByRunId.delete(session.runId);
      }
      await this.gitService.removeManagedWorktree({
        repositoryPath: session.repositoryPath,
        worktreePath: session.worktreePath,
        managedRoot: this.previewsRoot,
      });
    })();
    return session.cleanupPromise;
  }

  private resolveWorkingDirectory(worktreePath: string, configuredPath: string): string {
    const workingDirectory = resolve(worktreePath, configuredPath);
    const relativePath = relative(worktreePath, workingDirectory);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new PreviewStartError("预览工作目录不能超出任务结果 Worktree");
    }
    return workingDirectory;
  }

  private assertManagedPreviewPath(candidate: string): void {
    const root = resolve(this.previewsRoot);
    const relativePath = relative(root, resolve(candidate));
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("预览 Worktree 路径超出 DevLoop 受管目录");
    }
  }

  private allocatePort(): Promise<number> {
    return new Promise((resolvePromise, rejectPromise) => {
      const server = createServer();
      server.unref();
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          rejectPromise(new Error("无法分配预览端口"));
          return;
        }
        server.close((error) => {
          if (error) rejectPromise(error);
          else resolvePromise(address.port);
        });
      });
    });
  }

  private toRunPreview(session: PreviewSession): RunPreview {
    return {
      id: session.id,
      runId: session.runId,
      url: session.url,
      status: session.ready ? "running" : "starting",
      startedAt: session.startedAt,
    };
  }

  private toActivePreview(session: PreviewSession): ActivePreview {
    return {
      ...this.toRunPreview(session),
      workingDirectory: session.workingDirectory,
      configuration: session.configuration,
    };
  }
}
