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

export interface ClaudeCodeRunnerOptions {
  executable?: string;
  executableArguments?: string[];
  enabled?: boolean;
  stallTimeoutMs?: number;
}

const requiredFlags = [
  "--print",
  "--output-format",
  "--input-format",
  "--dangerously-skip-permissions",
  "--add-dir",
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
  "CLAUDE_HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const sensitivePatterns = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
  /\b(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)\s*[=:]\s*\S+/gi,
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

export const buildClaudeCodePrompt = buildTaskPrompt;

const describeStreamEvent = (event: Record<string, unknown>): string | null => {
  const type = getString(event, "type");
  if (type === "system") {
    const subtype = getString(event, "subtype");
    if (subtype === "init") return "Claude Code 会话已启动";
    return null;
  }
  if (type === "user") return "Claude Code 收到用户提示";
  if (type === "assistant") {
    const message = asRecord(event.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const record = asRecord(item);
        const itemType = getString(record, "type");
        if (itemType === "tool_use") {
          const name = getString(record, "name") ?? "工具";
          const inputRecord = asRecord(record?.input);
          const command = getString(inputRecord, "command");
          if (command) {
            return `Claude Code 正在执行：${truncate(redact(command), 280)}`;
          }
          return `Claude Code 正在调用工具：${name}`;
        }
        if (itemType === "text") {
          return "Claude Code 生成了一段说明";
        }
      }
    }
    return "Claude Code 已完成一个分析阶段";
  }
  if (type === "result") {
    const subtype = getString(event, "subtype");
    if (subtype === "success") return "Claude Code 已完成本轮开发";
    if (subtype === "error_max_turns") return "Claude Code 达到最大轮次";
    const errorMessage = getString(event, "error") ?? getString(event, "message");
    return truncate(redact(errorMessage ?? "Claude Code 执行失败"));
  }
  return null;
};

const extractResultFromStream = (lines: string[]): string | null => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trim();
    if (!trimmed) continue;
    try {
      const event = asRecord(JSON.parse(trimmed) as unknown);
      if (!event) continue;
      if (getString(event, "type") === "result") {
        const result = getString(event, "result");
        if (typeof result === "string" && result.trim()) {
          return result;
        }
      }
    } catch {
      // 忽略无法解析的行，继续向前找。
    }
  }
  return null;
};

interface ClaudeCodeAttemptOptions {
  outputPath: string;
  prompt: string;
  permissionMode: "acceptEdits" | "plan";
  startMessage: string;
}

type ClaudeCodeAttemptResult =
  { kind: "completed"; output: string } | { kind: "result"; result: RunnerResult };

export class ClaudeCodeRunner implements AgentRunner {
  readonly id = "claude-code";
  private readonly executable: string;
  private readonly executableArguments: string[];
  private readonly enabled: boolean;
  private readonly stallTimeoutMs: number;

  public constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.executable = options.executable ?? "claude";
    this.executableArguments = options.executableArguments ?? [];
    this.enabled = options.enabled ?? false;
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
        execa(this.executable, [...this.executableArguments, "--help"], {
          env: environment,
          extendEnv: false,
        }),
        isAbsolute(this.executable)
          ? Promise.resolve(this.executable)
          : execa("/usr/bin/which", [this.executable]).then((result) => result.stdout.trim()),
      ]);

      const features: string[] = requiredFlags.filter((flag) => help.includes(flag));

      return {
        id: this.id,
        available: features.length === requiredFlags.length,
        version: version.trim(),
        executablePath,
        features,
        error:
          features.length === requiredFlags.length
            ? null
            : "当前 Claude Code CLI 缺少 DevLoop 所需的自动化参数",
      };
    } catch (error) {
      return {
        id: this.id,
        available: false,
        version: null,
        executablePath: null,
        features: [],
        error: error instanceof Error ? redact(error.message) : "Claude Code CLI 不可用或尚未登录",
      };
    }
  }

  buildArguments(
    input: RunnerInput,
    options: {
      permissionMode?: "acceptEdits" | "plan";
    } = {},
  ): string[] {
    if (!input.worktreePath) {
      throw new Error("ClaudeCodeRunner 需要独立 Worktree");
    }

    const permissionMode = options.permissionMode ?? "acceptEdits";
    return [
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--permission-mode",
      permissionMode,
      "--add-dir",
      input.worktreePath,
    ];
  }

  start(input: RunnerInput, emit: (event: RunnerEvent) => void): RunnerHandle {
    if (!this.enabled) {
      throw new Error("真实 Claude Code 执行尚未启用");
    }
    if (!input.worktreePath || !input.outputSchemaPath) {
      throw new Error("ClaudeCodeRunner 需要独立 Worktree 和输出 Schema");
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
      throw new Error("ClaudeCodeRunner 需要独立 Worktree");
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
      throw new Error("ClaudeCodeRunner 需要独立 Worktree");
    }
    if (!input.outputSchemaPath) {
      throw new Error("ClaudeCodeRunner 需要 AgentResult Schema");
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
        prompt: await buildClaudeCodePrompt(input, outputSchema),
        permissionMode: "acceptEdits",
        startMessage: "正在启动 Claude Code CLI",
      });
      if (initialAttempt.kind === "result") {
        return initialAttempt.result;
      }

      try {
        return parseAgentResult("Claude Code", initialAttempt.output);
      } catch (error) {
        const validationError =
          error instanceof Error ? error.message : "Claude Code 最终结果无法解析";
        emit({
          type: "runner.agent",
          message: "Claude Code 最终结果格式不符合要求，正在进行一次 JSON 修复",
          data: { validationError: truncate(redact(validationError), 1_000) },
        });

        const repairAttempt = await this.runAttempt(input, emit, signal, {
          outputPath: repairOutputPath,
          prompt: buildRepairPrompt(outputSchema, initialAttempt.output, validationError, redact),
          permissionMode: "plan",
          startMessage: "正在启动 Claude Code JSON 格式修复",
        });
        if (repairAttempt.kind === "result") {
          return repairAttempt.result;
        }

        try {
          const result = parseAgentResult("Claude Code", repairAttempt.output);
          emit({ type: "runner.agent", message: "Claude Code JSON 格式修复完成" });
          return result;
        } catch (repairError) {
          const repairValidationError =
            repairError instanceof Error ? repairError.message : "修复结果仍然无法解析";
          return {
            outcome: "failed",
            summary: `Claude Code 两次返回均不符合 AgentResult JSON 格式。首次错误：${truncate(redact(validationError), 500)}；修复后错误：${truncate(redact(repairValidationError), 500)}`,
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
    options: ClaudeCodeAttemptOptions,
  ): Promise<ClaudeCodeAttemptResult> {
    const worktreePath = input.worktreePath;
    if (!worktreePath) {
      throw new Error("ClaudeCodeRunner 需要独立 Worktree");
    }
    signal.throwIfAborted();
    let lastCliError: string | null = null;
    const streamLines: string[] = [];
    const streamInput = `${JSON.stringify({
      type: "user",
      message: { role: "user", content: options.prompt },
    })}\n`;
    const subprocess = execa(
      this.executable,
      [
        ...this.executableArguments,
        ...this.buildArguments(input, {
          permissionMode: options.permissionMode,
        }),
      ],
      {
        input: streamInput,
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
        subprocess.kill("SIGTERM", new Error("Claude Code CLI stopped producing output"));
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
        streamLines.push(line);
        const parsedLine = this.handleStreamLine(line, emit);
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
      streamLines.push(pending);
      lastCliError = this.handleStreamLine(pending, emit) ?? lastCliError;
    }
    if (stalled) {
      const stderr = typeof processResult.stderr === "string" ? processResult.stderr.trim() : "";
      const lastMessage = lastCliError ?? stderr;
      return {
        kind: "result",
        result: {
          outcome: "failed",
          summary: `Claude Code 连续 ${this.formatStallTimeout()} 没有产生任何输出，疑似卡死，已自动终止。${lastMessage ? ` 最后信息：${truncate(redact(lastMessage), 500)}` : ""}`,
          risks: ["Worktree 已保留，可在运行详情中继续诊断。"],
        },
      };
    }
    if (processResult.isCanceled) {
      throw new DOMException("Claude Code execution cancelled", "AbortError");
    }
    if (processResult.failed || processResult.exitCode !== 0) {
      const stderr = typeof processResult.stderr === "string" ? processResult.stderr : "";
      const message = truncate(
        redact(lastCliError ?? (stderr.trim() || "Claude Code CLI 异常退出")),
      );
      const blocked = isBlockedFailure(message);
      return {
        kind: "result",
        result: {
          outcome: blocked ? "blocked" : "failed",
          summary: message,
          risks: ["Claude Code 未生成可验证的结构化结果，Worktree 已保留。"],
          blockedReason: blocked ? message : null,
        },
      };
    }

    const streamedResult = extractResultFromStream(streamLines);
    if (streamedResult !== null) {
      return { kind: "completed", output: streamedResult };
    }
    try {
      return { kind: "completed", output: await readFile(options.outputPath, "utf8") };
    } catch (error) {
      const message = error instanceof Error ? error.message : "最终结果文件读取失败";
      return {
        kind: "result",
        result: {
          outcome: "failed",
          summary: `Claude Code 未生成可读取的最终结果：${truncate(redact(message), 500)}`,
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

  private handleStreamLine(line: string, emit: (event: RunnerEvent) => void): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const event = asRecord(JSON.parse(trimmed) as unknown);
      if (!event) return null;
      const message = describeStreamEvent(event);
      if (message) {
        emit({
          type: "runner.agent",
          message,
          data: { event: sanitizeEventData(event, redact) },
        });
      }
      const type = getString(event, "type");
      const subtype = getString(event, "subtype");
      if (type === "result" && subtype && subtype !== "success") {
        return message ?? "Claude Code 执行失败";
      }
      const errorMessage = getNumber(event, "is_error") !== null ? getString(event, "error") : null;
      if (errorMessage) {
        return message ?? errorMessage;
      }
      return null;
    } catch {
      emit({
        type: "runner.agent",
        message: "Claude Code 输出了一条无法解析的事件",
        data: { raw: truncate(redact(trimmed), 8_000) },
      });
      return null;
    }
  }
}
