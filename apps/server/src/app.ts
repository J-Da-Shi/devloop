import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DevLoopRepository, EventfulResult } from "@devloop/db";
import { GitApplyError, type GitService } from "@devloop/git";
import type { AgentRunner, RunnerResult } from "@devloop/runners";
import {
  approveRunInputSchema,
  confirmTaskInputSchema,
  createLocalProjectInputSchema,
  createProjectInputSchema,
  createSkillInputSchema,
  createSkillVersionInputSchema,
  createTaskInputSchema,
  rejectRunInputSchema,
  resolveRunConflictsInputSchema,
  runConflictAgentResolutionSchema,
  taskCommandInputSchema,
  updateProjectRunnerInputSchema,
  updateSkillInputSchema,
  updateTaskInputSchema,
  validateSkillInputSchema,
  workerStatusSchema,
  type DomainEvent,
  type RunConflictAgentResolution,
  type Task,
} from "@devloop/shared";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { DomainEventBus } from "./event-bus.js";
import type { AgentWorker } from "./agent-worker.js";
import { HttpError, requireLocalRole, requireRole } from "./http.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { SkillValidationError, type SkillService } from "./skill-service.js";

export interface CreateAppOptions {
  config: RuntimeConfig;
  repository: DevLoopRepository;
  gitService: GitService;
  skillService: SkillService;
  runners: AgentRunner[];
  eventBus: DomainEventBus;
  worker: AgentWorker;
}

const taskParamSchema = z.object({ taskId: z.string().uuid() });
const runParamSchema = z.object({ runId: z.string().uuid() });
const projectParamSchema = z.object({ projectId: z.string().uuid() });
const skillParamSchema = z.object({ skillId: z.string().uuid() });
const runQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const publish = (eventBus: DomainEventBus, result: EventfulResult<unknown>): void => {
  eventBus.publish(result.events);
};

const mapRepositoryError = (error: Error): HttpError | null => {
  if (error instanceof GitApplyError) {
    return new HttpError(409, error.message, error.code);
  }
  if (
    error.message.includes("not found") ||
    error.message.endsWith("不存在") ||
    error.message.includes("Revision 不存在")
  ) {
    return new HttpError(404, "请求的资源不存在", "NOT_FOUND");
  }
  if (
    error.message.startsWith("Version conflict") ||
    error.message.startsWith("Invalid task transition") ||
    error.message.startsWith("Only ") ||
    error.message.startsWith("只有") ||
    error.message.includes("changed; reload") ||
    error.message.includes("当前执行已经变化") ||
    error.message.includes("执行中的任务不能删除") ||
    error.message.includes("只有执行中的任务可以取消") ||
    error.message.includes("只有草稿任务可以编辑") ||
    error.message.includes("只有任务最近一次成功执行可以驳回") ||
    error.message === "Skill 内容没有变化" ||
    error.message === "Skill 名称发布后不能修改"
  ) {
    return new HttpError(409, error.message, "STATE_CONFLICT");
  }
  if (error.message.includes("UNIQUE constraint failed")) {
    return new HttpError(409, "该记录已经存在", "ALREADY_EXISTS");
  }
  return null;
};

const writeSseEvent = (response: NodeJS.WritableStream, event: DomainEvent): void => {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
};

const formatConflictRunnerResult = (result: RunnerResult): string =>
  [
    result.summary,
    result.blockedReason ? `阻塞原因：${result.blockedReason}` : null,
    result.risks.length ? `风险：${result.risks.join("；")}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n")
    .slice(0, 16_000);

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const { config, repository, gitService, skillService, runners, eventBus, worker } = options;
  const requireRequestRole = (
    request: Parameters<typeof requireRole>[0],
    role: Parameters<typeof requireRole>[1],
  ) => requireRole(request, role);
  const autoQueueTask = (task: Task, deviceId: string): Task => {
    const queued = repository.autoQueueTask(task.id, deviceId);
    if (queued) {
      publish(eventBus, queued);
      worker.wake();
    }
    return repository.getTask(task.id) ?? task;
  };
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
  });

  let capabilityCache: Awaited<ReturnType<AgentRunner["detectCapabilities"]>>[] | null = null;
  const getRunnerCapabilities = async () => {
    capabilityCache ??= await Promise.all(runners.map((runner) => runner.detectCapabilities()));
    return capabilityCache;
  };
  type ConflictResolutionResponse = {
    resolution: RunConflictAgentResolution;
    replayed: boolean;
  };
  const activeConflictJobs = new Map<
    string,
    {
      targetCommit: string;
      controller: AbortController;
      promise: Promise<ConflictResolutionResponse>;
    }
  >();
  const getStoredConflictResolution = (
    runId: string,
    targetCommit: string,
    idempotencyKey?: string,
  ): RunConflictAgentResolution | null => {
    const events = repository.getRunEvents(runId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "run.conflict_resolution.completed") continue;
      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : null;
      if (!payload || (idempotencyKey && payload.idempotencyKey !== idempotencyKey)) continue;
      const parsed = runConflictAgentResolutionSchema.safeParse(payload);
      if (parsed.success && parsed.data.targetCommit === targetCommit) {
        return parsed.data;
      }
    }
    return null;
  };
  const recordConflictRunEvent = (
    runId: string,
    type: string,
    message: string,
    payload: Record<string, unknown>,
  ) => {
    const result = repository.recordRunEvent(runId, type, message, payload);
    publish(eventBus, result);
    return result.value;
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_INPUT",
          message: "提交内容不符合要求",
          details: error.issues,
        },
      });
    }
    if (error instanceof SkillValidationError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_SKILL",
          message: error.message,
          details: error.validation,
        },
      });
    }
    const httpError =
      error instanceof HttpError
        ? error
        : error instanceof Error
          ? mapRepositoryError(error)
          : null;
    if (httpError) {
      return reply.code(httpError.statusCode).send({
        error: { code: httpError.code, message: httpError.message },
      });
    }
    request.log.error(error);
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "服务器处理请求时发生错误" },
    });
  });

  app.get("/api/health", async () => ({
    status: "ok",
    service: "devloop",
    time: new Date().toISOString(),
  }));

  app.get("/api/session", async (request) => {
    const identity = requireRequestRole(request, "viewer");
    return { identity };
  });

  app.get("/api/dashboard", async (request) => {
    requireRequestRole(request, "viewer");
    const workerState = repository.getWorkerState();
    return {
      worker: workerState,
      projects: repository.listProjects(),
      tasks: repository.listTasks(),
      currentRun: workerState.activeRunId ? repository.getRun(workerState.activeRunId) : null,
      runnerCapabilities: await getRunnerCapabilities(),
    };
  });

  app.get("/api/projects", async (request) => {
    requireRequestRole(request, "viewer");
    return { projects: repository.listProjects() };
  });

  app.post("/api/projects", async (request, reply) => {
    requireRequestRole(request, "editor");
    const input = createProjectInputSchema.parse(request.body);
    const repositoryUrl = gitService.normalizeRepositoryUrl(input.repositoryUrl);
    const existing = repository.findProjectByRepositoryUrl(repositoryUrl);
    if (existing) {
      throw new HttpError(409, "该项目已经注册", "ALREADY_EXISTS");
    }
    const projectId = randomUUID();
    const repositoryPath = resolve(config.repositoriesPath, projectId);
    let cloned = false;
    try {
      const git = await gitService.cloneRepository({
        repositoryUrl,
        destinationPath: repositoryPath,
        defaultBranch: input.defaultBaseRef,
      });
      cloned = true;
      const result = repository.createProject({
        id: projectId,
        name: input.name,
        repositoryUrl: git.repositoryUrl,
        repositoryPath: git.path,
        defaultBaseRef: git.defaultBranch,
        headCommit: git.headCommit,
        runner: input.runner,
      });
      publish(eventBus, result);
      return reply.code(201).send({ project: result.value });
    } catch (error) {
      if (cloned) {
        await gitService.removeManagedRepository(repositoryPath);
      }
      throw error;
    }
  });

  app.post("/api/projects/local", async (request, reply) => {
    requireLocalRole(request, "editor");
    const input = createLocalProjectInputSchema.parse(request.body);
    const git = await gitService.inspectRepository(input.path);
    const existing = repository.findProjectByPath(git.path);
    if (existing) {
      throw new HttpError(409, "该本地项目已经注册", "ALREADY_EXISTS");
    }
    const result = repository.createProject({
      name: input.name,
      repositoryUrl: null,
      repositoryPath: git.path,
      defaultBaseRef: git.branch,
      headCommit: git.headCommit,
      lastFetchedAt: null,
      runner: input.runner,
    });
    publish(eventBus, result);
    return reply.code(201).send({ project: result.value });
  });

  app.patch("/api/projects/:projectId/runner", async (request) => {
    const identity = requireRequestRole(request, "editor");
    const { projectId } = projectParamSchema.parse(request.params);
    const input = updateProjectRunnerInputSchema.parse(request.body);
    const context = repository.getProjectExecutionContext(projectId);
    if (!context) {
      throw new HttpError(404, "项目不存在", "NOT_FOUND");
    }
    const result = repository.updateProjectRunner(
      projectId,
      input.runner,
      identity.id,
      input.expectedVersion,
      input.idempotencyKey,
    );
    publish(eventBus, result);
    return { project: result.value, replayed: result.replayed };
  });

  app.post("/api/projects/:projectId/sync", async (request) => {
    requireRequestRole(request, "editor");
    const { projectId } = projectParamSchema.parse(request.params);
    const context = repository.getProjectExecutionContext(projectId);
    if (!context) {
      throw new HttpError(404, "项目不存在", "NOT_FOUND");
    }
    if (!context.project.repositoryUrl) {
      requireLocalRole(request, "editor");
      const git = await gitService.inspectRepository(context.repositoryPath);
      const result = repository.recordProjectFetch(projectId, git.headCommit);
      publish(eventBus, result);
      return { project: result.value };
    }
    await gitService.fetchRepository(context.repositoryPath);
    const base = await gitService.resolveRemoteTargetBase({
      repositoryPath: context.repositoryPath,
      targetBranch: context.project.defaultBaseRef,
      fallbackRef: context.project.defaultBaseRef,
    });
    const result = repository.recordProjectFetch(projectId, base.baseCommit);
    publish(eventBus, result);
    return { project: result.value };
  });

  app.get("/api/skills", async (request) => {
    requireRequestRole(request, "viewer");
    return { skills: skillService.list() };
  });

  app.get("/api/skills/:skillId", async (request) => {
    requireRequestRole(request, "viewer");
    const { skillId } = skillParamSchema.parse(request.params);
    const details = await skillService.get(skillId);
    if (!details) {
      throw new HttpError(404, "Skill 不存在", "NOT_FOUND");
    }
    return details;
  });

  app.post("/api/skills/validate", async (request) => {
    requireRequestRole(request, "editor");
    const input = validateSkillInputSchema.parse(request.body);
    return { validation: skillService.validate(input.content) };
  });

  app.post("/api/skills", async (request, reply) => {
    const identity = requireRequestRole(request, "editor");
    const input = createSkillInputSchema.parse(request.body);
    const result = await skillService.create(input.content, identity.id);
    publish(eventBus, result);
    return reply.code(201).send({ skill: result.value });
  });

  app.post("/api/skills/:skillId/versions", async (request, reply) => {
    const identity = requireRequestRole(request, "editor");
    const { skillId } = skillParamSchema.parse(request.params);
    const input = createSkillVersionInputSchema.parse(request.body);
    const result = await skillService.createVersion(skillId, input, identity.id);
    publish(eventBus, result);
    return reply.code(201).send({ skill: result.value, replayed: result.replayed });
  });

  app.patch("/api/skills/:skillId", async (request) => {
    const identity = requireRequestRole(request, "editor");
    const { skillId } = skillParamSchema.parse(request.params);
    const input = updateSkillInputSchema.parse(request.body);
    const result = skillService.setEnabled(skillId, input, identity.id);
    publish(eventBus, result);
    return { skill: result.value, replayed: result.replayed };
  });

  app.get("/api/tasks", async (request) => {
    requireRequestRole(request, "viewer");
    return { tasks: repository.listTasks() };
  });

  app.get("/api/tasks/:taskId", async (request) => {
    requireRequestRole(request, "viewer");
    const { taskId } = taskParamSchema.parse(request.params);
    const task = repository.getTask(taskId);
    if (!task) {
      throw new HttpError(404, "任务不存在", "NOT_FOUND");
    }
    return { task };
  });

  app.post("/api/tasks", async (request, reply) => {
    const identity = requireRequestRole(request, "editor");
    const input = createTaskInputSchema.parse(request.body);
    const context = repository.getProjectExecutionContext(input.projectId);
    if (!context) {
      throw new HttpError(404, "项目不存在", "NOT_FOUND");
    }
    const targetBranch = await gitService.validateBranchName(input.targetBranch);
    const result = repository.createTask({ ...input, targetBranch });
    publish(eventBus, result);
    const task = autoQueueTask(result.value, identity.id);
    return reply.code(201).send({ task });
  });

  app.patch("/api/tasks/:taskId", async (request) => {
    const identity = requireRequestRole(request, "editor");
    const { taskId } = taskParamSchema.parse(request.params);
    const input = updateTaskInputSchema.parse(request.body);
    if (input.targetBranch) {
      const task = repository.getTask(taskId);
      const context = task ? repository.getProjectExecutionContext(task.projectId) : null;
      if (!task || !context) {
        throw new HttpError(404, "任务或项目不存在", "NOT_FOUND");
      }
      input.targetBranch = await gitService.validateBranchName(input.targetBranch);
    }
    const result = repository.updateDraftTask(taskId, identity.id, input);
    publish(eventBus, result);
    const task = autoQueueTask(result.value, identity.id);
    return { task, replayed: result.replayed };
  });

  app.post("/api/tasks/:taskId/confirm", async (request) => {
    const identity = requireRequestRole(request, "editor");
    const { taskId } = taskParamSchema.parse(request.params);
    const input = confirmTaskInputSchema.parse(request.body);
    const result = repository.confirmTask(taskId, identity.id, input);
    publish(eventBus, result);
    worker.wake();
    return { task: result.value, replayed: result.replayed };
  });

  app.post("/api/tasks/:taskId/unconfirm", async (request) => {
    const identity = requireRequestRole(request, "editor");
    const { taskId } = taskParamSchema.parse(request.params);
    const input = taskCommandInputSchema.parse(request.body);
    const result = repository.unconfirmTask(
      taskId,
      identity.id,
      input.expectedVersion,
      input.idempotencyKey,
    );
    publish(eventBus, result);
    return { task: result.value, replayed: result.replayed };
  });

  app.post("/api/tasks/:taskId/cancel", async (request) => {
    const identity = requireRequestRole(request, "operator");
    const { taskId } = taskParamSchema.parse(request.params);
    const input = taskCommandInputSchema.parse(request.body);
    const result = worker.cancelTask(
      taskId,
      identity.id,
      input.expectedVersion,
      input.idempotencyKey,
    );
    publish(eventBus, result);
    worker.wake();
    return { ...result.value, replayed: result.replayed };
  });

  app.delete("/api/tasks/:taskId", async (request) => {
    const identity = requireRequestRole(request, "editor");
    const { taskId } = taskParamSchema.parse(request.params);
    const input = taskCommandInputSchema.parse(request.body);
    const result = repository.deleteTask(
      taskId,
      identity.id,
      input.expectedVersion,
      input.idempotencyKey,
    );
    publish(eventBus, result);
    return { task: result.value, replayed: result.replayed };
  });

  app.get("/api/runs", async (request) => {
    requireRequestRole(request, "viewer");
    const { limit } = runQuerySchema.parse(request.query);
    return { runs: repository.listRuns(limit) };
  });

  app.get("/api/runs/:runId", async (request) => {
    requireRequestRole(request, "viewer");
    const { runId } = runParamSchema.parse(request.params);
    const run = repository.getRun(runId);
    if (!run) {
      throw new HttpError(404, "执行记录不存在", "NOT_FOUND");
    }
    const revision = repository.getTaskRevision(run.taskRevisionId);
    if (!revision) {
      throw new HttpError(500, "执行记录关联的 Revision 不存在", "DATA_INTEGRITY_ERROR");
    }
    return {
      run,
      task: repository.getTaskIncludingDeleted(run.taskId),
      revision,
      reviewDecision: repository.getRunReviewDecision(runId),
      events: repository.getRunEvents(runId),
    };
  });

  const resolveRunRepositoryPath = (runId: string) => {
    const run = repository.getRun(runId);
    if (!run) {
      throw new HttpError(404, "执行记录不存在", "NOT_FOUND");
    }
    const task = repository.getTaskIncludingDeleted(run.taskId);
    if (!task) {
      throw new HttpError(404, "任务不存在", "NOT_FOUND");
    }
    const context = repository.getProjectExecutionContext(task.projectId);
    if (!context) {
      throw new HttpError(404, "项目不存在", "NOT_FOUND");
    }
    return { run, task, project: context.project, repositoryPath: context.repositoryPath };
  };

  app.get("/api/runs/:runId/changed-files", async (request) => {
    requireRequestRole(request, "viewer");
    const { runId } = runParamSchema.parse(request.params);
    const { run, task, project, repositoryPath } = resolveRunRepositoryPath(runId);
    if (!run.baseCommit || !run.resultCommit) {
      return { files: [], conflictPreview: null, agentResolution: null };
    }
    const files = await gitService.listRunChangedFiles({
      repositoryPath,
      baseCommit: run.baseCommit,
      resultCommit: run.resultCommit,
    });
    let conflictPreview: Awaited<ReturnType<GitService["previewCommitConflicts"]>> | null = null;
    if (
      project.repositoryUrl === null &&
      task.status === "REVIEW" &&
      task.latestRunId === run.id &&
      run.status === "SUCCEEDED"
    ) {
      try {
        conflictPreview = await gitService.previewCommitConflicts({
          repositoryPath,
          targetBranch: run.targetBranch,
          baseCommit: run.baseCommit,
          resultCommit: run.resultCommit,
        });
      } catch (error) {
        if (!(error instanceof GitApplyError)) {
          throw error;
        }
        conflictPreview = {
          status: "unavailable",
          targetBranch: run.targetBranch,
          targetCommit: null,
          files: [],
          message: error.message,
        };
      }
    }
    const agentResolution =
      conflictPreview?.status === "conflicted" && conflictPreview.targetCommit
        ? getStoredConflictResolution(runId, conflictPreview.targetCommit)
        : null;
    return { files, conflictPreview, agentResolution };
  });

  const patchQuerySchema = z.object({ path: z.string().min(1).max(1024) });

  app.get("/api/runs/:runId/patch", async (request) => {
    requireRequestRole(request, "viewer");
    const { runId } = runParamSchema.parse(request.params);
    const { path } = patchQuerySchema.parse(request.query);
    const { run, repositoryPath } = resolveRunRepositoryPath(runId);
    if (!run.baseCommit || !run.resultCommit) {
      return { patch: "", isBinary: false };
    }
    const result = await gitService.getRunFilePatch({
      repositoryPath,
      baseCommit: run.baseCommit,
      resultCommit: run.resultCommit,
      path,
    });
    return result;
  });

  app.post("/api/runs/:runId/resolve-conflicts", async (request) => {
    const identity = requireLocalRole(request, "operator");
    const { runId } = runParamSchema.parse(request.params);
    const input = resolveRunConflictsInputSchema.parse(request.body);
    const replay = getStoredConflictResolution(
      runId,
      input.expectedTargetCommit,
      input.idempotencyKey,
    );
    if (replay) {
      return { resolution: replay, replayed: true };
    }

    const activeJob = activeConflictJobs.get(runId);
    if (activeJob) {
      if (activeJob.targetCommit !== input.expectedTargetCommit) {
        throw new HttpError(
          409,
          "目标分支已发生变化，请等待当前 Agent 结束后刷新冲突内容。",
          "TARGET_BRANCH_CHANGED",
        );
      }
      return activeJob.promise.then((result) => ({ ...result, replayed: true }));
    }

    const approval = repository.getRunApprovalContext(runId, input.expectedVersion);
    if (approval.type !== "local") {
      throw new HttpError(409, "只有本地项目的写入冲突可以交给 Agent 解决。", "LOCAL_ONLY");
    }
    const revision = repository.getTaskRevision(resolveRunRepositoryPath(runId).run.taskRevisionId);
    if (!revision) {
      throw new HttpError(500, "执行记录关联的 Revision 不存在", "DATA_INTEGRITY_ERROR");
    }
    const conflictRunner = runners.find((runner) => runner.id === "codex");
    const conflictRunnerCapability = (await getRunnerCapabilities()).find(
      (capability) => capability.id === "codex",
    );
    if (!conflictRunner || !conflictRunnerCapability?.available) {
      throw new HttpError(
        503,
        conflictRunnerCapability?.error ?? "Codex Agent 当前不可用或尚未登录。",
        "AGENT_UNAVAILABLE",
      );
    }

    const skills = await skillService.listEnabledForExecution();
    const controller = new AbortController();
    const promise = (async (): Promise<ConflictResolutionResponse> => {
      recordConflictRunEvent(
        runId,
        "run.conflict_resolution.started",
        `已将 ${revision.title} 的写入冲突交给 Agent 处理`,
        {
          idempotencyKey: input.idempotencyKey,
          targetCommit: input.expectedTargetCommit,
          deviceId: identity.id,
        },
      );
      let runnerSummary = "Agent 已完成冲突解决。";
      try {
        const generated = await gitService.generateConflictResolutions(
          {
            repositoryPath: approval.context.projectPath,
            targetBranch: approval.context.targetBranch,
            baseCommit: approval.context.baseCommit,
            resultCommit: approval.context.resultCommit,
            expectedTargetCommit: input.expectedTargetCommit,
          },
          async ({ worktreePath, files }) => {
            const handle = conflictRunner.start(
              {
                runId: `conflict-${randomUUID()}`,
                taskId: revision.taskId,
                title: revision.title,
                goal: revision.goal,
                acceptanceCriteria: revision.acceptanceCriteria,
                skills,
                mode: "conflict-resolution",
                conflictPaths: files.map((file) => file.path),
                worktreePath,
                outputSchemaPath: config.outputSchemaPath,
                signal: controller.signal,
              },
              (event) => {
                recordConflictRunEvent(runId, "run.conflict_resolution.progress", event.message, {
                  idempotencyKey: input.idempotencyKey,
                  targetCommit: input.expectedTargetCommit,
                  runnerEventType: event.type,
                  ...(event.data ? { data: event.data } : {}),
                });
              },
            );
            const result = await handle.result;
            runnerSummary = formatConflictRunnerResult(result);
            if (result.outcome === "blocked") {
              throw new HttpError(
                409,
                result.blockedReason ?? runnerSummary,
                "AGENT_CONFLICT_RESOLUTION_BLOCKED",
              );
            }
            if (result.outcome !== "succeeded") {
              throw new HttpError(502, runnerSummary, "AGENT_CONFLICT_RESOLUTION_FAILED");
            }
          },
        );
        const resolution: RunConflictAgentResolution = {
          ...generated,
          summary: runnerSummary,
          completedAt: new Date().toISOString(),
        };
        recordConflictRunEvent(
          runId,
          "run.conflict_resolution.completed",
          `Agent 已生成 ${resolution.resolutions.length} 个冲突文件的解决建议，等待人工审核`,
          { idempotencyKey: input.idempotencyKey, ...resolution },
        );
        return { resolution, replayed: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent 解决冲突时发生未知错误。";
        try {
          recordConflictRunEvent(runId, "run.conflict_resolution.failed", message, {
            idempotencyKey: input.idempotencyKey,
            targetCommit: input.expectedTargetCommit,
          });
        } catch {
          // 关闭服务时数据库可能先于 Agent 清理完成。
        }
        throw error;
      }
    })();
    activeConflictJobs.set(runId, {
      targetCommit: input.expectedTargetCommit,
      controller,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (activeConflictJobs.get(runId)?.promise === promise) {
        activeConflictJobs.delete(runId);
      }
    }
  });

  app.post("/api/runs/:runId/approve", { bodyLimit: 5 * 1024 * 1024 }, async (request) => {
    const identity = requireRequestRole(request, "operator");
    const { runId } = runParamSchema.parse(request.params);
    const input = approveRunInputSchema.parse(request.body);
    const replay = repository.getRunApprovalReplay(identity.id, input.idempotencyKey);
    if (replay) {
      return { ...replay, replayed: true };
    }
    const approval = repository.getRunApprovalContext(runId, input.expectedVersion);
    if (approval.type === "remote") {
      const publication = await gitService.pushResult(approval.context);
      const result = repository.approvePublishedRun(
        runId,
        identity.id,
        input.expectedVersion,
        input.idempotencyKey,
        publication,
      );
      publish(eventBus, result);
      return { ...result.value, replayed: result.replayed };
    }
    const localIdentity = requireLocalRole(request, "operator");
    const application = await gitService.applyCommitToWorkingTree({
      repositoryPath: approval.context.projectPath,
      targetBranch: approval.context.targetBranch,
      baseCommit: approval.context.baseCommit,
      resultCommit: approval.context.resultCommit,
      ...(input.expectedTargetCommit !== undefined
        ? { expectedTargetCommit: input.expectedTargetCommit }
        : {}),
      ...(input.conflictResolutions !== undefined
        ? { conflictResolutions: input.conflictResolutions }
        : {}),
    });
    const result = repository.approveAppliedRun(
      runId,
      localIdentity.id,
      input.expectedVersion,
      input.idempotencyKey,
      application,
    );
    publish(eventBus, result);
    return { ...result.value, replayed: result.replayed };
  });

  app.post("/api/runs/:runId/reject", async (request) => {
    const identity = requireRequestRole(request, "operator");
    const { runId } = runParamSchema.parse(request.params);
    const input = rejectRunInputSchema.parse(request.body);
    const result = repository.rejectRun(
      runId,
      identity.id,
      input.expectedVersion,
      input.idempotencyKey,
      input.feedback,
    );
    publish(eventBus, result);
    worker.wake();
    return { task: result.value, replayed: result.replayed };
  });

  app.post("/api/worker/status", async (request) => {
    requireRequestRole(request, "operator");
    const input = z.object({ status: workerStatusSchema }).parse(request.body);
    if (input.status !== "RUNNING" && input.status !== "PAUSED") {
      throw new HttpError(400, "只允许启动或暂停 Worker", "INVALID_WORKER_STATUS");
    }
    worker.setStatus(input.status);
    return { worker: repository.getWorkerState() };
  });

  app.get("/api/events", async (request, reply) => {
    requireRequestRole(request, "viewer");
    const headerEventId = request.headers["last-event-id"];
    const query = z
      .object({ after: z.coerce.number().int().nonnegative().optional() })
      .parse(request.query);
    const afterId =
      query.after ??
      (typeof headerEventId === "string" ? Number.parseInt(headerEventId, 10) || 0 : 0);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    for (const event of repository.listDomainEvents(afterId)) {
      writeSseEvent(reply.raw, event);
    }
    const unsubscribe = eventBus.subscribe((event) => writeSseEvent(reply.raw, event));
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once("close", cleanup);
    return reply;
  });

  const hasBuiltWeb = existsSync(config.webDistPath);
  if (hasBuiltWeb) {
    await app.register(fastifyStatic, { root: config.webDistPath, prefix: "/" });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "接口不存在" },
      });
    }
    // 静态资源目录未命中时不要走 SPA fallback，避免旧缓存的 index.html 引用到已消失的 assets 时
    // 返回 index.html 让浏览器把 HTML 当 JS 解析，导致白屏。
    if (
      request.url.startsWith("/assets/") ||
      /\.(?:js|mjs|css|map|json|svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|txt)$/i.test(
        request.url.split("?")[0] ?? "",
      )
    ) {
      return reply.code(404).send({
        error: { code: "ASSET_NOT_FOUND", message: "静态资源不存在，可能是浏览器缓存过期，请强制刷新" },
      });
    }
    if (hasBuiltWeb) {
      return reply
        .header("Cache-Control", "no-store")
        .type("text/html")
        .sendFile("index.html");
    }
    return reply.code(404).send({
      error: { code: "WEB_NOT_BUILT", message: "Web 应用尚未构建，请使用 Vite 开发服务" },
    });
  });

  app.addHook("onClose", async () => {
    const jobs = Array.from(activeConflictJobs.values());
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map((job) => job.promise));
  });

  return app;
}
