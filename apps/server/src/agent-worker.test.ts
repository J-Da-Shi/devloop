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
  cancelCount = 0;
  private readonly pending: Array<{
    resolve: (result: RunnerResult) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(
    id = "controlled",
    private readonly ignoreCancellation = false,
  ) {
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
    const pending = { resolve: resolveResult, reject: rejectResult };
    this.pending.push(pending);

    return {
      result,
      cancel: () => {
        this.cancelCount += 1;
        if (this.ignoreCancellation) {
          return;
        }
        const index = this.pending.indexOf(pending);
        if (index >= 0) {
          this.pending.splice(index, 1);
        }
        rejectResult(new DOMException("任务已取消", "AbortError"));
      },
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
  readonly fetched: string[] = [];
  readonly resolvedLocal: Array<{
    repositoryPath: string;
    targetBranch: string;
    fallbackRef: string;
  }> = [];
  readonly created: Array<{
    repositoryPath: string;
    worktreePath: string;
    branchName: string;
    baseCommit: string;
  }> = [];
  readonly committed: Array<{ worktreePath: string; message: string }> = [];

  async fetchRepository(repositoryPath: string): Promise<void> {
    this.fetched.push(repositoryPath);
  }

  async resolveRemoteTargetBase(input: {
    repositoryPath: string;
    targetBranch: string;
    fallbackRef: string;
  }): Promise<{ targetBranch: string; baseCommit: string; branchExists: boolean }> {
    return {
      targetBranch: input.targetBranch,
      baseCommit: input.targetBranch === "main" ? "base-commit" : "fallback-commit",
      branchExists: input.targetBranch === "main",
    };
  }

  async resolveTargetBase(input: {
    repositoryPath: string;
    targetBranch: string;
    fallbackRef: string;
  }): Promise<{ targetBranch: string; baseCommit: string; branchExists: boolean }> {
    this.resolvedLocal.push(input);
    return {
      targetBranch: input.targetBranch,
      baseCommit: "local-base-commit",
      branchExists: true,
    };
  }

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
    targetBranch: "main",
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
      repositoryUrl: "git@example.com:team/agent-worker.git",
      repositoryPath: "/tmp/devloop-agent-worker-test",
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
      repositoryUrl: "git@example.com:team/agent-worker-paused.git",
      repositoryPath: "/tmp/devloop-agent-worker-paused-test",
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
      repositoryUrl: "git@example.com:team/agent-worker-failure.git",
      repositoryPath: "/tmp/devloop-agent-worker-failure-test",
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
      repositoryUrl: "git@example.com:team/agent-worker-delay.git",
      repositoryPath: "/tmp/devloop-agent-worker-delay-test",
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

  it("取消当前执行后不会被迟到结果覆盖，并可继续领取下一条任务", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "取消执行测试项目",
      repositoryUrl: "git@example.com:team/agent-worker-cancel.git",
      repositoryPath: "/tmp/devloop-agent-worker-cancel-test",
      defaultBaseRef: "main",
      headCommit: "test-base-commit",
    }).value;
    const first = createReadyTask(repository, project.id, "需要取消的任务", 80);
    const second = createReadyTask(repository, project.id, "取消后继续的任务", 40);
    const runner = new ControlledRunner("controlled", true);
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    const running = repository.getTask(first.id);
    expect(running?.status).toBe("RUNNING");

    worker.cancelTask(first.id, "local-desktop", running!.version, randomUUID());
    await waitForTaskStatus(repository, first.id, "CANCELLED");
    expect(runner.cancelCount).toBe(1);
    expect(repository.getRun(running!.latestRunId!)?.status).toBe("CANCELLED");
    expect(worker.pullNextTask()).toBe(false);

    runner.succeedNext();

    await waitFor(() => worker.pullNextTask());
    expect(runner.inputs[1]?.taskId).toBe(second.id);
    runner.succeedNext();
    await waitForTaskStatus(repository, second.id, "REVIEW");
    expect(repository.getTask(first.id)?.status).toBe("CANCELLED");
  });

  it("审核驳回后把 Revision 反馈传给下一次执行器", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "审核反馈 Worker 测试项目",
      repositoryUrl: "git@example.com:team/worker-review-feedback.git",
      repositoryPath: "/tmp/devloop-worker-review-feedback-test",
      defaultBaseRef: "main",
      headCommit: "test-base-commit",
    }).value;
    const ready = createReadyTask(repository, project.id, "处理审核反馈", 80);
    const firstClaim = repository.claimNextTask("controlled", "9999-12-31T23:59:59.999Z");
    expect(firstClaim).not.toBeNull();
    const completed = repository.completeRun(
      firstClaim!.value.run.id,
      firstClaim!.value.run.executionToken,
      "第一轮执行完成",
    ).value;
    const feedback = "需要补充异常路径测试";
    const rejected = repository.rejectRun(
      firstClaim!.value.run.id,
      "instance-owner",
      completed.task.version,
      randomUUID(),
      feedback,
    ).value;
    const runner = new ControlledRunner();
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      now: () => Date.parse(rejected.updatedAt) + 1,
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    expect(runner.inputs[0]).toMatchObject({
      title: "处理审核反馈",
      goal: "完成 处理审核反馈",
      acceptanceCriteria: ["任务被 AgentWorker 正确领取"],
      reviewFeedback: feedback,
    });

    runner.succeedNext();
    await waitForTaskStatus(repository, ready.id, "REVIEW");
  });

  it("Codex 执行前创建 Worktree，成功后保存结果 Commit", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "Codex 测试项目",
      repositoryUrl: "git@example.com:team/codex-worker.git",
      repositoryPath: "/tmp/devloop-codex-worker-project",
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
    expect(gitService.fetched).toEqual(["/tmp/devloop-codex-worker-project"]);
    expect(gitService.created[0]).toMatchObject({
      repositoryPath: "/tmp/devloop-codex-worker-project",
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
      targetBranch: "main",
      baseCommit: "base-commit",
      resultCommit: "result-commit",
      branchName: `devloop/run/${runId}`,
    });
    expect(gitService.committed[0]?.message).toBe("DevLoop: 真实 Codex 执行");
    expect(repository.getRunEvents(runId ?? "").map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.workspace_ready", "runner.verifying", "runner.review"]),
    );
  });

  it("本地项目使用本地分支准备 Worktree，不执行远程 fetch", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "本地 Codex 项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-local-codex-project",
      defaultBaseRef: "main",
      headCommit: "local-base-commit",
      lastFetchedAt: null,
    }).value;
    const task = createReadyTask(repository, project.id, "执行本地项目", 100);
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

    expect(gitService.fetched).toEqual([]);
    expect(gitService.resolvedLocal).toEqual([
      {
        repositoryPath: "/tmp/devloop-local-codex-project",
        targetBranch: "main",
        fallbackRef: "main",
      },
    ]);
    expect(gitService.created[0]).toMatchObject({
      repositoryPath: "/tmp/devloop-local-codex-project",
      branchName: `devloop/run/${runId}`,
      baseCommit: "local-base-commit",
    });

    runner.succeedNext();
    await waitForTaskStatus(repository, task.id, "REVIEW");
  });
});
