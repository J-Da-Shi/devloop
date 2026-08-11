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
import { DomainEventBus } from "./event-bus.js";

const migrationsFolder = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

class ControlledRunner implements AgentRunner {
  readonly id: string;
  readonly inputs: RunnerInput[] = [];
  private readonly pending: Array<{
    resolve: (result: RunnerResult) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(id = "controlled") {
    this.id = id;
  }

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
    emit({ type: "runner.preparing", message: "准备执行测试任务" });

    let resolveResult!: (result: RunnerResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<RunnerResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.pending.push({ resolve: resolveResult, reject: rejectResult });

    return {
      result,
      cancel: () => rejectResult(new DOMException("任务已取消", "AbortError")),
    };
  }

  succeedNext(): void {
    this.pending.shift()?.resolve({
      outcome: "succeeded",
      summary: "测试任务执行完成",
      risks: [],
    });
  }
}

class ControlledGitService {
  readonly created: Array<{
    repositoryPath: string;
    worktreePath: string;
    branchName: string;
    baseCommit: string;
  }> = [];
  readonly committed: Array<{ worktreePath: string; message: string }> = [];

  async createWorktree(input: (typeof this.created)[number]): Promise<void> {
    this.created.push(input);
  }

  async commitWorktree(input: (typeof this.committed)[number]): Promise<string> {
    this.committed.push(input);
    return "result-commit";
  }
}

class StartFailureRunner implements AgentRunner {
  readonly id = "start-failure";

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

  start(): RunnerHandle {
    throw new Error("执行器启动失败");
  }
}

const handles: DatabaseHandle[] = [];

const createRepository = (): DevLoopRepository => {
  const handle = openDatabase({ filePath: ":memory:", migrationsFolder });
  handles.push(handle);
  return new DevLoopRepository(handle);
};

const createReadyTask = (
  repository: DevLoopRepository,
  projectId: string,
  title: string,
  priority: number,
) => {
  const draft = repository.createTask({
    projectId,
    title,
    goal: `完成 ${title}`,
    acceptanceCriteria: ["任务被 AgentWorker 正确领取"],
    priority,
  }).value;
  return repository.confirmTask(draft.id, "local-desktop", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  }).value;
};

const waitForTaskStatus = async (
  repository: DevLoopRepository,
  taskId: string,
  status: TaskStatus,
): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (repository.getTask(taskId)?.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待任务进入 ${status} 状态超时`);
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待测试条件满足超时");
};

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
});

describe("AgentWorker", () => {
  it("优先领取高优先级任务，并在执行期间拒绝重复领取", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "测试项目",
      path: "/tmp/devloop-agent-worker-test",
      defaultBaseRef: "main",
      headCommit: "test-base-commit",
    }).value;
    const lowPriority = createReadyTask(repository, project.id, "低优先级任务", 20);
    const highPriority = createReadyTask(repository, project.id, "高优先级任务", 90);
    const runner = new ControlledRunner();
    const eventBus = new DomainEventBus();
    const eventTypes: string[] = [];
    eventBus.subscribe((event) => eventTypes.push(event.type));
    const worker = new AgentWorker(repository, runner, eventBus, "/tmp/schema.json", {
      claimDelayMs: 0,
    });

    expect(worker.pullNextTask()).toBe(true);
    expect(runner.inputs[0]?.taskId).toBe(highPriority.id);
    expect(repository.getTask(highPriority.id)?.status).toBe("RUNNING");
    expect(repository.getTask(lowPriority.id)?.status).toBe("READY");
    expect(repository.getWorkerState().activeRunId).not.toBeNull();
    expect(worker.pullNextTask()).toBe(false);
    expect(eventTypes).toContain("run.started");

    runner.succeedNext();
    await waitForTaskStatus(repository, highPriority.id, "REVIEW");
    expect(repository.getWorkerState().activeRunId).toBeNull();

    expect(worker.pullNextTask()).toBe(true);
    expect(runner.inputs[1]?.taskId).toBe(lowPriority.id);
    runner.succeedNext();
    await waitForTaskStatus(repository, lowPriority.id, "REVIEW");
  });

  it("暂停状态下不领取待执行任务", () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "测试项目",
      path: "/tmp/devloop-agent-worker-paused-test",
      defaultBaseRef: "main",
      headCommit: "test-base-commit",
    }).value;
    const task = createReadyTask(repository, project.id, "暂停时保留任务", 50);
    const runner = new ControlledRunner();
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
    });

    worker.setStatus("PAUSED");

    expect(worker.pullNextTask()).toBe(false);
    expect(repository.getTask(task.id)?.status).toBe("READY");
    expect(runner.inputs).toHaveLength(0);
  });

  it("执行器启动失败时将任务标记为失败并释放 Worker", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "测试项目",
      path: "/tmp/devloop-agent-worker-failure-test",
      defaultBaseRef: "main",
      headCommit: "test-base-commit",
    }).value;
    const first = createReadyTask(repository, project.id, "启动失败任务一", 80);
    const second = createReadyTask(repository, project.id, "启动失败任务二", 40);
    const worker = new AgentWorker(
      repository,
      new StartFailureRunner(),
      new DomainEventBus(),
      "/tmp/schema.json",
      { claimDelayMs: 0 },
    );

    expect(worker.pullNextTask()).toBe(true);
    await waitForTaskStatus(repository, first.id, "FAILED");
    expect(repository.getWorkerState().activeRunId).toBeNull();

    expect(worker.pullNextTask()).toBe(true);
    await waitForTaskStatus(repository, second.id, "FAILED");
    expect(repository.getWorkerState().activeRunId).toBeNull();
  });

  it("任务进入待执行五秒后才允许领取", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "测试项目",
      path: "/tmp/devloop-agent-worker-delay-test",
      defaultBaseRef: "main",
      headCommit: "test-base-commit",
    }).value;
    const task = createReadyTask(repository, project.id, "等待领取任务", 50);
    const runner = new ControlledRunner();
    let currentTime = Date.parse(task.updatedAt);
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 5_000,
      now: () => currentTime,
    });

    expect(worker.pullNextTask()).toBe(false);
    expect(repository.getTask(task.id)?.status).toBe("READY");

    currentTime += 4_999;
    expect(worker.pullNextTask()).toBe(false);
    expect(repository.getTask(task.id)?.status).toBe("READY");

    currentTime += 1;
    expect(worker.pullNextTask()).toBe(true);
    expect(repository.getTask(task.id)?.status).toBe("RUNNING");
    runner.succeedNext();
    await waitForTaskStatus(repository, task.id, "REVIEW");
  });

  it("Codex 执行前创建 Worktree，成功后保存结果 Commit", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "Codex 测试项目",
      path: "/tmp/devloop-codex-worker-project",
      defaultBaseRef: "main",
      headCommit: "base-commit",
    }).value;
    const task = createReadyTask(repository, project.id, "真实 Codex 执行", 100);
    const runner = new ControlledRunner("codex");
    const gitService = new ControlledGitService();
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      runnerVersion: "codex-cli test",
      gitService,
      worktreesPath: "/tmp/devloop-worker-worktrees",
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    const runId = repository.getTask(task.id)?.latestRunId;
    expect(runId).toBeTruthy();
    expect(gitService.created[0]).toMatchObject({
      repositoryPath: project.path,
      branchName: `devloop/run/${runId}`,
      baseCommit: "base-commit",
    });
    expect(runner.inputs[0]).toMatchObject({
      taskId: task.id,
      acceptanceCriteria: ["任务被 AgentWorker 正确领取"],
      worktreePath: `/tmp/devloop-worker-worktrees/${runId}`,
    });

    runner.succeedNext();
    await waitForTaskStatus(repository, task.id, "REVIEW");
    const run = runId ? repository.getRun(runId) : null;
    expect(run).toMatchObject({
      runner: "codex",
      runnerVersion: "codex-cli test",
      resultCommit: "result-commit",
      branchName: `devloop/run/${runId}`,
    });
    expect(gitService.committed[0]?.message).toBe("DevLoop: 真实 Codex 执行");
    expect(repository.getRunEvents(runId ?? "").map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.workspace_ready", "runner.verifying", "runner.review"]),
    );
  });
});
