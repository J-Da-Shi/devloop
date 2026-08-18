import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DevLoopRepository, openDatabase } from "@devloop/db";
import type {
  ApplyCommitInput,
  ConflictResolutionWorkspace,
  GeneratedConflictResolutions,
  GitService,
} from "@devloop/git";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerHandle,
  RunnerInput,
  RunnerSkill,
} from "@devloop/runners";
import type { RunnerCapabilities } from "@devloop/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AgentWorker } from "./agent-worker.js";
import { DomainEventBus } from "./event-bus.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { SkillService } from "./skill-service.js";

const migrationsFolder = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));
const targetCommit = "a".repeat(40);
const enabledSkills: RunnerSkill[] = [
  {
    id: "skill-id",
    name: "conflict-quality",
    description: "检查冲突解决结果",
    version: 3,
    contentHash: "content-hash",
    content: "# 冲突检查\n\n保留双方有效修改。\n",
  },
];

class ConflictSkillService extends SkillService {
  override async listEnabledForExecution(): Promise<RunnerSkill[]> {
    return enabledSkills;
  }
}

class ConflictRunner implements AgentRunner {
  readonly id = "codex";
  readonly inputs: RunnerInput[] = [];

  async detectCapabilities(): Promise<RunnerCapabilities> {
    return {
      id: this.id,
      available: true,
      version: "test",
      executablePath: "codex",
      features: [],
      error: null,
    };
  }

  start(input: RunnerInput, emit: (event: RunnerEvent) => void): RunnerHandle {
    this.inputs.push(input);
    emit({ type: "runner.agent", message: "Agent 正在解决冲突" });
    return {
      result: Promise.resolve({
        outcome: "succeeded",
        summary: "Agent 已合并目标分支和本次结果",
        risks: [],
      }),
      cancel: () => undefined,
    };
  }
}

class ConflictGitService {
  generateCalls = 0;
  readonly conflictContent = [
    "<<<<<<< HEAD\n",
    'export const value = "target";\n',
    "=======\n",
    'export const value = "result";\n',
    ">>>>>>> result\n",
  ].join("");

  async listRunChangedFiles() {
    return [
      {
        path: "apps/demo.ts",
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        isBinary: false,
      },
    ];
  }

  async previewCommitConflicts() {
    return {
      status: "conflicted" as const,
      targetBranch: "main",
      targetCommit,
      files: [
        {
          path: "apps/demo.ts",
          patch: "",
          isBinary: false,
          content: this.conflictContent,
          targetExists: true,
          resultExists: true,
        },
      ],
      message: "存在冲突",
    };
  }

  async generateConflictResolutions(
    _input: ApplyCommitInput,
    resolver: (workspace: ConflictResolutionWorkspace) => Promise<void>,
  ): Promise<GeneratedConflictResolutions> {
    this.generateCalls += 1;
    await resolver({
      worktreePath: "/tmp/devloop-conflict-agent-test",
      files: [
        {
          path: "apps/demo.ts",
          patch: "",
          isBinary: false,
          content: this.conflictContent,
          targetExists: true,
          resultExists: true,
        },
      ],
    });
    return {
      targetCommit,
      resolutions: [
        {
          path: "apps/demo.ts",
          strategy: "content",
          content: 'export const value = "merged";\n',
        },
      ],
    };
  }
}

const config: RuntimeConfig = {
  repositoryRoot: "/tmp/devloop-app-test",
  host: "127.0.0.1",
  port: 4317,
  databasePath: ":memory:",
  repositoriesPath: "/tmp/devloop-app-test/repositories",
  worktreesPath: "/tmp/devloop-app-test/worktrees",
  skillsPath: "/tmp/devloop-app-test/skills",
  migrationsFolder,
  webDistPath: "/tmp/devloop-app-test/web-dist-not-built",
  outputSchemaPath: "/tmp/devloop-app-test/agent-result.schema.json",
  logLevel: "silent",
  runner: "codex",
  codexExecutable: "codex",
  codexIgnoreUserConfig: true,
  codexStallTimeoutMs: 60_000,
  claudeCodeExecutable: "claude",
  claudeCodeStallTimeoutMs: 60_000,
  agentClaimDelayMs: 1_000,
  fakeRunnerDelayMs: 1,
};

describe("冲突解决接口", () => {
  it("只持久化 Agent 建议并等待人工审批，幂等重放不会再次执行 Agent", async () => {
    const database = openDatabase({ filePath: ":memory:", migrationsFolder });
    const repository = new DevLoopRepository(database);
    const project = repository.createProject({
      name: "本地冲突项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-local-conflict-test",
      defaultBaseRef: "main",
      headCommit: "b".repeat(40),
      lastFetchedAt: null,
    }).value;
    const draft = repository.createTask({
      projectId: project.id,
      targetBranch: "main",
      title: "解决写入冲突",
      goal: "由 Agent 生成冲突建议并交给人工审核",
      acceptanceCriteria: ["目标分支不会被自动写入"],
      priority: 80,
    }).value;
    repository.confirmTask(draft.id, "instance-owner", {
      expectedVersion: draft.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: "main",
    });
    const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
    const completed = repository.completeRun(
      claimed!.value.run.id,
      claimed!.value.run.executionToken,
      "等待人工审核",
      "c".repeat(40),
    ).value;
    const runner = new ConflictRunner();
    const gitService = new ConflictGitService();
    const worker = { wake: () => undefined } as unknown as AgentWorker;
    const app = await createApp({
      config,
      repository,
      gitService: gitService as unknown as GitService,
      skillService: new ConflictSkillService(repository, config.skillsPath),
      runners: [runner],
      eventBus: new DomainEventBus(),
      worker,
    });
    const idempotencyKey = randomUUID();
    const payload = {
      expectedVersion: completed.task.version,
      expectedTargetCommit: targetCommit,
      idempotencyKey,
    };

    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/runs/${claimed!.value.run.id}/resolve-conflicts`,
        remoteAddress: "127.0.0.1",
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        replayed: false,
        resolution: {
          targetCommit,
          resolutions: [
            {
              path: "apps/demo.ts",
              strategy: "content",
              content: 'export const value = "merged";\n',
            },
          ],
        },
      });
      expect(runner.inputs).toEqual([
        expect.objectContaining({
          mode: "conflict-resolution",
          conflictPaths: ["apps/demo.ts"],
          skills: enabledSkills,
          worktreePath: "/tmp/devloop-conflict-agent-test",
        }),
      ]);
      expect(repository.getTask(draft.id)?.status).toBe("REVIEW");

      const changedFiles = await app.inject({
        method: "GET",
        url: `/api/runs/${claimed!.value.run.id}/changed-files`,
      });
      expect(changedFiles.statusCode).toBe(200);
      expect(changedFiles.json()).toMatchObject({
        agentResolution: {
          targetCommit,
          summary: "Agent 已合并目标分支和本次结果",
        },
      });

      const replay = await app.inject({
        method: "POST",
        url: `/api/runs/${claimed!.value.run.id}/resolve-conflicts`,
        remoteAddress: "127.0.0.1",
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: true });
      expect(gitService.generateCalls).toBe(1);
      expect(runner.inputs).toHaveLength(1);
      expect(
        repository
          .getRunEvents(claimed!.value.run.id)
          .map((event) => event.type)
          .filter((type) => type.startsWith("run.conflict_resolution")),
      ).toEqual([
        "run.conflict_resolution.started",
        "run.conflict_resolution.progress",
        "run.conflict_resolution.completed",
      ]);
    } finally {
      await app.close();
      database.close();
    }
  });
});

describe("完成任务继续迭代接口", () => {
  it("把已完成任务转为可编辑草稿，并支持幂等重放", async () => {
    const database = openDatabase({ filePath: ":memory:", migrationsFolder });
    const repository = new DevLoopRepository(database);
    const project = repository.createProject({
      name: "继续迭代项目",
      repositoryUrl: null,
      repositoryPath: "/tmp/devloop-continue-completed-test",
      defaultBaseRef: "main",
      headCommit: "b".repeat(40),
      lastFetchedAt: null,
    }).value;
    const draft = repository.createTask({
      projectId: project.id,
      targetBranch: "main",
      title: "已完成需求",
      goal: "完成后继续增加需求",
      acceptanceCriteria: ["可以开启下一轮草稿"],
      priority: 50,
    }).value;
    repository.confirmTask(draft.id, "instance-owner", {
      expectedVersion: draft.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: "main",
    });
    const claimed = repository.claimNextTask({ readyBefore: "9999-12-31T23:59:59.999Z" });
    const completed = repository.completeRun(
      claimed!.value.run.id,
      claimed!.value.run.executionToken,
      "等待审核",
      "c".repeat(40),
    ).value;
    const approved = repository.approveAppliedRun(
      claimed!.value.run.id,
      "instance-owner",
      completed.task.version,
      randomUUID(),
      {
        status: "applied",
        branch: "main",
        previousCommit: "b".repeat(40),
        currentCommit: "c".repeat(40),
        branchCreated: false,
        workingTreeUpdated: true,
      },
    ).value;
    const app = await createApp({
      config,
      repository,
      gitService: new ConflictGitService() as unknown as GitService,
      skillService: new SkillService(repository, config.skillsPath),
      runners: [new ConflictRunner()],
      eventBus: new DomainEventBus(),
      worker: { wake: () => undefined } as unknown as AgentWorker,
    });
    const payload = {
      expectedVersion: approved.task.version,
      idempotencyKey: randomUUID(),
    };

    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/tasks/${draft.id}/continue`,
        remoteAddress: "127.0.0.1",
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        replayed: false,
        task: { id: draft.id, status: "DRAFT", version: approved.task.version + 1 },
      });

      const replay = await app.inject({
        method: "POST",
        url: `/api/tasks/${draft.id}/continue`,
        remoteAddress: "127.0.0.1",
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: true, task: { status: "DRAFT" } });
    } finally {
      await app.close();
      database.close();
    }
  });
});

describe("Worker 并发配置接口", () => {
  it("持久化并发上限并拒绝超出范围的配置", async () => {
    const database = openDatabase({ filePath: ":memory:", migrationsFolder });
    const repository = new DevLoopRepository(database);
    const worker = {
      setConcurrency: (concurrencyLimit: number) => {
        repository.setWorkerConcurrency(concurrencyLimit);
      },
    } as unknown as AgentWorker;
    const app = await createApp({
      config,
      repository,
      gitService: new ConflictGitService() as unknown as GitService,
      skillService: new SkillService(repository, config.skillsPath),
      runners: [new ConflictRunner()],
      eventBus: new DomainEventBus(),
      worker,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/worker/concurrency",
        payload: { concurrencyLimit: 3 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        worker: { concurrencyLimit: 3, activeRunIds: [] },
      });
      expect(repository.getWorkerState().concurrencyLimit).toBe(3);

      const invalid = await app.inject({
        method: "POST",
        url: "/api/worker/concurrency",
        payload: { concurrencyLimit: 11 },
      });
      expect(invalid.statusCode).toBe(400);
      expect(repository.getWorkerState().concurrencyLimit).toBe(3);
    } finally {
      await app.close();
      database.close();
    }
  });
});
