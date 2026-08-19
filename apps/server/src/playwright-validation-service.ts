import { spawn } from "node:child_process";
import { chromium, type Browser } from "playwright";
import { terminateProcessGroup } from "@devloop/runners";
import type { PlaywrightValidationCheck, PlaywrightValidationReport } from "@devloop/shared";
import type { ArtifactService } from "./artifact-service.js";
import { buildPreviewEnvironment, type PreviewService } from "./preview-service.js";

export interface ValidateRunInput {
  runId: string;
  repositoryPath: string;
  resultCommit: string;
  previewCommand: string | null;
  previewWorkingDirectory: string;
  previewHealthPath: string;
  playwrightEnabled: boolean;
  playwrightTestCommand: string | null;
  signal?: AbortSignal;
}

const maxCommandOutputLength = 48_000;

const asMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

export class PlaywrightValidationService {
  public constructor(
    private readonly previewService: PreviewService,
    private readonly artifactService: ArtifactService,
    private readonly browserExecutable: string | null,
    private readonly browserTimeoutMs = 60_000,
    private readonly customTestTimeoutMs = 10 * 60_000,
  ) {}

  async validate(input: ValidateRunInput): Promise<PlaywrightValidationReport> {
    const startedAt = new Date().toISOString();
    const checks: PlaywrightValidationCheck[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    let screenshotArtifactId: string | null = null;
    let customTestOutput: string | null = null;
    let previewId: string | null = null;

    if (!input.playwrightEnabled) {
      checks.push({
        name: "自动 Playwright",
        status: "skipped",
        message: "项目已关闭自动 Playwright 验证",
      });
      return this.finish(input.runId, startedAt, checks, pageErrors, consoleErrors, null, null);
    }
    if (!input.previewCommand) {
      checks.push({
        name: "启动预览",
        status: "skipped",
        message: "项目尚未配置预览命令",
      });
      return this.finish(input.runId, startedAt, checks, pageErrors, consoleErrors, null, null);
    }

    try {
      const preview = await this.previewService.start({
        runId: input.runId,
        repositoryPath: input.repositoryPath,
        resultCommit: input.resultCommit,
        command: input.previewCommand,
        workingDirectory: input.previewWorkingDirectory,
        healthPath: input.previewHealthPath,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      previewId = preview.id;
      checks.push({ name: "启动预览", status: "passed", message: `预览已在本机端口就绪` });

      try {
        const result = await this.runBrowserChecks(
          input.runId,
          preview.url,
          {
            checks,
            pageErrors,
            consoleErrors,
          },
          input.signal,
        );
        screenshotArtifactId = result.screenshotArtifactId;
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (this.isBrowserUnavailable(error)) {
          checks.push({
            name: "启动 Playwright 浏览器",
            status: "skipped",
            message: `没有可用的 Chromium：${asMessage(error)}`,
          });
        } else {
          checks.push({
            name: "Playwright 页面验证",
            status: "failed",
            message: asMessage(error),
          });
        }
      }

      if (input.playwrightTestCommand) {
        try {
          const custom = await this.runCustomTests(
            input.playwrightTestCommand,
            preview.workingDirectory,
            preview.url,
            input.signal,
          );
          customTestOutput = custom.output;
          checks.push({
            name: "项目交互测试",
            status: custom.exitCode === 0 ? "passed" : "failed",
            message:
              custom.exitCode === 0
                ? "项目自定义 Playwright 命令执行通过"
                : `项目自定义 Playwright 命令退出码 ${custom.exitCode}`,
          });
        } catch (error) {
          if (isAbortError(error)) throw error;
          checks.push({ name: "项目交互测试", status: "failed", message: asMessage(error) });
        }
      } else {
        checks.push({
          name: "项目交互测试",
          status: "skipped",
          message: "未配置项目自定义 Playwright 命令",
        });
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      checks.push({ name: "启动预览", status: "failed", message: asMessage(error) });
    } finally {
      if (previewId) await this.previewService.stop(previewId).catch(() => undefined);
    }

    return this.finish(
      input.runId,
      startedAt,
      checks,
      pageErrors,
      consoleErrors,
      screenshotArtifactId,
      customTestOutput,
    );
  }

  private async runBrowserChecks(
    runId: string,
    url: string,
    result: {
      checks: PlaywrightValidationCheck[];
      pageErrors: string[];
      consoleErrors: string[];
    },
    signal?: AbortSignal,
  ): Promise<{ screenshotArtifactId: string | null }> {
    signal?.throwIfAborted();
    const browser = await this.launchBrowser();
    const abort = () => void browser.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on("pageerror", (error) => result.pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") result.consoleErrors.push(message.text());
      });

      let loaded = false;
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.browserTimeoutMs,
        });
        loaded = response === null || response.ok();
        result.checks.push({
          name: "页面加载",
          status: loaded ? "passed" : "failed",
          message: response ? `HTTP ${response.status()}` : "页面已完成客户端导航",
        });
      } catch (error) {
        result.checks.push({ name: "页面加载", status: "failed", message: asMessage(error) });
      }

      if (loaded) {
        const body = page.locator("body");
        const hasVisibleContent =
          (await body.isVisible()) && Boolean((await body.innerText()).trim());
        result.checks.push({
          name: "可见内容",
          status: hasVisibleContent ? "passed" : "failed",
          message: hasVisibleContent ? "页面包含可见文本内容" : "页面没有可见文本内容",
        });

        const interactive = page.locator(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        const interactiveCount = await interactive.count();
        if (interactiveCount === 0) {
          result.checks.push({
            name: "键盘交互",
            status: "skipped",
            message: "页面没有可安全验证的交互控件",
          });
        } else {
          await page.keyboard.press("Tab");
          const focusedElement = page.locator(":focus");
          const focused =
            (await focusedElement.count()) > 0 && (await focusedElement.first().isVisible());
          result.checks.push({
            name: "键盘交互",
            status: focused ? "passed" : "failed",
            message: focused ? "首个交互控件可通过键盘聚焦" : "交互控件无法通过 Tab 聚焦",
          });
        }
      }

      await page.waitForTimeout(300);
      let screenshotArtifactId: string | null = null;
      try {
        const screenshot = await page.screenshot({ type: "png", animations: "disabled" });
        const artifact = await this.artifactService.write(
          runId,
          "playwright-screenshot",
          "png",
          screenshot,
        );
        screenshotArtifactId = artifact.id;
        result.checks.push({
          name: "页面截图",
          status: "passed",
          message: "已保存 1440 x 900 截图",
        });
      } catch (error) {
        result.checks.push({ name: "页面截图", status: "failed", message: asMessage(error) });
      }

      result.checks.push({
        name: "页面异常",
        status: result.pageErrors.length === 0 ? "passed" : "failed",
        message:
          result.pageErrors.length === 0
            ? "未捕获未处理的页面异常"
            : `捕获 ${result.pageErrors.length} 个页面异常`,
      });
      result.checks.push({
        name: "控制台错误",
        status: result.consoleErrors.length === 0 ? "passed" : "failed",
        message:
          result.consoleErrors.length === 0
            ? "未捕获 console.error"
            : `捕获 ${result.consoleErrors.length} 条 console.error`,
      });
      return { screenshotArtifactId };
    } finally {
      signal?.removeEventListener("abort", abort);
      await browser.close();
    }
  }

  private runCustomTests(
    command: string,
    workingDirectory: string,
    previewUrl: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      signal?.throwIfAborted();
      const child = spawn(command, {
        cwd: workingDirectory,
        env: buildPreviewEnvironment({
          CI: "1",
          BASE_URL: previewUrl,
          PLAYWRIGHT_BASE_URL: previewUrl,
          DEVLOOP_PREVIEW_URL: previewUrl,
          DEVLOOP_PREVIEW_PORT: new URL(previewUrl).port,
        }),
        shell: true,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let settled = false;
      let terminationError: Error | null = null;
      let hardStopTimer: NodeJS.Timeout | null = null;
      const append = (source: string, value: unknown) => {
        output = `${output}${source}: ${String(value)}`.slice(-maxCommandOutputLength);
      };
      child.stdout?.on("data", (chunk) => append("stdout", chunk));
      child.stderr?.on("data", (chunk) => append("stderr", chunk));
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (hardStopTimer) clearTimeout(hardStopTimer);
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const stop = () => {
        if (child.pid) terminateProcessGroup(child.pid);
      };
      const stopWithError = (error: Error) => {
        if (terminationError || settled) return;
        terminationError = error;
        stop();
        hardStopTimer = setTimeout(
          () => finish(() => rejectPromise(terminationError ?? error)),
          6_000,
        );
        hardStopTimer.unref();
      };
      const abort = () => stopWithError(new DOMException("自动验证已取消", "AbortError"));
      const timeout = setTimeout(
        () => stopWithError(new Error("项目交互测试执行超时")),
        this.customTestTimeoutMs,
      );
      timeout.unref();
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => finish(() => rejectPromise(error)));
      child.once("exit", (code) => {
        if (terminationError) {
          finish(() => rejectPromise(terminationError!));
        } else {
          finish(() => resolvePromise({ exitCode: code ?? 1, output: output.trim() }));
        }
      });
    });
  }

  private async finish(
    runId: string,
    startedAt: string,
    checks: PlaywrightValidationCheck[],
    pageErrors: string[],
    consoleErrors: string[],
    screenshotArtifactId: string | null,
    customTestOutput: string | null,
  ): Promise<PlaywrightValidationReport> {
    const hasFailure = checks.some((check) => check.status === "failed");
    const hasVerification = checks.some(
      (check) =>
        check.status === "passed" && check.name !== "启动预览" && check.name !== "页面截图",
    );
    const report: PlaywrightValidationReport = {
      status: hasFailure ? "failed" : hasVerification ? "passed" : "skipped",
      startedAt,
      finishedAt: new Date().toISOString(),
      checks,
      pageErrors,
      consoleErrors,
      screenshotArtifactId,
      customTestOutput,
    };
    await this.artifactService.writeValidationReport(runId, report);
    return report;
  }

  private isBrowserUnavailable(error: unknown): boolean {
    const message = asMessage(error);
    return (
      message.includes("Executable doesn't exist") ||
      message.includes("Failed to launch browser") ||
      message.includes("browserType.launch")
    );
  }

  private async launchBrowser(): Promise<Browser> {
    if (this.browserExecutable) {
      return chromium.launch({
        headless: true,
        timeout: this.browserTimeoutMs,
        executablePath: this.browserExecutable,
      });
    }
    const errors: string[] = [];
    for (const options of [{}, { channel: "chrome" as const }, { channel: "msedge" as const }]) {
      try {
        return await chromium.launch({
          headless: true,
          timeout: this.browserTimeoutMs,
          ...options,
        });
      } catch (error) {
        errors.push(asMessage(error));
      }
    }
    throw new Error(errors.join("\n"));
  }
}
