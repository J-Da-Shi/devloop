import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DevLoopRepository, EventfulResult } from "@devloop/db";
import { GitApplyError, type GitService } from "@devloop/git";
import type { AgentRunner } from "@devloop/runners";
import {
  approveRunInputSchema,
  confirmTaskInputSchema,
  createLocalProjectInputSchema,
  createProjectInputSchema,
  createSkillInputSchema,
  createSkillVersionInputSchema,
  createTaskInputSchema,
  rejectRunInputSchema,
  taskCommandInputSchema,
  updateSkillInputSchema,
  updateTaskInputSchema,
  validateSkillInputSchema,
  workerStatusSchema,
  type DomainEvent,
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
    });
    publish(eventBus, result);
    return reply.code(201).send({ project: result.value });
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
      return { files: [], conflictPreview: null };
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
    return { files, conflictPreview };
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
    if (hasBuiltWeb) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({
      error: { code: "WEB_NOT_BUILT", message: "Web 应用尚未构建，请使用 Vite 开发服务" },
    });
  });

  return app;
}
