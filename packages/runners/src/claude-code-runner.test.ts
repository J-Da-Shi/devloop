import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeCodePrompt, ClaudeCodeRunner } from "./claude-code-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ClaudeCodeRunner", () => {
  it("builds a non-interactive workspace-write command", () => {
    const runner = new ClaudeCodeRunner();
    const controller = new AbortController();
    const args = runner.buildArguments({
      runId: "run",
      taskId: "task",
      title: "Task",
      goal: "Goal",
      acceptanceCriteria: ["Done"],
      skills: [],
      worktreePath: "/tmp/worktree",
      outputSchemaPath: "/tmp/schema.json",
      signal: controller.signal,
    });

    expect(args).toContain("--print");
    expect(args).toContain("stream-json");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
    expect(args).toContain("--add-dir");
    expect(args).toContain("/tmp/worktree");
    expect(
      buildClaudeCodePrompt(
        {
          runId: "run",
          taskId: "task",
          title: "Task",
          goal: "Goal",
          acceptanceCriteria: ["Done"],
          skills: [],
          worktreePath: "/tmp/worktree",
          outputSchemaPath: "/tmp/schema.json",
          signal: controller.signal,
        },
        "{}",
      ),
    ).toContain("最终 JSON 的 preview");

    const retryPrompt = buildClaudeCodePrompt(
      {
        runId: "retry-run",
        taskId: "task",
        title: "Task",
        goal: "Goal",
        acceptanceCriteria: ["Done"],
        skills: [],
        retryContext: {
          sourceRunId: "failed-run",
          sourceStatus: "FAILED",
          sourceRunner: "claude-code",
          sourceFinishedAt: "2026-08-19T00:00:00.000Z",
          summary: "pnpm test 因缺少断言失败",
          baseCommit: "base-commit",
          resultCommit: "partial-result-commit",
          events: [
            {
              type: "runner.command",
              message: "pnpm test 退出码 1",
              createdAt: "2026-08-19T00:00:00.000Z",
            },
          ],
        },
        worktreePath: "/tmp/worktree",
        outputSchemaPath: "/tmp/schema.json",
        signal: controller.signal,
      },
      "{}",
    );
    expect(retryPrompt).toContain("上一轮未完成执行的恢复上下文");
    expect(retryPrompt).toContain("pnpm test 因缺少断言失败");
    expect(retryPrompt).toContain("从失败点继续排查和实施");

    const researchPrompt = buildClaudeCodePrompt(
      {
        runId: "research-run",
        taskId: "research-task",
        taskType: "RESEARCH",
        title: "Research",
        goal: "Fetch public information",
        acceptanceCriteria: ["Cite sources"],
        skills: [],
        worktreePath: "/tmp/worktree",
        outputSchemaPath: "/tmp/schema.json",
        signal: controller.signal,
      },
      "{}",
    );
    expect(researchPrompt).toContain("必须先自行生成一个或多个 Python、Node.js 或 Shell 脚本");
    expect(researchPrompt).toContain("不要修改项目的受版本控制文件");
  });

  it("解析 Claude Code stream-json 事件和结构化最终结果", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-claude-runner-"));
    temporaryDirectories.push(root);
    const worktreePath = join(root, "worktree");
    const outputSchemaPath = join(root, "schema.json");
    const executablePath = join(root, "fake-claude.mjs");
    await writeFile(outputSchemaPath, "{}");
    await writeFile(
      executablePath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("claude-code test\\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write("--print --output-format --input-format --dangerously-skip-permissions --add-dir --permission-mode --verbose --include-partial-messages\\n");
  process.exit(0);
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const message = (() => {
  try {
    return JSON.parse(prompt.trim()).message.content;
  } catch {
    return prompt;
  }
})();
const isRepair = message.includes("你只负责修复已有最终结果的 JSON 格式");
const permissionModeIndex = args.indexOf("--permission-mode");
const permissionMode = permissionModeIndex >= 0 ? args[permissionModeIndex + 1] : "";
if (isRepair && permissionMode !== "plan") process.exit(4);
if (!isRepair && permissionMode !== "acceptEdits") process.exit(3);
if (!isRepair && message.includes("处理审核反馈") && (!message.includes("必须补充回归测试") || !message.includes("Skill 1: frontend-quality (v2)") || !message.includes("检查响应式布局"))) process.exit(5);
if (!isRepair && message.includes("一次性 Git Worktree") && (!message.includes("- README.md") || !message.includes("不要运行 git add、git rm") || !message.includes("统一暂存并校验冲突文件") || !message.includes("不要创建 Git commit") || !message.includes("Skill 1: frontend-quality (v2)") || !message.includes("检查响应式布局"))) process.exit(6);
if (!isRepair && !message.includes("实现真实执行")) process.exit(2);
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "session-test" }) + "\\n");
if (message.includes("上游失败")) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error", error: "502 Bad Gateway: upstream unavailable" }) + "\\n");
  process.exit(1);
}
if (message.includes("等待取消")) {
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}
if (message.includes("持续进展")) {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "step " + index }] } }) + "\\n");
  }
}
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] } }) + "\\n");
const invalidOutput = message.includes("修复仍然失败") ? "修复仍然失败" : "不是 JSON";
const finalResult = !isRepair && message.includes("模拟格式错误")
  ? invalidOutput
  : isRepair && message.includes("修复仍然失败")
    ? invalidOutput
    : JSON.stringify({
        outcome: "succeeded",
        summary: isRepair ? "格式修复完成" : "实现完成",
        acceptanceCriteria: [{ criterion: "完成开发", status: "passed", evidence: "测试通过" }],
        risks: [],
        blockedReason: null,
        preview: isRepair ? null : {
          command: "npm run dev -- --host 127.0.0.1 --port {{port}}",
          workingDirectory: "apps/web",
          healthPath: "/"
        }
      });
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: finalResult }) + "\\n");
`,
    );
    await chmod(executablePath, 0o755);
    await mkdir(worktreePath);

    const runner = new ClaudeCodeRunner({
      executable: executablePath,
      enabled: true,
      stallTimeoutMs: 5_000,
    });
    await expect(runner.detectCapabilities()).resolves.toMatchObject({
      available: true,
      version: "claude-code test",
      executablePath,
    });
    const controller = new AbortController();
    const events: string[] = [];
    const handle = runner.start(
      {
        runId: "run",
        taskId: "task",
        title: "真实执行",
        goal: "实现真实执行并处理审核反馈",
        acceptanceCriteria: ["完成开发"],
        skills: [
          {
            id: "skill-id",
            name: "frontend-quality",
            description: "检查前端质量",
            version: 2,
            contentHash: "content-hash",
            content: "# 工作流\n\n检查响应式布局。\n",
          },
        ],
        reviewFeedback: "必须补充回归测试",
        worktreePath,
        outputSchemaPath,
        signal: controller.signal,
      },
      (event) => events.push(event.message),
    );

    await expect(handle.result).resolves.toMatchObject({
      outcome: "succeeded",
      summary: "实现完成",
      preview: { workingDirectory: "apps/web" },
    });
    expect(events).toContain("Claude Code 会话已启动");
    expect(events).toContain("Claude Code 正在执行：pnpm test");
    expect(events).toContain("Claude Code 已完成本轮开发");

    const conflictHandle = runner.start(
      {
        runId: "conflict-run",
        taskId: "task",
        title: "实现真实执行",
        goal: "解决实现真实执行产生的写入冲突",
        acceptanceCriteria: ["完成开发"],
        skills: [
          {
            id: "skill-id",
            name: "frontend-quality",
            description: "检查前端质量",
            version: 2,
            contentHash: "content-hash",
            content: "# 工作流\n\n检查响应式布局。\n",
          },
        ],
        mode: "conflict-resolution",
        conflictPaths: ["README.md"],
        worktreePath,
        outputSchemaPath,
        signal: new AbortController().signal,
      },
      () => undefined,
    );
    await expect(conflictHandle.result).resolves.toMatchObject({
      outcome: "succeeded",
      summary: "实现完成",
    });

    const repairEvents: string[] = [];
    const repairHandle = runner.start(
      {
        runId: "repair-run",
        taskId: "task",
        title: "真实执行",
        goal: "实现真实执行并模拟格式错误",
        acceptanceCriteria: ["完成开发"],
        skills: [],
        worktreePath,
        outputSchemaPath,
        signal: new AbortController().signal,
      },
      (event) => repairEvents.push(event.message),
    );
    await expect(repairHandle.result).resolves.toMatchObject({
      outcome: "succeeded",
      summary: "格式修复完成",
    });
    expect(repairEvents).toContain("Claude Code 最终结果格式不符合要求，正在进行一次 JSON 修复");
    expect(repairEvents).toContain("正在启动 Claude Code JSON 格式修复");
    expect(repairEvents).toContain("Claude Code JSON 格式修复完成");

    const invalidRepairHandle = runner.start(
      {
        runId: "invalid-repair-run",
        taskId: "task",
        title: "真实执行",
        goal: "实现真实执行、模拟格式错误并让修复仍然失败",
        acceptanceCriteria: ["完成开发"],
        skills: [],
        worktreePath,
        outputSchemaPath,
        signal: new AbortController().signal,
      },
      () => undefined,
    );
    await expect(invalidRepairHandle.result).resolves.toMatchObject({
      outcome: "failed",
      summary: expect.stringContaining("两次返回均不符合 AgentResult JSON 格式"),
    });

    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    const processGroupIds: Array<number | null> = [];
    const cancelHandle = runner.start(
      {
        runId: "cancel-run",
        taskId: "task",
        title: "真实执行",
        goal: "实现真实执行并等待取消",
        acceptanceCriteria: ["完成开发"],
        skills: [],
        worktreePath,
        outputSchemaPath,
        signal: new AbortController().signal,
        onProcessGroupId: (processGroupId) => processGroupIds.push(processGroupId),
      },
      (event) => {
        if (event.message === "Claude Code 会话已启动") executionStarted();
      },
    );
    await started;
    expect(processGroupIds[0]).toEqual(expect.any(Number));
    cancelHandle.cancel();
    await expect(cancelHandle.result).rejects.toMatchObject({ name: "AbortError" });
    expect(processGroupIds.at(-1)).toBeNull();

    const stallRunner = new ClaudeCodeRunner({
      executable: executablePath,
      enabled: true,
      stallTimeoutMs: 100,
    });
    const stallHandle = stallRunner.start(
      {
        runId: "stall-run",
        taskId: "task",
        title: "真实执行",
        goal: "实现真实执行并等待取消",
        acceptanceCriteria: ["完成开发"],
        skills: [],
        worktreePath,
        outputSchemaPath,
        signal: new AbortController().signal,
      },
      () => undefined,
    );
    await expect(stallHandle.result).resolves.toMatchObject({
      outcome: "failed",
      summary: expect.stringContaining("疑似卡死"),
    });

    const blockedHandle = runner.start(
      {
        runId: "blocked-run",
        taskId: "task",
        title: "真实执行",
        goal: "实现真实执行并模拟上游失败",
        acceptanceCriteria: ["完成开发"],
        skills: [],
        worktreePath,
        outputSchemaPath,
        signal: new AbortController().signal,
      },
      () => undefined,
    );
    await expect(blockedHandle.result).resolves.toMatchObject({
      outcome: "blocked",
      blockedReason: expect.stringContaining("502 Bad Gateway"),
    });
  });
});
