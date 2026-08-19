import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { RunnerCapabilities } from "@devloop/shared";
import { execa } from "execa";
import { terminateProcessGroup } from "./process-group.js";
import {
  asRecord,
  buildRepairPrompt,
  getNumber,
  getString,
  isBlockedFailure,
  parseAgentResult,
  sanitizeEventData,
  truncate,
} from "./runner-output.js";
import { buildTaskPrompt } from "./task-prompt.js";
import type { AgentRunner, RunnerEvent, RunnerHandle, RunnerInput, RunnerResult } from "./types.js";

export interface CodexRunnerOptions {
  executable?: string;
  executableArguments?: string[];
  enabled?: boolean;
  ignoreUserConfig?: boolean;
  stallTimeoutMs?: number;
}

const requiredFlags = [
  "--json",
  "--output-last-message",
  "--sandbox",
  "--cd",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--config",
  "--disable",
] as const;

const disabledFeatures = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "plugins",
  "plugin_sharing",
  "remote_plugin",
] as const;

const inheritedEnvironmentKeys = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const sensitivePatterns = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
  /\b(?:OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN)\s*[=:]\s*\S+/gi,
] as const;

const redact = (value: string): string =>
  sensitivePatterns.reduce((current, pattern) => current.replace(pattern, "[已隐藏]"), value);

const buildEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    inheritedEnvironmentKeys.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );

export const buildCodexPrompt = buildTaskPrompt;

const describeJsonEvent = (event: Record<string, unknown>): string | null => {
  const type = getString(event, "type");
  if (type === "thread.started") return "Codex 会话已启动";
  if (type === "turn.started") return "Codex 开始分析并实施任务";
  if (type === "turn.completed") return "Codex 已完成本轮开发";
  if (type === "turn.failed" || type === "error") {
    const error = asRecord(event.error);
    return truncate(
      redact(getString(event, "message") ?? getString(error, "message") ?? "Codex 执行失败"),
    );
  }
  if (type !== "item.started" && type !== "item.completed" && type !== "item.updated") {
    return null;
  }

  const item = asRecord(event.item);
  const itemType = getString(item, "type");
  if (itemType === "command_execution") {
    const command = getString(item, "command");
    const exitCode = getNumber(item, "exit_code");
    if (type === "item.started") {
      return command
        ? `Codex 正在执行：${truncate(redact(command), 280)}`
        : "Codex 正在执行检查命令";
    }
    if (type === "item.completed") {
      return exitCode === null ? "Codex 命令执行完成" : `Codex 命令执行完成，退出码 ${exitCode}`;
    }
  }
  if (itemType === "file_change") return "Codex 已完成一组文件修改";
  if (itemType === "agent_message" && type === "item.completed")
    return "Codex 已生成结构化执行结果";
  if (itemType === "reasoning" && type === "item.completed") return "Codex 已完成一个分析阶段";
  return null;
};

interface CodexAttemptOptions {
  outputPath: string;
  prompt: string;
  sandbox: "workspace-write" | "read-only";
  disableTools?: boolean;
  startMessage: string;
}

type CodexAttemptResult =
  { kind: "completed"; output: string } | { kind: "result"; result: RunnerResult };

export class CodexRunner implements AgentRunner {
  readonly id = "codex";
  private readonly executable: string;
  private readonly executableArguments: string[];
  private readonly enabled: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly stallTimeoutMs: number;

  public constructor(options: CodexRunnerOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.executableArguments = options.executableArguments ?? [];
    this.enabled = options.enabled ?? false;
    this.ignoreUserConfig = options.ignoreUserConfig ?? false;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 30 * 60 * 1_000;
  }

  async detectCapabilities(): Promise<RunnerCapabilities> {
    try {
      const environment = buildEnvironment();
      const [{ stdout: version }, { stdout: help }, executablePath] = await Promise.all([
        execa(this.executable, [...this.executableArguments, "--version"], {
          env: environment,
          extendEnv: false,
        }),
        execa(this.executable, [...this.executableArguments, "exec", "--help"], {
          env: environment,
          extendEnv: false,
        }),
        isAbsolute(this.executable)
          ? Promise.resolve(this.executable)
          : execa("/usr/bin/which", [this.executable]).then((result) => result.stdout.trim()),
        execa(this.executable, [...this.executableArguments, "login", "status"], {
          env: environment,
          extendEnv: false,
        }),
      ]);

      const features: string[] = requiredFlags.filter((flag) => help.includes(flag));
      features.push("authenticated");

      return {
        id: this.id,
        available: features.length === requiredFlags.length + 1,
        version: version.trim(),
        executablePath,
        features,
        error:
          features.length === requiredFlags.length + 1
            ? null
            : "当前 Codex CLI 缺少 DevLoop 所需的自动化参数",
      };
    } catch (error) {
      return {
        id: this.id,
        available: false,
        version: null,
        executablePath: null,
        features: [],
        error: error instanceof Error ? redact(error.message) : "Codex CLI 不可用或尚未登录",
      };
    }
  }

  buildArguments(
    input: RunnerInput,
    options: {
      outputPath?: string;
      sandbox?: "workspace-write" | "read-only";
      disableTools?: boolean;
    } = {},
  ): string[] {
    if (!input.worktreePath) {
      throw new Error("CodexRunner 需要独立 Worktree");
    }

    const outputPath = options.outputPath ?? this.getOutputPath(input);
    const argumentsList = [
      "exec",
      "--json",
      "--output-last-message",
      outputPath,
      "--sandbox",
      options.sandbox ?? "workspace-write",
      "--ephemeral",
      "--ignore-rules",
      "--config",
      'approval_policy="never"',
      "--config",
      'shell_environment_policy.inherit="core"',
      "--color",
      "never",
      "--cd",
      input.worktreePath,
      "-",
    ];
    if (this.ignoreUserConfig) {
      argumentsList.splice(
        argumentsList.indexOf("--ignore-rules"),
        0,
        "--ignore-user-config",
        "--strict-config",
      );
    }
    const features = options.disableTools
      ? [...disabledFeatures, "shell_tool", "unified_exec"]
      : disabledFeatures;
    for (const feature of features) {
      argumentsList.splice(argumentsList.length - 1, 0, "--disable", feature);
    }
    if (input.taskType === "RESEARCH" && !options.disableTools) {
      argumentsList.splice(
        argumentsList.length - 1,
        0,
        "--config",
        "sandbox_workspace_write.network_access=true",
      );
    }
    return argumentsList;
  }

  start(input: RunnerInput, emit: (event: RunnerEvent) => void): RunnerHandle {
    if (!this.enabled) {
      throw new Error("真实 Codex 执行尚未启用");
    }
    if (!input.worktreePath || !input.outputSchemaPath) {
      throw new Error("CodexRunner 需要独立 Worktree 和输出 Schema");
    }

    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (input.signal.aborted) {
      controller.abort();
    } else {
      input.signal.addEventListener("abort", relayAbort, { once: true });
    }
    const result = this.run(input, emit, controller.signal).finally(() => {
      input.signal.removeEventListener("abort", relayAbort);
    });
    return {
      result,
      cancel: () => controller.abort(),
    };
  }

  private getOutputPath(input: RunnerInput): string {
    if (!input.worktreePath) {
      throw new Error("CodexRunner 需要独立 Worktree");
    }
    return join(input.worktreePath, ".devloop-runtime", `${input.runId}.json`);
  }

  private async run(
    input: RunnerInput,
    emit: (event: RunnerEvent) => void,
    signal: AbortSignal,
  ): Promise<RunnerResult> {
    const worktreePath = input.worktreePath;
    if (!worktreePath) {
      throw new Error("CodexRunner 需要独立 Worktree");
    }
    if (!input.outputSchemaPath) {
      throw new Error("CodexRunner 需要 AgentResult Schema");
    }
    signal.throwIfAborted();
    const outputPath = this.getOutputPath(input);
    const repairOutputPath = join(dirname(outputPath), `${input.runId}.repair.json`);
    const outputSchema = await readFile(input.outputSchemaPath, "utf8");
    signal.throwIfAborted();
    await mkdir(dirname(outputPath), { recursive: true });
    signal.throwIfAborted();
    try {
      const initialAttempt = await this.runAttempt(input, emit, signal, {
        outputPath,
        prompt: buildCodexPrompt(input, outputSchema),
        sandbox: "workspace-write",
        startMessage: "正在启动 Codex CLI",
      });
      if (initialAttempt.kind === "result") {
        return initialAttempt.result;
      }

      try {
        return parseAgentResult("Codex", initialAttempt.output);
      } catch (error) {
        const validationError = error instanceof Error ? error.message : "Codex 最终结果无法解析";
        emit({
          type: "runner.agent",
          message: "Codex 最终结果格式不符合要求，正在进行一次 JSON 修复",
          data: { validationError: truncate(redact(validationError), 1_000) },
        });

        const repairAttempt = await this.runAttempt(input, emit, signal, {
          outputPath: repairOutputPath,
          prompt: buildRepairPrompt(outputSchema, initialAttempt.output, validationError, redact),
          sandbox: "read-only",
          disableTools: true,
          startMessage: "正在启动 Codex JSON 格式修复",
        });
        if (repairAttempt.kind === "result") {
          return repairAttempt.result;
        }

        try {
          const result = parseAgentResult("Codex", repairAttempt.output);
          emit({ type: "runner.agent", message: "Codex JSON 格式修复完成" });
          return result;
        } catch (repairError) {
          const repairValidationError =
            repairError instanceof Error ? repairError.message : "修复结果仍然无法解析";
          return {
            outcome: "failed",
            summary: `Codex 两次返回均不符合 AgentResult JSON 格式。首次错误：${truncate(redact(validationError), 500)}；修复后错误：${truncate(redact(repairValidationError), 500)}`,
            risks: ["任务文件修改已保留在 Worktree 中，但没有可信的结构化执行结果。"],
          };
        }
      }
    } finally {
      await rm(dirname(outputPath), { recursive: true, force: true });
    }
  }

  private async runAttempt(
    input: RunnerInput,
    emit: (event: RunnerEvent) => void,
    signal: AbortSignal,
    options: CodexAttemptOptions,
  ): Promise<CodexAttemptResult> {
    const worktreePath = input.worktreePath;
    if (!worktreePath) {
      throw new Error("CodexRunner 需要独立 Worktree");
    }
    signal.throwIfAborted();
    let lastCliError: string | null = null;
    const subprocess = execa(
      this.executable,
      [
        ...this.executableArguments,
        ...this.buildArguments(input, {
          outputPath: options.outputPath,
          sandbox: options.sandbox,
          disableTools: options.disableTools ?? false,
        }),
      ],
      {
        input: options.prompt,
        cwd: worktreePath,
        env: buildEnvironment(),
        extendEnv: false,
        reject: false,
        detached: true,
        cancelSignal: signal,
        forceKillAfterDelay: 5_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const processGroupId = subprocess.pid ?? null;
    const terminate = () => {
      if (processGroupId !== null) {
        terminateProcessGroup(processGroupId);
      }
    };
    if (processGroupId !== null) {
      try {
        input.onProcessGroupId?.(processGroupId);
      } catch (error) {
        terminate();
        void subprocess.catch(() => undefined);
        throw error;
      }
      signal.addEventListener("abort", terminate, { once: true });
    }

    let pending = "";
    let stalled = false;
    let stallTimer: NodeJS.Timeout | null = null;
    const resetStallWatchdog = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
      }
      stallTimer = setTimeout(() => {
        stalled = true;
        terminate();
        subprocess.kill("SIGTERM", new Error("Codex CLI stopped producing output"));
      }, this.stallTimeoutMs);
      stallTimer.unref();
    };
    subprocess.stdout?.setEncoding("utf8");
    subprocess.stdout?.on("data", (chunk: string) => {
      resetStallWatchdog();
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const parsedLine = this.handleJsonLine(line, emit);
        lastCliError = parsedLine ?? lastCliError;
      }
    });
    subprocess.stderr?.on("data", resetStallWatchdog);

    emit({ type: "runner.agent", message: options.startMessage });
    resetStallWatchdog();
    const processResult = await (async () => {
      try {
        return await subprocess;
      } finally {
        if (stallTimer) {
          clearTimeout(stallTimer);
        }
        signal.removeEventListener("abort", terminate);
        if (processGroupId !== null) {
          input.onProcessGroupId?.(null);
        }
      }
    })();
    if (pending.trim()) {
      lastCliError = this.handleJsonLine(pending, emit) ?? lastCliError;
    }
    if (stalled) {
      const stderr = typeof processResult.stderr === "string" ? processResult.stderr.trim() : "";
      const lastMessage = lastCliError ?? stderr;
      return {
        kind: "result",
        result: {
          outcome: "failed",
          summary: `Codex 连续 ${this.formatStallTimeout()} 没有产生任何输出，疑似卡死，已自动终止。${lastMessage ? ` 最后信息：${truncate(redact(lastMessage), 500)}` : ""}`,
          risks: ["Worktree 已保留，可在运行详情中继续诊断。"],
        },
      };
    }
    if (processResult.isCanceled) {
      throw new DOMException("Codex execution cancelled", "AbortError");
    }
    if (processResult.failed || processResult.exitCode !== 0) {
      const stderr = typeof processResult.stderr === "string" ? processResult.stderr : "";
      const message = truncate(redact(lastCliError ?? (stderr.trim() || "Codex CLI 异常退出")));
      const blocked = isBlockedFailure(message);
      return {
        kind: "result",
        result: {
          outcome: blocked ? "blocked" : "failed",
          summary: message,
          risks: ["Codex 未生成可验证的结构化结果，Worktree 已保留。"],
          blockedReason: blocked ? message : null,
        },
      };
    }

    try {
      return { kind: "completed", output: await readFile(options.outputPath, "utf8") };
    } catch (error) {
      const message = error instanceof Error ? error.message : "最终结果文件读取失败";
      return {
        kind: "result",
        result: {
          outcome: "failed",
          summary: `Codex 未生成可读取的最终结果：${truncate(redact(message), 500)}`,
          risks: ["Worktree 已保留，可在运行详情中继续诊断。"],
        },
      };
    }
  }

  private formatStallTimeout(): string {
    if (this.stallTimeoutMs < 60_000) {
      return `${Math.max(1, Math.ceil(this.stallTimeoutMs / 1_000))} 秒`;
    }
    return `${Math.round(this.stallTimeoutMs / 60_000)} 分钟`;
  }

  private handleJsonLine(line: string, emit: (event: RunnerEvent) => void): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const event = asRecord(JSON.parse(trimmed) as unknown);
      if (!event) return null;
      const message = describeJsonEvent(event);
      if (message) {
        emit({
          type: "runner.agent",
          message,
          data: { event: sanitizeEventData(event, redact) },
        });
      }
      const type = getString(event, "type");
      if (type === "turn.failed" || type === "error") {
        return message ?? "Codex 执行失败";
      }
      return null;
    } catch {
      emit({
        type: "runner.agent",
        message: "Codex 输出了一条无法解析的事件",
        data: { raw: truncate(redact(trimmed), 8_000) },
      });
      return null;
    }
  }
}
