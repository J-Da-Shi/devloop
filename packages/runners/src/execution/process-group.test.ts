import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateProcessGroup } from "./process-group.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("terminateProcessGroup", () => {
  it.runIf(process.platform !== "win32")("先终止整个 POSIX 进程组，超时后强制清理", () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    terminateProcessGroup(12_345, 100);

    expect(kill).toHaveBeenCalledWith(-12_345, "SIGTERM");
    vi.advanceTimersByTime(100);
    expect(kill).toHaveBeenCalledWith(-12_345, "SIGKILL");
  });

  it("忽略无效或当前服务进程的 ID", () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    terminateProcessGroup(0);
    terminateProcessGroup(process.pid);

    expect(kill).not.toHaveBeenCalled();
  });
});
