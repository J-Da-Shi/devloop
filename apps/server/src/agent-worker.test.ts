import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DevLoopRepository, openDatabase, type DatabaseHandle } from "@devloop/db";
import type {
  ConflictResolutionWorkspace,
  GitExecutionOptions,
  MoveWorktreeToCommitInput,
  ReconcileCommitInput,
  ReconcileCommitResult,
} from "@devloop/git";
import type { RunnerCapabilities, TaskStatus } from "@devloop/shared";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerHandle,
  RunnerInput,
  RunnerResult,
  RunnerSkill,
} from "@devloop/runners";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorker } from "./agent-worker.js";
import { DomainEventBus } from "./event-bus.js";
import type { ValidateRunInput } from "./playwright-validation-service.js";

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

  succeedNext(result: Partial<RunnerResult> = {}): void {
    this.pending.shift()?.resolve({
      outcome: "succeeded",
      summary: "测试任务执行完成",
      risks: [],
      ...result,
    });
  }

  blockNext(): void {
    this.pending.shift()?.resolve({
      outcome: "blocked",
      summary: "冲突无法自动解决",
      risks: [],
      blockedReason: "需要人工判断业务语义",
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
  readonly reconciled: ReconcileCommitInput[] = [];
  readonly moved: MoveWorktreeToCommitInput[] = [];
  readonly remoteBaseCommits: string[] = [];
  readonly localBaseCommits: string[] = [];
  reconciliationResult: ReconcileCommitResult | null = null;
  readonly signals: AbortSignal[] = [];

  protected recordExecution(execution: GitExecutionOptions): void {
    if (execution.signal) {
      this.signals.push(execution.signal);
    }
  }

  async fetchRepository(
    repositoryPath: string,
    execution: GitExecutionOptions = {},
  ): Promise<void> {
    this.fetched.push(repositoryPath);
    this.recordExecution(execution);
  }

  async resolveRemoteTargetBase(input: {
    repositoryPath: string;
    targetBranch: string;
    fallbackRef: string;
    signal?: AbortSignal;
    onProcessGroupId?: (processGroupId: number | null) => void;
  }): Promise<{ targetBranch: string; baseCommit: string; branchExists: boolean }> {
    const configuredCommit = this.remoteBaseCommits.shift();
    this.recordExecution(input);
    return {
      targetBranch: input.targetBranch,
      baseCommit:
        configuredCommit ?? (input.targetBranch === "main" ? "base-commit" : "fallback-commit"),
      branchExists: input.targetBranch === "main",
    };
  }

  async resolveTargetBase(input: {
    repositoryPath: string;
    targetBranch: string;
    fallbackRef: string;
    signal?: AbortSignal;
    onProcessGroupId?: (processGroupId: number | null) => void;
  }): Promise<{ targetBranch: string; baseCommit: string; branchExists: boolean }> {
    this.recordExecution(input);
    this.resolvedLocal.push({
      repositoryPath: input.repositoryPath,
      targetBranch: input.targetBranch,
      fallbackRef: input.fallbackRef,
    });
    return {
      targetBranch: input.targetBranch,
      baseCommit: this.localBaseCommits.shift() ?? "local-base-commit",
      branchExists: true,
    };
  }

  async createWorktree(input: (typeof this.created)[number] & GitExecutionOptions): Promise<void> {
    this.recordExecution(input);
    this.created.push({
      repositoryPath: input.repositoryPath,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseCommit: input.baseCommit,
    });
  }

  async commitWorktree(
    input: (typeof this.committed)[number] & GitExecutionOptions,
  ): Promise<string> {
    this.recordExecution(input);
    this.committed.push({ worktreePath: input.worktreePath, message: input.message });
    return "result-commit";
  }

  async reconcileCommitConflicts(
    input: ReconcileCommitInput,
    resolver: (workspace: ConflictResolutionWorkspace) => Promise<void>,
  ): Promise<ReconcileCommitResult> {
    this.reconciled.push(input);
    const result =
      this.reconciliationResult ??
      ({
        status: "clean",
        targetCommit: input.targetCommit,
        resultCommit: input.resultCommit,
        resolutions: [],
      } satisfies ReconcileCommitResult);
    if (result.status === "clean") {
      return result;
    }
    await resolver({
      worktreePath: "/tmp/devloop-worker-conflict-worktree",
      files: [
        {
          path: "src/app.ts",
          patch: "",
          isBinary: false,
          content: "<<<<<<< target\n=======\n>>>>>>> result\n",
          targetExists: true,
          resultExists: true,
        },
      ],
    });
    return result;
  }

  async moveWorktreeToCommit(input: MoveWorktreeToCommitInput): Promise<void> {
    this.moved.push(input);
  }
}

type BlockingGitStage = "fetch" | "worktree" | "commit";

class BlockingGitService extends ControlledGitService {
  readonly processGroupId = 424_242;
  readonly started: Promise<void>;
  signal: AbortSignal | null = null;
  private markStarted!: () => void;

  constructor(private readonly stage: BlockingGitStage) {
    super();
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  override async fetchRepository(
    repositoryPath: string,
    execution: GitExecutionOptions = {},
  ): Promise<void> {
    await super.fetchRepository(repositoryPath, execution);
    if (this.stage === "fetch") {
      await this.block(execution);
    }
  }

  override async createWorktree(
    input: (typeof this.created)[number] & GitExecutionOptions,
  ): Promise<void> {
    await super.createWorktree(input);
    if (this.stage === "worktree") {
      await this.block(input);
    }
  }

  override async commitWorktree(
    input: (typeof this.committed)[number] & GitExecutionOptions,
  ): Promise<string> {
    if (this.stage !== "commit") {
      return super.commitWorktree(input);
    }
    this.recordExecution(input);
    this.committed.push({ worktreePath: input.worktreePath, message: input.message });
    await this.block(input);
    return "result-commit";
  }

  private async block(execution: GitExecutionOptions): Promise<void> {
    const signal = execution.signal;
    if (!signal) {
      throw new Error("测试 Git 阶段缺少 AbortSignal");
    }
    this.signal = signal;
    execution.onProcessGroupId?.(this.processGroupId);
    this.markStarted();
    let abort!: () => void;
    try {
      await new Promise<void>((_resolve, reject) => {
        abort = () => reject(new DOMException("Git 阶段已取消", "AbortError"));
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
      });
    } finally {
      signal.removeEventListener("abort", abort);
      execution.onProcessGroupId?.(null);
    }
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
  autoResolveConflicts = true,
) => {
  const draft = repository.createTask({
    projectId,
    targetBranch: "main",
    title,
    goal: `完成 ${title}`,
    acceptanceCriteria: ["任务被 AgentWorker 正确领取"],
    priority,
    autoResolveConflicts,
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
  it("代码结果准备完成后自动运行 Playwright 验证再进入待审核", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "自动验证项目",
      repositoryUrl: "git@example.com:team/playwright-worker.git",
      repositoryPath: "/tmp/devloop-playwright-worker",
      defaultBaseRef: "main",
      headCommit: "base-commit",
    }).value;
    repository.updateProjectPreview(
      project.id,
      {
        previewCommand: "pnpm dev -- --port {{port}}",
        previewWorkingDirectory: "apps/web",
        previewHealthPath: "/health",
        playwrightEnabled: true,
        playwrightTestCommand: "pnpm playwright test",
        expectedVersion: project.version,
        idempotencyKey: randomUUID(),
      },
      "instance-owner",
    );
    const task = createReadyTask(repository, project.id, "自动执行页面验证", 100);
    const runner = new ControlledRunner();
    const validationInputs: ValidateRunInput[] = [];
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      playwrightValidationService: {
        validate: async (input) => {
          validationInputs.push(input);
          return {
            status: "passed",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            checks: [{ name: "页面加载", status: "passed", message: "HTTP 200" }],
            pageErrors: [],
            consoleErrors: [],
            previewConfiguration: {
              source: "project",
              command: "pnpm dev -- --port {{port}}",
              workingDirectory: "apps/web",
              healthPath: "/health",
            },
            screenshotArtifactId: randomUUID(),
            customTestOutput: null,
          };
        },
      },
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    runner.succeedNext();
    await waitForTaskStatus(repository, task.id, "REVIEW");

    expect(validationInputs).toEqual([
      expect.objectContaining({
        previewConfiguration: {
          source: "project",
          command: "pnpm dev -- --port {{port}}",
          workingDirectory: "apps/web",
          healthPath: "/health",
        },
        playwrightEnabled: true,
        playwrightTestCommand: "pnpm playwright test",
        resultCommit: "base-commit",
      }),
    ]);
    expect(
      repository.getRunEvents(repository.getTask(task.id)!.latestRunId!).map((event) => event.type),
    ).toEqual(
      expect.arrayContaining([
        "run.playwright.started",
        "run.playwright.completed",
        "run.finished",
      ]),
    );
  });

  it("没有人工覆盖时将 Agent 返回的预览建议用于自动验证", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "Agent 预览项目",
      repositoryUrl: "git@example.com:team/agent-preview.git",
      repositoryPath: "/tmp/devloop-agent-preview",
      defaultBaseRef: "main",
      headCommit: "base-commit",
    }).value;
    const task = createReadyTask(repository, project.id, "自动识别页面预览", 100);
    const runner = new ControlledRunner();
    const validationInputs: ValidateRunInput[] = [];
    const preview = {
      command: "npm run dev -- --host 127.0.0.1 --port {{port}}",
      workingDirectory: "apps/web",
      healthPath: "/",
    };
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      playwrightValidationService: {
        validate: async (input) => {
          validationInputs.push(input);
          return {
            status: "skipped",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            previewConfiguration: { source: "agent", ...preview },
            checks: [{ name: "启动预览", status: "skipped", message: "浏览器不可用" }],
            pageErrors: [],
            consoleErrors: [],
            screenshotArtifactId: null,
            customTestOutput: null,
          };
        },
      },
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    runner.succeedNext({ preview });
    await waitForTaskStatus(repository, task.id, "REVIEW");

    expect(validationInputs).toEqual([
      expect.objectContaining({ previewConfiguration: { source: "agent", ...preview } }),
    ]);
    expect(
      repository
        .getRunEvents(repository.getTask(task.id)!.latestRunId!)
        .filter((event) => event.type === "run.preview.configuration.selected")
        .map((event) => event.payload),
    ).toEqual([{ source: "agent", ...preview }]);
  });

  it("研究任务在隔离工作区执行，但不提交代码、不拉取仓库也不运行 Playwright", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "互联网研究项目",
      repositoryUrl: "git@example.com:team/research-worker.git",
      repositoryPath: "/tmp/devloop-research-worker",
      defaultBaseRef: "main",
      headCommit: "research-base-commit",
    }).value;
    const draft = repository.createTask({
      projectId: project.id,
      taskType: "RESEARCH",
      targetBranch: "main",
      title: "收集公开行业数据",
      goal: "生成脚本获取互联网内容并总结",
      acceptanceCriteria: ["总结列出来源 URL"],
      priority: 100,
    }).value;
    const task = repository.confirmTask(draft.id, "instance-owner", {
      expectedVersion: draft.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: "main",
    }).value;
    const runner = new ControlledRunner("codex");
    const gitService = new ControlledGitService();
    const validationInputs: ValidateRunInput[] = [];
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      gitService,
      worktreesPath: "/tmp/devloop-research-worktrees",
      playwrightValidationService: {
        validate: async (input) => {
          validationInputs.push(input);
          throw new Error("研究任务不应运行 Playwright");
        },
      },
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    const runId = repository.getTask(task.id)!.latestRunId!;
    expect(runner.inputs[0]).toMatchObject({
      taskType: "RESEARCH",
      worktreePath: `/tmp/devloop-research-worktrees/${runId}`,
    });
    expect(gitService.fetched).toEqual([]);
    expect(gitService.resolvedLocal).toEqual([]);
    expect(gitService.created[0]).toMatchObject({
      repositoryPath: "/tmp/devloop-research-worker",
      baseCommit: "research-base-commit",
    });

    runner.succeedNext();
    await waitForTaskStatus(repository, task.id, "REVIEW");
    expect(gitService.committed).toEqual([]);
    expect(gitService.reconciled).toEqual([]);
    expect(validationInputs).toEqual([]);
    expect(repository.getRun(runId)).toMatchObject({
      status: "SUCCEEDED",
      baseCommit: "research-base-commit",
      resultCommit: "research-base-commit",
    });
    expect(repository.getRunEvents(runId).map((event) => event.message)).toContain(
      "互联网研究已完成，正在准备总结供用户审核",
    );
  });

  it("把已启用 Skill 快照传给 Runner", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "Skill 执行项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-skill-worker-project",
      defaultBaseRef: "main",
      headCommit: "local-base-commit",
      lastFetchedAt: null,
    }).value;
    const task = createReadyTask(repository, project.id, "执行启用 Skill", 100);
    const runner = new ControlledRunner();
    const skills: RunnerSkill[] = [
      {
        id: "skill-id",
        name: "frontend-quality",
        description: "检查前端质量",
        version: 2,
        contentHash: "content-hash",
        content: "# 工作流\n\n检查响应式布局。\n",
      },
    ];
    let loadCount = 0;
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      skillService: {
        listEnabledForExecution: async () => {
          loadCount += 1;
          return skills;
        },
      },
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    expect(runner.inputs[0]).toMatchObject({ taskId: task.id, skills });
    expect(loadCount).toBe(1);
    expect(repository.getRun(repository.getTask(task.id)!.latestRunId!)).toMatchObject({
      skillSnapshot: [
        {
          skillId: "skill-id",
          version: 2,
          contentHash: "content-hash",
        },
      ],
    });

    runner.succeedNext();
    await waitForTaskStatus(repository, task.id, "REVIEW");
  });

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
    await waitFor(() => runner.inputs.length === 1);
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
    await waitFor(() => runner.inputs.length === 2);
    expect(runner.inputs[1]?.taskId).toBe(lowPriority.id);
    runner.succeedNext();
    await waitForTaskStatus(repository, lowPriority.id, "REVIEW");
  });

  it("按并发上限同时领取任务，并在槽位释放后继续领取", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "并发执行项目",
      repositoryUrl: "git@example.com:team/agent-worker-concurrency.git",
      repositoryPath: "/tmp/devloop-agent-worker-concurrency",
      defaultBaseRef: "main",
      headCommit: "test-base-commit",
    }).value;
    const first = createReadyTask(repository, project.id, "并发任务一", 100);
    const second = createReadyTask(repository, project.id, "并发任务二", 90);
    const third = createReadyTask(repository, project.id, "并发任务三", 80);
    const runner = new ControlledRunner();
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
    });
    worker.setConcurrency(2);

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 2);
    expect(runner.inputs.map((input) => input.taskId)).toEqual([first.id, second.id]);
    expect(repository.getTask(first.id)?.status).toBe("RUNNING");
    expect(repository.getTask(second.id)?.status).toBe("RUNNING");
    expect(repository.getTask(third.id)?.status).toBe("READY");
    expect(worker.pullNextTask()).toBe(false);

    worker.setConcurrency(1);
    expect(repository.getWorkerState().concurrencyLimit).toBe(1);
    expect(repository.getTask(first.id)?.status).toBe("RUNNING");
    expect(repository.getTask(second.id)?.status).toBe("RUNNING");
    runner.succeedNext();
    await waitForTaskStatus(repository, first.id, "REVIEW");
    expect(worker.pullNextTask()).toBe(false);
    expect(repository.getTask(third.id)?.status).toBe("READY");

    worker.setConcurrency(2);
    await waitFor(() => runner.inputs.length === 3);
    expect(runner.inputs[2]?.taskId).toBe(third.id);

    runner.succeedNext();
    await waitForTaskStatus(repository, second.id, "REVIEW");
    runner.succeedNext();
    await waitForTaskStatus(repository, third.id, "REVIEW");
    expect(repository.getWorkerState().activeRunIds).toHaveLength(0);
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
    await waitFor(() => runner.inputs.length === 1);
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
    await waitFor(() => runner.inputs.length === 2);
    expect(runner.inputs[1]?.taskId).toBe(second.id);
    runner.succeedNext();
    await waitForTaskStatus(repository, second.id, "REVIEW");
    expect(repository.getTask(first.id)?.status).toBe("CANCELLED");
  });

  it.each<BlockingGitStage>(["fetch", "worktree", "commit"])(
    "取消会中止 Codex 执行的 %s 阶段并终止当前进程组",
    async (stage) => {
      const repository = createRepository();
      const project = repository.createProject({
        name: `取消 ${stage} 测试项目`,
        repositoryUrl: "git@example.com:team/cancellable-worker.git",
        repositoryPath: `/tmp/devloop-agent-worker-cancel-${stage}`,
        defaultBaseRef: "main",
        headCommit: "base-commit",
      }).value;
      const task = createReadyTask(repository, project.id, `取消 ${stage}`, 100);
      const runner = new ControlledRunner("codex");
      const gitService = new BlockingGitService(stage);
      const terminatedProcessGroups: number[] = [];
      const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
        claimDelayMs: 0,
        gitService,
        worktreesPath: "/tmp/devloop-worker-worktrees",
        terminateProcessGroup: (processGroupId) => terminatedProcessGroups.push(processGroupId),
      });

      expect(worker.pullNextTask()).toBe(true);
      if (stage === "commit") {
        await waitFor(() => runner.inputs.length === 1);
        runner.succeedNext();
      }
      await gitService.started;

      const running = repository.getTask(task.id);
      const runId = running?.latestRunId;
      expect(running?.status).toBe("RUNNING");
      expect(runId).toBeTruthy();
      expect(repository.getRunProcessGroupId(runId!)).toBe(gitService.processGroupId);
      expect(gitService.signals.length).toBeGreaterThan(0);
      expect(gitService.signals.every((signal) => signal === gitService.signal)).toBe(true);
      if (stage === "commit") {
        expect(runner.inputs[0]?.signal).toBe(gitService.signal);
      }

      worker.cancelTask(task.id, "local-desktop", running!.version, randomUUID());

      await waitForTaskStatus(repository, task.id, "CANCELLED");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(gitService.signal?.aborted).toBe(true);
      expect(terminatedProcessGroups).toContain(gitService.processGroupId);
      expect(repository.getRunProcessGroupId(runId!)).toBeNull();
    },
  );

  it("服务恢复时终止并标记全部持久化遗留执行", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "进程组恢复测试项目",
      repositoryUrl: "git@example.com:team/process-group-recovery.git",
      repositoryPath: "/tmp/devloop-process-group-recovery",
      defaultBaseRef: "main",
      headCommit: "base-commit",
    }).value;
    const firstTask = createReadyTask(repository, project.id, "恢复遗留执行一", 100);
    const secondTask = createReadyTask(repository, project.id, "恢复遗留执行二", 90);
    const firstClaim = repository.claimNextTask({
      readyBefore: "9999-12-31T23:59:59.999Z",
    });
    const secondClaim = repository.claimNextTask({
      readyBefore: "9999-12-31T23:59:59.999Z",
    });
    expect(firstClaim).not.toBeNull();
    expect(secondClaim).not.toBeNull();
    const processGroupIds = [515_151, 515_152];
    repository.setRunProcessGroupId(
      firstClaim!.value.run.id,
      firstClaim!.value.run.executionToken,
      processGroupIds[0]!,
    );
    repository.setRunProcessGroupId(
      secondClaim!.value.run.id,
      secondClaim!.value.run.executionToken,
      processGroupIds[1]!,
    );
    const terminatedProcessGroups: number[] = [];
    const worker = new AgentWorker(
      repository,
      new ControlledRunner("codex"),
      new DomainEventBus(),
      "/tmp/schema.json",
      {
        claimDelayMs: 0,
        terminateProcessGroup: (id) => terminatedProcessGroups.push(id),
      },
    );

    worker.start();
    expect(terminatedProcessGroups).toHaveLength(2);
    expect(terminatedProcessGroups).toEqual(expect.arrayContaining(processGroupIds));
    expect(repository.getTask(firstTask.id)?.status).toBe("FAILED");
    expect(repository.getTask(secondTask.id)?.status).toBe("FAILED");
    expect(repository.getRunProcessGroupId(firstClaim!.value.run.id)).toBeNull();
    expect(repository.getRunProcessGroupId(secondClaim!.value.run.id)).toBeNull();
    expect(repository.getWorkerState().activeRunIds).toHaveLength(0);

    await worker.stop();
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
    const firstClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
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

  it("审核驳回后先对齐上一轮结果，再根据反馈继续执行", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "连续审核迭代项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-continuous-review-project",
      defaultBaseRef: "main",
      headCommit: "local-base-commit",
      lastFetchedAt: null,
    }).value;
    const ready = createReadyTask(repository, project.id, "连续处理审核反馈", 100);
    const firstClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
    const firstCompleted = repository.completeRun(
      firstClaim!.value.run.id,
      firstClaim!.value.run.executionToken,
      "第一轮等待审核",
      "previous-result-commit",
    ).value;
    const feedback = "保留上一轮实现，并补充异常路径测试";
    const rejected = repository.rejectRun(
      firstClaim!.value.run.id,
      "instance-owner",
      firstCompleted.task.version,
      randomUUID(),
      feedback,
    ).value;
    const runner = new ControlledRunner("codex");
    const gitService = new ControlledGitService();
    gitService.localBaseCommits.push("target-current-commit", "target-current-commit");
    gitService.reconciliationResult = {
      status: "resolved",
      targetCommit: "target-current-commit",
      resultCommit: "continued-result-commit",
      resolutions: [
        {
          path: "src/app.ts",
          strategy: "content",
          content: 'export const value = "continued";\n',
        },
      ],
    };
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      now: () => Date.parse(rejected.updatedAt) + 1,
      gitService,
      worktreesPath: "/tmp/devloop-worker-worktrees",
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    const runId = repository.getTask(ready.id)?.latestRunId;
    expect(gitService.reconciled).toEqual([
      {
        repositoryPath: "/tmp/devloop-continuous-review-project",
        targetBranch: "main",
        targetCommit: "target-current-commit",
        baseCommit: "local-base-commit",
        resultCommit: "previous-result-commit",
      },
    ]);
    expect(runner.inputs[0]).toMatchObject({
      mode: "conflict-resolution",
      conflictPaths: ["src/app.ts"],
    });

    runner.succeedNext();
    await waitFor(() => runner.inputs.length === 2);
    expect(gitService.created[0]).toMatchObject({
      branchName: `devloop/run/${runId}`,
      baseCommit: "continued-result-commit",
    });
    expect(runner.inputs[1]).toMatchObject({
      runId,
      reviewFeedback: feedback,
      worktreePath: `/tmp/devloop-worker-worktrees/${runId}`,
    });
    expect(repository.getRun(runId ?? "")?.baseCommit).toBe("target-current-commit");

    runner.succeedNext();
    await waitForTaskStatus(repository, ready.id, "REVIEW");
    expect(repository.getRun(runId ?? "")).toMatchObject({
      baseCommit: "target-current-commit",
      resultCommit: "result-commit",
      status: "SUCCEEDED",
    });
    expect(repository.getRunEvents(runId ?? "").map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.continuation.started",
        "run.conflict_resolution.completed",
        "run.continuation.prepared",
      ]),
    );
  });

  it("连续迭代存在冲突且关闭自动解决时保持阻塞", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "人工处理连续迭代冲突项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-manual-continuation-project",
      defaultBaseRef: "main",
      headCommit: "local-base-commit",
      lastFetchedAt: null,
    }).value;
    const ready = createReadyTask(repository, project.id, "人工处理连续迭代冲突", 100, false);
    const firstClaim = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
    const firstCompleted = repository.completeRun(
      firstClaim!.value.run.id,
      firstClaim!.value.run.executionToken,
      "第一轮等待审核",
      "previous-result-commit",
    ).value;
    const rejected = repository.rejectRun(
      firstClaim!.value.run.id,
      "instance-owner",
      firstCompleted.task.version,
      randomUUID(),
      "继续完善实现",
    ).value;
    const runner = new ControlledRunner("codex");
    const gitService = new ControlledGitService();
    gitService.localBaseCommits.push("target-current-commit");
    gitService.reconciliationResult = {
      status: "resolved",
      targetCommit: "target-current-commit",
      resultCommit: "continued-result-commit",
      resolutions: [],
    };
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      now: () => Date.parse(rejected.updatedAt) + 1,
      gitService,
      worktreesPath: "/tmp/devloop-worker-worktrees",
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitForTaskStatus(repository, ready.id, "BLOCKED");
    expect(runner.inputs).toHaveLength(0);
    expect(gitService.created).toHaveLength(0);
    expect(repository.getRun(repository.getTask(ready.id)?.latestRunId ?? "")?.summary).toContain(
      "任务已关闭自动解决冲突",
    );
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
    expect(gitService.fetched).toEqual([
      "/tmp/devloop-codex-worker-project",
      "/tmp/devloop-codex-worker-project",
    ]);
    const run = runId ? repository.getRun(runId) : null;
    expect(run).toMatchObject({
      runner: "codex",
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
    expect(gitService.resolvedLocal).toHaveLength(2);
  });

  it("Codex 完成开发后自动解决冲突，再把已解决 Commit 交给审核", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "自动解决冲突项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-auto-conflict-project",
      defaultBaseRef: "main",
      headCommit: "local-base-commit",
      lastFetchedAt: null,
    }).value;
    const task = createReadyTask(repository, project.id, "自动解决写入冲突", 100);
    const runner = new ControlledRunner("codex");
    const skills: RunnerSkill[] = [
      {
        id: "conflict-skill-id",
        name: "conflict-quality",
        description: "检查冲突解决结果",
        version: 3,
        contentHash: "conflict-content-hash",
        content: "# 冲突检查\n\n保留双方有效修改。\n",
      },
    ];
    let loadCount = 0;
    const gitService = new ControlledGitService();
    gitService.localBaseCommits.push("local-base-commit", "target-current-commit");
    gitService.reconciliationResult = {
      status: "resolved",
      targetCommit: "target-current-commit",
      resultCommit: "resolved-result-commit",
      resolutions: [
        {
          path: "src/app.ts",
          strategy: "content",
          content: 'export const value = "merged";\n',
        },
      ],
    };
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      gitService,
      worktreesPath: "/tmp/devloop-worker-worktrees",
      skillService: {
        listEnabledForExecution: async () => {
          loadCount += 1;
          return skills;
        },
      },
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    expect(runner.inputs[0]?.skills).toEqual(skills);
    const runId = repository.getTask(task.id)?.latestRunId;
    runner.succeedNext();
    await waitFor(() => runner.inputs.length === 2);

    expect(repository.getTask(task.id)?.status).toBe("RUNNING");
    expect(repository.getRun(runId ?? "")?.status).toBe("REPAIRING");
    expect(runner.inputs[1]).toMatchObject({
      mode: "conflict-resolution",
      conflictPaths: ["src/app.ts"],
      skills,
      worktreePath: "/tmp/devloop-worker-conflict-worktree",
    });
    expect(loadCount).toBe(1);

    runner.succeedNext();
    await waitForTaskStatus(repository, task.id, "REVIEW");
    expect(repository.getRun(runId ?? "")).toMatchObject({
      baseCommit: "target-current-commit",
      resultCommit: "resolved-result-commit",
      status: "SUCCEEDED",
    });
    expect(gitService.moved).toEqual([
      {
        worktreePath: `/tmp/devloop-worker-worktrees/${runId}`,
        expectedCommit: "result-commit",
        targetCommit: "resolved-result-commit",
      },
    ]);
    expect(repository.getRunEvents(runId ?? "").map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.conflict_check.started",
        "run.conflict_resolution.started",
        "run.conflict_resolution.progress",
        "run.conflict_resolution.completed",
        "run.finished",
      ]),
    );
  });

  it("目标分支无冲突前进时先对齐最新 Commit 再进入待审核", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "无冲突对齐项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-clean-reconcile-project",
      defaultBaseRef: "main",
      headCommit: "local-base-commit",
      lastFetchedAt: null,
    }).value;
    const task = createReadyTask(repository, project.id, "对齐最新目标分支", 100);
    const runner = new ControlledRunner("codex");
    const gitService = new ControlledGitService();
    gitService.localBaseCommits.push("local-base-commit", "target-current-commit");
    gitService.reconciliationResult = {
      status: "clean",
      targetCommit: "target-current-commit",
      resultCommit: "clean-reconciled-result-commit",
      resolutions: [],
    };
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      gitService,
      worktreesPath: "/tmp/devloop-worker-worktrees",
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    const runId = repository.getTask(task.id)?.latestRunId;
    runner.succeedNext();

    await waitForTaskStatus(repository, task.id, "REVIEW");
    expect(runner.inputs).toHaveLength(1);
    expect(repository.getRun(runId ?? "")).toMatchObject({
      baseCommit: "target-current-commit",
      resultCommit: "clean-reconciled-result-commit",
      status: "SUCCEEDED",
    });
    expect(gitService.moved).toEqual([
      {
        worktreePath: `/tmp/devloop-worker-worktrees/${runId}`,
        expectedCommit: "result-commit",
        targetCommit: "clean-reconciled-result-commit",
      },
    ]);
    expect(repository.getRunEvents(runId ?? "").map((event) => event.type)).toContain(
      "run.conflict_check.completed",
    );
  });

  it("自动解决冲突被阻塞时不会进入待审核", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "自动解决冲突阻塞项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-blocked-auto-conflict-project",
      defaultBaseRef: "main",
      headCommit: "local-base-commit",
      lastFetchedAt: null,
    }).value;
    const task = createReadyTask(repository, project.id, "处理无法自动解决的冲突", 100);
    const runner = new ControlledRunner("codex");
    const gitService = new ControlledGitService();
    gitService.localBaseCommits.push("local-base-commit", "target-current-commit");
    gitService.reconciliationResult = {
      status: "resolved",
      targetCommit: "target-current-commit",
      resultCommit: "resolved-result-commit",
      resolutions: [],
    };
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      gitService,
      worktreesPath: "/tmp/devloop-worker-worktrees",
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    const runId = repository.getTask(task.id)?.latestRunId;
    runner.succeedNext();
    await waitFor(() => runner.inputs.length === 2);
    runner.blockNext();

    await waitForTaskStatus(repository, task.id, "BLOCKED");
    expect(repository.getTask(task.id)?.status).not.toBe("REVIEW");
    expect(repository.getRun(runId ?? "")?.status).toBe("BLOCKED");
    expect(gitService.moved).toHaveLength(0);
    expect(repository.getRunEvents(runId ?? "").map((event) => event.type)).toContain(
      "run.blocked",
    );
  });

  it("关闭自动解决冲突后直接进入待审核并保留人工处理流程", async () => {
    const repository = createRepository();
    const project = repository.createProject({
      name: "人工解决冲突项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-manual-conflict-project",
      defaultBaseRef: "main",
      headCommit: "local-base-commit",
      lastFetchedAt: null,
    }).value;
    const task = createReadyTask(repository, project.id, "保留人工冲突处理", 100, false);
    const runner = new ControlledRunner("codex");
    const gitService = new ControlledGitService();
    const worker = new AgentWorker(repository, runner, new DomainEventBus(), "/tmp/schema.json", {
      claimDelayMs: 0,
      gitService,
      worktreesPath: "/tmp/devloop-worker-worktrees",
    });

    expect(worker.pullNextTask()).toBe(true);
    await waitFor(() => runner.inputs.length === 1);
    runner.succeedNext();
    await waitForTaskStatus(repository, task.id, "REVIEW");

    expect(runner.inputs).toHaveLength(1);
    expect(gitService.reconciled).toHaveLength(0);
    expect(gitService.resolvedLocal).toHaveLength(1);
  });
});
