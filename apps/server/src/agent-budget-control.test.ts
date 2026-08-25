import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DevLoopRepository, openDatabase, type ClaimedTask } from "@devloop/db";
import type {
  CommitWorktreeInput,
  CreateWorktreeInput,
  GitService,
  ResolveRemoteTargetBaseInput,
  ResolvedTargetBase,
  ResolveTargetBaseInput,
} from "@devloop/git";
import { afterEach, expect, it } from "vitest";
import { AgentBudgetMonitor } from "./agent-budget-monitor.js";
import { AgentRunFinalizer } from "./agent-run-finalizer.js";
import { AgentWorkspaceOperations } from "./agent-workspace-operations.js";

const migrationsFolder = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));
const databases: Array<ReturnType<typeof openDatabase>> = [];

const createClaimedTask = (): { repository: DevLoopRepository; claimed: ClaimedTask } => {
  const database = openDatabase({ filePath: ":memory:", migrationsFolder });
  databases.push(database);
  const repository = new DevLoopRepository(database);
  const project = repository.createProject({
    name: "预算监控测试项目",
    repositoryUrl: null,
    repositoryPath: `/tmp/devloop-budget-monitor-${randomUUID()}`,
    defaultBaseRef: "main",
    headCommit: "base-commit",
    lastFetchedAt: null,
  }).value;
  const draft = repository.createTask({
    projectId: project.id,
    targetBranch: "main",
    executionMode: "MANAGED",
    budgetHardLimitCents: 100,
    title: "检查预算停止",
    goal: "达到预算上限后停止 Agent 并保存 Git 检查点",
    acceptanceCriteria: ["停止继续消耗", "保留恢复点"],
    priority: 50,
  }).value;
  repository.confirmTask(draft.id, "instance-owner", {
    expectedVersion: draft.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: "main",
  });
  const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
  if (!claimed) throw new Error("预算测试任务未被领取");
  return { repository, claimed: claimed.value };
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

it("按运行时长估算消耗并在硬上限通知停止", async () => {
  const { repository, claimed } = createClaimedTask();
  let currentTime = 0;
  let limitReached = 0;
  const publishedTypes: string[] = [];
  const monitor = new AgentBudgetMonitor(repository, claimed, {
    runnerId: "codex",
    now: () => currentTime,
    checkIntervalMs: 60_000,
    publish: (result) => publishedTypes.push(...result.events.map((event) => event.type)),
    onLimitReached: () => {
      limitReached += 1;
    },
    onError: (error) => {
      throw error;
    },
  });

  monitor.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  currentTime = 180_000;
  await monitor.stop();

  expect(limitReached).toBe(1);
  expect(repository.getTask(claimed.task.id)?.budget.consumedCents).toBe(100);
  expect(repository.getRun(claimed.run.id)?.budget).toMatchObject({
    elapsedMs: 180_000,
    estimatedCostCents: 100,
  });
  expect(publishedTypes).toContain("run.budget_changed");
});

it("预算暂停收尾使用独立信号保存 Git 检查点", async () => {
  const { repository, claimed } = createClaimedTask();
  repository.updateRunBudgetUsage(claimed.run.id, claimed.run.executionToken, {
    elapsedMs: 180_000,
    estimatedCostCents: 100,
    taskConsumedCents: 100,
  });
  const commits: CommitWorktreeInput[] = [];
  const target: ResolvedTargetBase = {
    targetBranch: "main",
    baseCommit: "base-commit",
    branchExists: true,
  };
  const gitService: Pick<
    GitService,
    | "fetchRepository"
    | "resolveRemoteTargetBase"
    | "resolveTargetBase"
    | "createWorktree"
    | "commitWorktree"
  > = {
    fetchRepository: async () => undefined,
    resolveRemoteTargetBase: async (_input: ResolveRemoteTargetBaseInput) => target,
    resolveTargetBase: async (_input: ResolveTargetBaseInput) => target,
    createWorktree: async (_input: CreateWorktreeInput) => undefined,
    commitWorktree: async (input: CommitWorktreeInput) => {
      commits.push(input);
      return "budget-checkpoint";
    },
  };
  const publish = (result: { events: readonly { type: string }[] }) => {
    void result;
  };
  const workspace = new AgentWorkspaceOperations(repository, { gitService, publish });
  const finalizer = new AgentRunFinalizer(repository, workspace, {
    publish,
    isExecutionActive: () => true,
    isInvalidExecutionError: () => false,
  });

  await finalizer.finalizeBudgetPausedRun(
    claimed,
    { path: "/tmp/devloop-budget-worktree", baseCommit: "base-commit" },
    () => undefined,
  );

  expect(commits).toHaveLength(1);
  expect(commits[0]?.message).toContain("retry checkpoint");
  expect(repository.getRun(claimed.run.id)).toMatchObject({
    status: "BUDGET_PAUSED",
    resultCommit: "budget-checkpoint",
  });
  expect(repository.getTask(claimed.task.id)?.status).toBe("BUDGET_PAUSED");
});
