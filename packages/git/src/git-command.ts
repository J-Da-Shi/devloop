import { spawn } from "node:child_process";
import { execa } from "execa";
import type { GitExecutionOptions } from "./git-types.js";

export const terminateProcessGroup = (processGroupId: number): void => {
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    processGroupId === process.pid
  ) {
    return;
  }
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill", ["/pid", String(processGroupId), "/T", "/F"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.on("error", () => undefined);
    taskkill.unref();
    return;
  }

  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch {
    return;
  }
  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // The process group has already exited.
    }
  }, 5_000);
  forceKillTimer.unref();
};

export const createGitCommand = (executable: string) => {
  const executeForRun = async (
    argumentsList: string[],
    execution: GitExecutionOptions,
    options: { env?: NodeJS.ProcessEnv; reject?: boolean } = {},
  ) => {
    execution.signal?.throwIfAborted();
    const managed = Boolean(execution.signal || execution.onProcessGroupId);
    const subprocess = execa(executable, argumentsList, {
      ...options,
      ...(managed ? { detached: true } : {}),
      ...(execution.signal
        ? {
            cancelSignal: execution.signal,
            forceKillAfterDelay: 5_000,
          }
        : {}),
    });
    const processGroupId = managed ? (subprocess.pid ?? null) : null;
    const terminate = () => {
      if (processGroupId !== null) {
        terminateProcessGroup(processGroupId);
      }
    };
    if (processGroupId !== null) {
      try {
        execution.onProcessGroupId?.(processGroupId);
      } catch (error) {
        terminate();
        void subprocess.catch(() => undefined);
        throw error;
      }
      execution.signal?.addEventListener("abort", terminate, { once: true });
    }
    try {
      const result = await subprocess;
      if (result.isCanceled) {
        throw new DOMException("Git execution cancelled", "AbortError");
      }
      return result;
    } catch (error) {
      if (execution.signal?.aborted) {
        throw new DOMException("Git execution cancelled", "AbortError");
      }
      throw error;
    } finally {
      execution.signal?.removeEventListener("abort", terminate);
      if (processGroupId !== null) {
        execution.onProcessGroupId?.(null);
      }
    }
  };

  return {
    executeForRun,
    nonInteractiveEnvironment: (): NodeJS.ProcessEnv => ({
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    }),
  };
};
