import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DevLoopRepository, openDatabase, type DatabaseHandle } from "@devloop/db";
import type { RunnerCapabilities, TaskStatus } from "@devloop/shared";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerHandle,
  RunnerInput,
  RunnerResult,
} from "@devloop/runners";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorker } from "./agent-worker.js";
import { DomainEventBus } from "../infrastructure/event-bus.js";

const migrationsFolder = fileURLToPath(new URL("../../../../packages/db/drizzle", import.meta.url));
const handles: DatabaseHandle[] = [];

class ControlledRoleRunner implements AgentRunner {
  readonly id = "controlled-role";
  readonly inputs: RunnerInput[] = [];
  private readonly pending: Array<(result: RunnerResult) => void> = [];

  async detectCapabilities(): Promise<RunnerCapabilities> {
    return {
      id: this.id,
      available: true,
      version: "test",
      executablePath: null,
      features: [],
      error: null,
    };
  }

  start(input: RunnerInput, emit: (event: RunnerEvent) => void): RunnerHandle {
    this.inputs.push(input);
    emit({ type: "runner.agent", message: "角色阶段已启动" });
    let resolveResult!: (result: RunnerResult) => void;
    const result = new Promise<RunnerResult>((resolve) => {
      resolveResult = resolve;
    });
    this.pending.push(resolveResult);
    return { result, cancel: () => undefined };
  }

  succeedNext(result: Partial<RunnerResult> = {}): void {
    this.pending.shift()?.({ outcome: "succeeded", summary: "阶段完成", risks: [], ...result });
  }
}

const createRepository = (): DevLoopRepository => {
  const handle = openDatabase({ filePath: ":memory:", migrationsFolder });
  handles.push(handle);
  return new DevLoopRepository(handle);
};

const createReadyTask = (repository: DevLoopRepository, projectId: string) => {
  const draft = repository.createTask({
    projectId,
    targetBranch: "main",
    title: "验证角色职责分离",
    goal: "按规划、执行、验收顺序处理任务",
    acceptanceCriteria: ["任务被 AgentWorker 正确领取"],
    priority: 100,
  }).value;
  return repository.confirmTask(draft.id, "role-test", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待角色阶段超时");
};

const waitForStatus = async (
  repository: DevLoopRepository,
  taskId: string,
  status: TaskStatus,
): Promise<void> => waitFor(() => repository.getTask(taskId)?.status === status);

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

describe("Agent role pipeline", () => {
  it("按规划、执行、验收职责串行运行并持久化阶段结果", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "角色流水线项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-role-pipeline",
      defaultBaseRef: "main",
      headCommit: "base-commit",
    }).value;
    const task = createReadyTask(repository, project.id);
    const runner = new ControlledRoleRunner();
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      rolePipelineEnabled: true,
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    expect(runner.inputs[0]?.role).toBe("planner");
    runner.succeedNext({
      plan: {
        summary: "先确认实现边界，再执行和验收",
        steps: [
          { id: "step-1", description: "完成角色流水线", files: [], verification: "运行测试" },
        ],
        acceptanceCriteria: ["规划验收标准已传递给执行和验收 Agent"],
        assumptions: [],
        risks: [],
      },
    });
    await waitFor(() => runner.inputs.length === 2);
    expect(runner.inputs[1]?.role).toBe("executor");
    expect(runner.inputs[1]?.plan?.summary).toBe("先确认实现边界，再执行和验收");
    expect(runner.inputs[1]?.plan?.acceptanceCriteria).toEqual([
      "规划验收标准已传递给执行和验收 Agent",
    ]);
    runner.succeedNext({ summary: "执行阶段完成" });
    await waitFor(() => runner.inputs.length === 3);
    expect(runner.inputs[2]?.role).toBe("verifier");
    expect(runner.inputs[2]?.executionResult?.summary).toBe("执行阶段完成");
    expect(runner.inputs[2]?.plan?.acceptanceCriteria).toEqual([
      "规划验收标准已传递给执行和验收 Agent",
    ]);
    runner.succeedNext({
      verification: {
        status: "passed",
        summary: "所有标准均已核对",
        criteria: [
          { criterion: "任务被 AgentWorker 正确领取", status: "passed", evidence: "测试通过" },
          {
            criterion: "规划验收标准已传递给执行和验收 Agent",
            status: "passed",
            evidence: "执行和验收阶段均收到计划",
          },
        ],
        checks: [],
        issues: [],
      },
    });

    await waitForStatus(repository, task.id, "REVIEW");
    const run = repository.getRun(repository.getTask(task.id)?.latestRunId ?? "");
    expect(run?.plan?.summary).toBe("先确认实现边界，再执行和验收");
    expect(run?.verification?.status).toBe("passed");
    expect(repository.getRunEvents(run?.id ?? "").map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.agent.planning.started",
        "run.agent.planning.completed",
        "run.agent.execution.started",
        "run.agent.execution.completed",
        "run.agent.verification.started",
        "run.agent.verification.completed",
      ]),
    );
  });

  it("验收 Agent 发现问题时不会进入待审核", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "验收失败项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-role-pipeline-failed",
      defaultBaseRef: "main",
      headCommit: "base-commit",
    }).value;
    const task = createReadyTask(repository, project.id);
    const runner = new ControlledRoleRunner();
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      rolePipelineEnabled: true,
      rolePipelineMaxRepairAttempts: 0,
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    runner.succeedNext({
      plan: {
        summary: "失败验收测试计划",
        steps: [{ id: "step-1", description: "执行任务", files: [], verification: "运行测试" }],
        acceptanceCriteria: ["执行结果必须通过独立验证"],
        assumptions: [],
        risks: [],
      },
    });
    await waitFor(() => runner.inputs.length === 2);
    runner.succeedNext();
    await waitFor(() => runner.inputs.length === 3);
    expect(runner.inputs[2]?.role).toBe("verifier");
    runner.succeedNext({
      verification: {
        status: "failed",
        summary: "验收标准未满足",
        criteria: [
          { criterion: "任务被 AgentWorker 正确领取", status: "failed", evidence: "检查命令失败" },
          { criterion: "执行结果必须通过独立验证", status: "failed", evidence: "检查命令失败" },
        ],
        checks: [{ command: "pnpm test", status: "failed", evidence: "退出码 1" }],
        issues: ["存在未修复的回归问题"],
      },
    });

    await waitForStatus(repository, task.id, "FAILED");
    const run = repository.getRun(repository.getTask(task.id)?.latestRunId ?? "");
    expect(run?.verification?.status).toBe("failed");
    expect(run?.status).toBe("FAILED");
  });

  it("验收报告漏掉规划标准时回退执行并在修复后进入待审核", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "规划标准缺失项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-role-pipeline-missing-criteria",
      defaultBaseRef: "main",
      headCommit: "base-commit",
    }).value;
    const task = createReadyTask(repository, project.id);
    const runner = new ControlledRoleRunner();
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      rolePipelineEnabled: true,
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    runner.succeedNext({
      plan: {
        summary: "需要额外核对规划结果",
        steps: [{ id: "step-1", description: "执行任务", files: [], verification: "运行测试" }],
        acceptanceCriteria: ["规划标准必须在验收报告中逐项出现"],
        assumptions: [],
        risks: [],
      },
    });
    await waitFor(() => runner.inputs.length === 2);
    runner.succeedNext();
    await waitFor(() => runner.inputs.length === 3);
    runner.succeedNext({
      verification: {
        status: "failed",
        summary: "原始任务标准未满足",
        criteria: [
          { criterion: "任务被 AgentWorker 正确领取", status: "failed", evidence: "检查失败" },
        ],
        checks: [],
        issues: [],
      },
    });

    await waitFor(() => runner.inputs.length === 4);
    expect(runner.inputs[3]?.role).toBe("executor");
    expect(runner.inputs[3]?.verificationFeedback?.issues).toEqual([
      "验收标准未在验收报告中逐项出现：规划标准必须在验收报告中逐项出现",
    ]);
    runner.succeedNext({ summary: "已补齐规划验收标准" });
    await waitFor(() => runner.inputs.length === 5);
    expect(runner.inputs[4]?.role).toBe("verifier");
    runner.succeedNext({
      verification: {
        status: "passed",
        summary: "两组标准均已核对",
        criteria: [
          { criterion: "任务被 AgentWorker 正确领取", status: "passed", evidence: "检查通过" },
          {
            criterion: "规划标准必须在验收报告中逐项出现",
            status: "passed",
            evidence: "报告已补齐",
          },
        ],
        checks: [],
        issues: [],
      },
    });

    await waitForStatus(repository, task.id, "REVIEW");
    const run = repository.getRun(repository.getTask(task.id)?.latestRunId ?? "");
    expect(run?.verification?.status).toBe("passed");
    expect(run?.status).toBe("SUCCEEDED");
  });
});
