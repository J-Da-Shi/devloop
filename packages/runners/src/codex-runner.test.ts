import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRunner } from "./codex-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CodexRunner", () => {
  it("builds a non-interactive workspace-write command", () => {
    const runner = new CodexRunner({ ignoreUserConfig: true });
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

    expect(args).toContain("--ignore-user-config");
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("workspace-write");
    expect(args).not.toContain("--output-schema");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("解析 Codex JSONL 事件和结构化最终结果", async () => {
    const root = await mkdtemp(join(tmpdir(), "devloop-codex-runner-"));
    temporaryDirectories.push(root);
    const worktreePath = join(root, "worktree");
    const outputSchemaPath = join(root, "schema.json");
    const executablePath = join(root, "fake-codex.mjs");
    await writeFile(outputSchemaPath, "{}");
    await writeFile(
      executablePath,
      `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli test\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in\\n");
  process.exit(0);
}
if (args[0] === "exec" && args.includes("--help")) {
  process.stdout.write("--json --output-schema --output-last-message --sandbox --cd --ephemeral --ignore-user-config --ignore-rules --strict-config --config --disable\\n");
  process.exit(0);
}
const outputIndex = args.indexOf("--output-last-message");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const isRepair = prompt.includes("你只负责修复已有最终结果的 JSON 格式");
if (args.includes("--output-schema")) process.exit(3);
if (isRepair && (!args.includes("shell_tool") || !args.includes("unified_exec"))) process.exit(4);
if (!isRepair && prompt.includes("处理审核反馈") && (!prompt.includes("必须补充回归测试") || !prompt.includes("Skill 1: frontend-quality (v2)") || !prompt.includes("检查响应式布局"))) process.exit(5);
if (!isRepair && prompt.includes("一次性 Git Worktree") && (!prompt.includes("- README.md") || !prompt.includes("不要运行 git add、git rm") || !prompt.includes("统一暂存并校验冲突文件") || !prompt.includes("不要创建 Git commit") || !prompt.includes("Skill 1: frontend-quality (v2)") || !prompt.includes("检查响应式布局"))) process.exit(6);
if ((!isRepair && !prompt.includes("实现真实执行")) || outputIndex < 0) process.exit(2);
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-test" }) + "\\n");
if (prompt.includes("上游失败")) {
  process.stdout.write(JSON.stringify({ type: "error", message: "502 Bad Gateway: upstream unavailable" }) + "\\n");
  process.exit(1);
}
if (prompt.includes("等待取消")) {
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}
if (prompt.includes("持续进展")) {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "reasoning", index } }) + "\\n");
  }
}
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "pnpm test" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", exit_code: 0 } }) + "\\n");
const invalidOutput = prompt.includes("修复仍然失败") ? "修复仍然失败" : "不是 JSON";
const output = !isRepair && prompt.includes("模拟格式错误")
  ? invalidOutput
  : isRepair && prompt.includes("修复仍然失败")
    ? invalidOutput
    : JSON.stringify({
        outcome: "succeeded",
        summary: isRepair ? "格式修复完成" : "实现完成",
        acceptanceCriteria: [{ criterion: "完成开发", status: "passed", evidence: "测试通过" }],
        risks: [],
        blockedReason: null
      });
await writeFile(args[outputIndex + 1], output);
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`,
    );
    await chmod(executablePath, 0o755);
    await mkdir(worktreePath);

    const runner = new CodexRunner({
      executable: executablePath,
      enabled: true,
      stallTimeoutMs: 5_000,
    });
    await expect(runner.detectCapabilities()).resolves.toMatchObject({
      available: true,
      version: "codex-cli test",
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
    });
    expect(events).toContain("Codex 会话已启动");
    expect(events).toContain("Codex 正在执行：pnpm test");
    expect(events).toContain("Codex 已完成本轮开发");

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
    expect(repairEvents).toContain("Codex 最终结果格式不符合要求，正在进行一次 JSON 修复");
    expect(repairEvents).toContain("正在启动 Codex JSON 格式修复");
    expect(repairEvents).toContain("Codex JSON 格式修复完成");

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
        if (event.message === "Codex 会话已启动") executionStarted();
      },
    );
    await started;
    expect(processGroupIds[0]).toEqual(expect.any(Number));
    cancelHandle.cancel();
    await expect(cancelHandle.result).rejects.toMatchObject({ name: "AbortError" });
    expect(processGroupIds.at(-1)).toBeNull();

    const progressRunner = new CodexRunner({
      executable: executablePath,
      enabled: true,
      stallTimeoutMs: 500,
    });
    const progressHandle = progressRunner.start(
      {
        runId: "progress-run",
        taskId: "task",
        title: "真实执行",
        goal: "实现真实执行并持续进展",
        acceptanceCriteria: ["完成开发"],
        skills: [],
        worktreePath,
        outputSchemaPath,
        signal: new AbortController().signal,
      },
      () => undefined,
    );
    await expect(progressHandle.result).resolves.toMatchObject({ outcome: "succeeded" });

    const stallRunner = new CodexRunner({
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
