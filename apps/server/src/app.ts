import { existsSync } from "node:fs";
import type { DevLoopRepository, EventfulResult } from "@devloop/db";
import { GitApplyError, type GitService } from "@devloop/git";
import type { AgentRunner } from "@devloop/runners";
import {
  confirmTaskInputSchema,
  createPairingSessionInputSchema,
  createProjectInputSchema,
  createTaskInputSchema,
  pairDeviceInputSchema,
  rejectRunInputSchema,
  taskCommandInputSchema,
  updateDeviceInputSchema,
  updateTaskInputSchema,
  workerStatusSchema,
  type DomainEvent,
  type Task,
} from "@devloop/shared";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { DomainEventBus } from "./event-bus.js";
import type { AgentWorker } from "./agent-worker.js";
import { HttpError, deviceCookieName, requireLocalEditor, requireRole } from "./http.js";
import type { RuntimeConfig } from "./runtime-config.js";

export interface CreateAppOptions {
  config: RuntimeConfig;
  repository: DevLoopRepository;
  gitService: GitService;
  runners: AgentRunner[];
  eventBus: DomainEventBus;
  worker: AgentWorker;
}

const taskParamSchema = z.object({ taskId: z.string().uuid() });
const runParamSchema = z.object({ runId: z.string().uuid() });
const deviceParamSchema = z.object({ deviceId: z.string().uuid() });
const runQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const publish = (eventBus: DomainEventBus, result: EventfulResult<unknown>): void => {
  eventBus.publish(result.events);
};

const mapRepositoryError = (error: Error): HttpError | null => {
  if (error instanceof GitApplyError) {
    return new HttpError(409, error.message, error.code);
  }
  if (error.message.includes("not found")) {
    return new HttpError(404, "请求的资源不存在", "NOT_FOUND");
  }
  if (
    error.message.startsWith("Version conflict") ||
    error.message.startsWith("Invalid task transition") ||
    error.message.startsWith("Only ") ||
    error.message.includes("changed; reload")
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
  const { config, repository, gitService, runners, eventBus, worker } = options;
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

  await app.register(cookie);

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
      error: { code: "INTERNAL_ERROR", message: "本地服务处理请求时发生错误" },
    });
  });

  app.get("/api/health", async () => ({
    status: "ok",
    service: "devloop",
    time: new Date().toISOString(),
  }));

  app.get("/api/session", async (request) => {
    const identity = requireRole(request, repository, "viewer");
    return { identity };
  });

  app.post("/api/session/logout", async (_request, reply) => {
    reply.clearCookie(deviceCookieName, { path: "/" });
    return { ok: true };
  });

  app.get("/api/dashboard", async (request) => {
    requireRole(request, repository, "viewer");
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
    requireRole(request, repository, "viewer");
    return { projects: repository.listProjects() };
  });

  app.post("/api/projects", async (request, reply) => {
    requireLocalEditor(request, repository);
    const input = createProjectInputSchema.parse(request.body);
    const git = await gitService.inspectRepository(input.path);
    const existing = repository.findProjectByPath(git.path);
    if (existing) {
      throw new HttpError(409, "该项目已经注册", "ALREADY_EXISTS");
    }
    const result = repository.createProject({
      name: input.name,
      path: git.path,
      defaultBaseRef: input.defaultBaseRef,
      headCommit: git.headCommit,
    });
    publish(eventBus, result);
    return reply.code(201).send({ project: result.value });
  });

  app.get("/api/tasks", async (request) => {
    requireRole(request, repository, "viewer");
    return { tasks: repository.listTasks() };
  });

  app.get("/api/tasks/:taskId", async (request) => {
    requireRole(request, repository, "viewer");
    const { taskId } = taskParamSchema.parse(request.params);
    const task = repository.getTask(taskId);
    if (!task) {
      throw new HttpError(404, "任务不存在", "NOT_FOUND");
    }
    return { task };
  });

  app.post("/api/tasks", async (request, reply) => {
    const identity = requireRole(request, repository, "editor");
    const input = createTaskInputSchema.parse(request.body);
    const result = repository.createTask(input);
    publish(eventBus, result);
    const task = autoQueueTask(result.value, identity.id);
    return reply.code(201).send({ task });
  });

  app.patch("/api/tasks/:taskId", async (request) => {
    const identity = requireRole(request, repository, "editor");
    const { taskId } = taskParamSchema.parse(request.params);
    const input = updateTaskInputSchema.parse(request.body);
    const result = repository.updateDraftTask(taskId, identity.id, input);
    publish(eventBus, result);
    const task = autoQueueTask(result.value, identity.id);
    return { task, replayed: result.replayed };
  });

  app.post("/api/tasks/:taskId/confirm", async (request) => {
    const identity = requireRole(request, repository, "editor");
    const { taskId } = taskParamSchema.parse(request.params);
    const input = confirmTaskInputSchema.parse(request.body);
    const result = repository.confirmTask(taskId, identity.id, input);
    publish(eventBus, result);
    worker.wake();
    return { task: result.value, replayed: result.replayed };
  });

  app.post("/api/tasks/:taskId/unconfirm", async (request) => {
    const identity = requireRole(request, repository, "editor");
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

  app.get("/api/runs", async (request) => {
    requireRole(request, repository, "viewer");
    const { limit } = runQuerySchema.parse(request.query);
    return { runs: repository.listRuns(limit) };
  });

  app.get("/api/runs/:runId", async (request) => {
    requireRole(request, repository, "viewer");
    const { runId } = runParamSchema.parse(request.params);
    const run = repository.getRun(runId);
    if (!run) {
      throw new HttpError(404, "执行记录不存在", "NOT_FOUND");
    }
    return {
      run,
      task: repository.getTask(run.taskId),
      events: repository.getRunEvents(runId),
    };
  });

  app.post("/api/runs/:runId/approve", async (request) => {
    const identity = requireRole(request, repository, "operator");
    const { runId } = runParamSchema.parse(request.params);
    const input = taskCommandInputSchema.parse(request.body);
    const result = repository.approveRun(
      runId,
      identity.id,
      input.expectedVersion,
      input.idempotencyKey,
    );
    publish(eventBus, result);
    return { task: result.value, replayed: result.replayed };
  });

  app.post("/api/runs/:runId/apply", async (request) => {
    const identity = requireLocalEditor(request, repository);
    const { runId } = runParamSchema.parse(request.params);
    const input = taskCommandInputSchema.parse(request.body);
    const context = repository.getRunApplicationContext(runId, input.expectedVersion);
    const application = await gitService.applyCommitToWorkingTree({
      repositoryPath: context.projectPath,
      resultCommit: context.resultCommit,
    });
    const result = repository.recordRunApplication(
      runId,
      identity.id,
      input.expectedVersion,
      input.idempotencyKey,
      application,
    );
    publish(eventBus, result);
    return { application: result.value, replayed: result.replayed };
  });

  app.post("/api/runs/:runId/reject", async (request) => {
    const identity = requireRole(request, repository, "operator");
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
    requireRole(request, repository, "operator");
    const input = z.object({ status: workerStatusSchema }).parse(request.body);
    if (input.status !== "RUNNING" && input.status !== "PAUSED") {
      throw new HttpError(400, "只允许启动或暂停 Worker", "INVALID_WORKER_STATUS");
    }
    worker.setStatus(input.status);
    return { worker: repository.getWorkerState() };
  });

  app.get("/api/devices", async (request) => {
    requireLocalEditor(request, repository);
    return { devices: repository.listDevices() };
  });

  app.post("/api/devices/pairing", async (request, reply) => {
    requireLocalEditor(request, repository);
    const input = createPairingSessionInputSchema.parse(request.body ?? {});
    const pairing = repository.createPairingSession(
      input.externalBaseUrl ?? config.externalBaseUrl,
    );
    return reply.code(201).send({ pairing });
  });

  app.post("/api/pair", async (request, reply) => {
    const input = pairDeviceInputSchema.parse(request.body);
    const result = repository.pairDevice(input.code, input.name);
    eventBus.publish(result.events);
    reply.setCookie(deviceCookieName, result.token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: request.protocol === "https",
      maxAge: 60 * 60 * 24 * 90,
    });
    return reply.code(201).send({ device: result.device });
  });

  app.patch("/api/devices/:deviceId", async (request) => {
    const identity = requireLocalEditor(request, repository);
    const { deviceId } = deviceParamSchema.parse(request.params);
    const input = updateDeviceInputSchema.parse(request.body);
    const result = repository.updateDeviceRole(
      deviceId,
      input.role,
      input.expectedVersion,
      identity.id,
      input.idempotencyKey,
    );
    publish(eventBus, result);
    return { device: result.value, replayed: result.replayed };
  });

  app.delete("/api/devices/:deviceId", async (request) => {
    const identity = requireLocalEditor(request, repository);
    const { deviceId } = deviceParamSchema.parse(request.params);
    const input = taskCommandInputSchema.parse(request.body);
    const result = repository.revokeDevice(
      deviceId,
      input.expectedVersion,
      identity.id,
      input.idempotencyKey,
    );
    publish(eventBus, result);
    return { device: result.value, replayed: result.replayed };
  });

  app.get("/api/events", async (request, reply) => {
    requireRole(request, repository, "viewer");
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
