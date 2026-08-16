import { spawn } from "node:child_process";

export const terminateProcessGroup = (processGroupId: number, forceAfterMs = 5_000): void => {
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
  }, forceAfterMs);
  forceKillTimer.unref();
};
