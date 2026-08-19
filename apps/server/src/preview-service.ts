import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import type { GitService } from "@devloop/git";
import { terminateProcessGroup } from "@devloop/runners";
import type { RunPreview } from "@devloop/shared";

export interface StartPreviewInput {
  runId: string;
  repositoryPath: string;
  resultCommit: string;
  command: string;
  workingDirectory: string;
  healthPath: string;
  signal?: AbortSignal;
}

export interface ActivePreview extends RunPreview {
  workingDirectory: string;
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

export class PreviewStartError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PreviewStartError";
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
      const workingDirectory = this.resolveWorkingDirectory(worktreePath, input.workingDirectory);
      const workingDirectoryStat = await stat(workingDirectory);
      if (!workingDirectoryStat.isDirectory()) {
        throw new PreviewStartError("配置的预览工作目录不是目录");
      }
      const port = await this.allocatePort();
      const command = input.command.replaceAll("{{port}}", String(port));
      const baseUrl = `http://127.0.0.1:${port}`;
      const healthUrl = new URL(input.healthPath, baseUrl);
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
    return { ...this.toRunPreview(session), workingDirectory: session.workingDirectory };
  }
}
