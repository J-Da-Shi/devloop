import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  assertTaskTransition,
  type BaseStrategy,
  type CreateTaskInput,
  type DeviceRole,
  type DomainEvent,
  type PairedDevice,
  type Project,
  type RunApplicationResult,
  type RunPublishResult,
  type RunEvent,
  type RunStatus,
  type Skill,
  type SkillVersion,
  type Task,
  type TaskRun,
  type TaskStatus,
  type WorkerState,
} from "@devloop/shared";
import { and, desc, eq, gt, isNotNull, isNull, lte, max } from "drizzle-orm";
import type { DatabaseHandle } from "./client.js";
import {
  domainEvents,
  pairedDevices,
  pairingSessions,
  projects,
  remoteCommands,
  reviewDecisions,
  runEvents,
  skills,
  skillVersions,
  taskRevisions,
  taskRuns,
  tasks,
  workerState,
  type DomainEventRow,
  type PairedDeviceRow,
  type ProjectRow,
  type RunEventRow,
  type SkillRow,
  type SkillVersionRow,
  type TaskRow,
  type TaskRunRow,
} from "./schema.js";

const now = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const parseStringArray = (value: string): string[] => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("数据库中的字符串数组格式无效");
  }
  return parsed;
};

const mapProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  repositoryUrl: row.repositoryUrl,
  defaultBaseRef: row.defaultBaseRef,
  integrationRef: row.integrationRef,
  integrationCommit: row.integrationCommit,
  lastFetchedAt: row.lastFetchedAt,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapTask = (row: TaskRow, projectName: string): Task => ({
  id: row.id,
  projectId: row.projectId,
  projectName,
  targetBranch: row.targetBranch,
  title: row.title,
  goal: row.goal,
  acceptanceCriteria: parseStringArray(row.acceptanceCriteriaJson),
  status: row.status,
  priority: row.priority,
  activeRevisionId: row.activeRevisionId,
  latestRunId: row.latestRunId,
  deletedAt: row.deletedAt,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapRun = (row: TaskRunRow): TaskRun => ({
  id: row.id,
  taskId: row.taskId,
  taskRevisionId: row.taskRevisionId,
  targetBranch: row.targetBranch,
  runner: row.runner,
  status: row.status,
  baseCommit: row.baseCommit,
  resultCommit: row.resultCommit,
  branchName: row.branchName,
  runnerVersion: row.runnerVersion,
  executionToken: row.executionToken,
  pushedAt: row.pushedAt,
  pushedCommit: row.pushedCommit,
  summary: row.summary,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
});

const mapRunEvent = (row: RunEventRow): RunEvent => ({
  id: row.id,
  runId: row.runId,
  sequence: row.sequence,
  type: row.type,
  message: row.message,
  createdAt: row.createdAt,
});

const mapDevice = (row: PairedDeviceRow): PairedDevice => ({
  id: row.id,
  name: row.name,
  role: row.role,
  lastSeenAt: row.lastSeenAt,
  revokedAt: row.revokedAt,
  version: row.version,
  createdAt: row.createdAt,
});

const mapSkillVersion = (row: SkillVersionRow): SkillVersion => ({
  id: row.id,
  skillId: row.skillId,
  version: row.version,
  contentHash: row.contentHash,
  createdByDeviceId: row.createdByDeviceId,
  createdAt: row.createdAt,
});

const mapSkill = (row: SkillRow, currentVersion: SkillVersionRow): Skill => ({
  id: row.id,
  name: row.name,
  description: row.description,
  enabled: row.enabled,
  currentVersionId: row.currentVersionId,
  currentVersion: currentVersion.version,
  contentHash: currentVersion.contentHash,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapDomainEvent = (row: DomainEventRow): DomainEvent => ({
  id: row.id,
  aggregateType: row.aggregateType as DomainEvent["aggregateType"],
  aggregateId: row.aggregateId,
  type: row.type,
  payload: JSON.parse(row.payloadJson) as unknown,
  createdAt: row.createdAt,
});

export interface EventfulResult<T> {
  value: T;
  events: DomainEvent[];
  replayed: boolean;
}

export interface RegisteredProjectInput {
  id?: string;
  name: string;
  repositoryUrl: string | null;
  repositoryPath: string;
  defaultBaseRef: string;
  headCommit: string;
  lastFetchedAt?: string | null;
}

export interface ProjectExecutionContext {
  project: Project;
  repositoryPath: string;
}

export interface ClaimedTask {
  task: Task;
  run: TaskRun;
  projectPath: string;
  projectDefaultBaseRef: string;
  goal: string;
  acceptanceCriteria: string[];
}

export interface RunApplicationContext {
  projectPath: string;
  targetBranch: string;
  baseCommit: string;
  resultCommit: string;
}

export interface RunPublishContext {
  repositoryPath: string;
  targetBranch: string;
  baseCommit: string;
  resultCommit: string;
}

export interface PublishedRunApproval {
  task: Task;
  publication: RunPublishResult;
}

export interface StoredSkillVersionInput {
  name: string;
  description: string;
  contentHash: string;
  storagePath: string;
}

export interface StoredSkillDetails {
  skill: Skill;
  versions: SkillVersion[];
  storagePath: string;
}

export class DevLoopRepository {
  public constructor(private readonly handle: DatabaseHandle) {}

  listProjects(): Project[] {
    return this.handle.db.select().from(projects).orderBy(projects.name).all().map(mapProject);
  }

  createProject(input: RegisteredProjectInput): EventfulResult<Project> {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const integrationRef = `refs/devloop/${id}/accepted`;

    const result = this.handle.sqlite.transaction(() => {
      const row = this.handle.db
        .insert(projects)
        .values({
          id,
          name: input.name,
          path: input.repositoryPath,
          repositoryUrl: input.repositoryUrl,
          lastFetchedAt: input.lastFetchedAt ?? timestamp,
          defaultBaseRef: input.defaultBaseRef,
          integrationRef,
          integrationCommit: input.headCommit,
          version: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get();
      const event = this.insertDomainEvent("project", id, "project.created", {
        projectId: id,
      });
      return { value: mapProject(row), events: [event], replayed: false };
    })();

    return result;
  }

  findProjectByRepositoryUrl(repositoryUrl: string): Project | null {
    const row = this.handle.db
      .select()
      .from(projects)
      .where(eq(projects.repositoryUrl, repositoryUrl))
      .get();
    return row ? mapProject(row) : null;
  }

  getProjectExecutionContext(projectId: string): ProjectExecutionContext | null {
    const row = this.handle.db.select().from(projects).where(eq(projects.id, projectId)).get();
    return row ? { project: mapProject(row), repositoryPath: row.path } : null;
  }

  recordProjectFetch(projectId: string, headCommit?: string): EventfulResult<Project> {
    return this.handle.sqlite.transaction(() => {
      const current = this.requireProjectRow(projectId);
      const timestamp = now();
      const row = this.handle.db
        .update(projects)
        .set({
          lastFetchedAt: timestamp,
          integrationCommit: headCommit ?? current.integrationCommit,
          version: current.version + 1,
          updatedAt: timestamp,
        })
        .where(and(eq(projects.id, projectId), eq(projects.version, current.version)))
        .returning()
        .get();
      if (!row) {
        throw new Error("Version conflict: 项目已被其他请求更新");
      }
      const event = this.insertDomainEvent("project", projectId, "project.synced", {
        projectId,
        lastFetchedAt: timestamp,
      });
      return { value: mapProject(row), events: [event], replayed: false };
    })();
  }

  listSkills(): Skill[] {
    return this.handle.db
      .select({ skill: skills, currentVersion: skillVersions })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
      .orderBy(skills.name)
      .all()
      .map(({ skill, currentVersion }) => mapSkill(skill, currentVersion));
  }

  getSkillDetails(skillId: string): StoredSkillDetails | null {
    const current = this.handle.db
      .select({ skill: skills, currentVersion: skillVersions })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
      .where(eq(skills.id, skillId))
      .get();
    if (!current) {
      return null;
    }
    const versions = this.handle.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .orderBy(desc(skillVersions.version))
      .all();
    return {
      skill: mapSkill(current.skill, current.currentVersion),
      versions: versions.map(mapSkillVersion),
      storagePath: current.currentVersion.storagePath,
    };
  }

  createSkill(input: StoredSkillVersionInput, deviceId: string): EventfulResult<Skill> {
    const skillId = randomUUID();
    const versionId = randomUUID();
    const timestamp = now();
    return this.handle.sqlite.transaction(() => {
      const skillRow = this.handle.db
        .insert(skills)
        .values({
          id: skillId,
          name: input.name,
          description: input.description,
          enabled: true,
          currentVersionId: versionId,
          version: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get();
      const versionRow = this.handle.db
        .insert(skillVersions)
        .values({
          id: versionId,
          skillId,
          version: 1,
          contentHash: input.contentHash,
          storagePath: input.storagePath,
          createdByDeviceId: deviceId,
          createdAt: timestamp,
        })
        .returning()
        .get();
      const event = this.insertDomainEvent("skill", skillId, "skill.created", {
        skillId,
        version: 1,
      });
      return { value: mapSkill(skillRow, versionRow), events: [event], replayed: false };
    })();
  }

  createSkillVersion(
    skillId: string,
    deviceId: string,
    input: StoredSkillVersionInput & { expectedVersion: number; idempotencyKey: string },
  ): EventfulResult<Skill> {
    return this.executeIdempotent(
      deviceId,
      input.idempotencyKey,
      "skill.create_version",
      input.expectedVersion,
      () => {
        const current = this.requireSkillRow(skillId);
        this.assertVersion(current.version, input.expectedVersion);
        if (input.name !== current.name) {
          throw new Error("Skill 名称发布后不能修改");
        }
        const currentVersion = this.requireSkillVersionRow(current.currentVersionId);
        if (currentVersion.contentHash === input.contentHash) {
          throw new Error("Skill 内容没有变化");
        }
        const nextVersion = currentVersion.version + 1;
        const versionId = randomUUID();
        const timestamp = now();
        const versionRow = this.handle.db
          .insert(skillVersions)
          .values({
            id: versionId,
            skillId,
            version: nextVersion,
            contentHash: input.contentHash,
            storagePath: input.storagePath,
            createdByDeviceId: deviceId,
            createdAt: timestamp,
          })
          .returning()
          .get();
        const skillRow = this.handle.db
          .update(skills)
          .set({
            description: input.description,
            currentVersionId: versionId,
            version: current.version + 1,
            updatedAt: timestamp,
          })
          .where(and(eq(skills.id, skillId), eq(skills.version, input.expectedVersion)))
          .returning()
          .get();
        if (!skillRow) {
          throw new Error("Version conflict: Skill 已被其他设备修改");
        }
        const event = this.insertDomainEvent("skill", skillId, "skill.version_created", {
          skillId,
          version: nextVersion,
        });
        return { value: mapSkill(skillRow, versionRow), events: [event] };
      },
    );
  }

  setSkillEnabled(
    skillId: string,
    enabled: boolean,
    expectedVersion: number,
    deviceId: string,
    idempotencyKey: string,
  ): EventfulResult<Skill> {
    return this.executeIdempotent(
      deviceId,
      idempotencyKey,
      "skill.set_enabled",
      expectedVersion,
      () => {
        const current = this.requireSkillRow(skillId);
        this.assertVersion(current.version, expectedVersion);
        const currentVersion = this.requireSkillVersionRow(current.currentVersionId);
        const timestamp = now();
        const row = this.handle.db
          .update(skills)
          .set({ enabled, version: current.version + 1, updatedAt: timestamp })
          .where(and(eq(skills.id, skillId), eq(skills.version, expectedVersion)))
          .returning()
          .get();
        if (!row) {
          throw new Error("Version conflict: Skill 已被其他设备修改");
        }
        const event = this.insertDomainEvent("skill", skillId, "skill.updated", {
          skillId,
          enabled,
        });
        return { value: mapSkill(row, currentVersion), events: [event] };
      },
    );
  }

  listTasks(): Task[] {
    return this.handle.db
      .select({ task: tasks, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(isNull(tasks.deletedAt))
      .orderBy(desc(tasks.updatedAt))
      .all()
      .map(({ task, projectName }) => mapTask(task, projectName));
  }

  getTask(taskId: string): Task | null {
    const row = this.handle.db
      .select({ task: tasks, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
      .get();
    return row ? mapTask(row.task, row.projectName) : null;
  }

  getTaskIncludingDeleted(taskId: string): Task | null {
    const row = this.handle.db
      .select({ task: tasks, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(eq(tasks.id, taskId))
      .get();
    return row ? mapTask(row.task, row.projectName) : null;
  }

  createTask(input: CreateTaskInput): EventfulResult<Task> {
    const id = randomUUID();
    const timestamp = now();

    return this.handle.sqlite.transaction(() => {
      const project = this.handle.db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .get();
      if (!project) {
        throw new Error("项目不存在");
      }

      const row = this.handle.db
        .insert(tasks)
        .values({
          id,
          projectId: input.projectId,
          targetBranch: input.targetBranch,
          title: input.title,
          goal: input.goal,
          acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria),
          status: "DRAFT",
          priority: input.priority,
          activeRevisionId: null,
          latestRunId: null,
          deletedAt: null,
          deletedByDeviceId: null,
          version: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get();
      const event = this.insertDomainEvent("task", id, "task.created", { taskId: id });
      return { value: mapTask(row, project.name), events: [event], replayed: false };
    })();
  }

  updateDraftTask(
    taskId: string,
    deviceId: string,
    input: {
      targetBranch?: string | undefined;
      title?: string | undefined;
      goal?: string | undefined;
      acceptanceCriteria?: string[] | undefined;
      priority?: number | undefined;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): EventfulResult<Task> {
    return this.executeIdempotent(
      deviceId,
      input.idempotencyKey,
      "task.update",
      input.expectedVersion,
      () => {
        const current = this.requireTaskRow(taskId);
        if (current.status !== "DRAFT") {
          throw new Error("只有草稿任务可以编辑");
        }
        this.assertVersion(current.version, input.expectedVersion);
        const timestamp = now();
        const project = this.requireProjectRow(current.projectId);
        const row = this.handle.db
          .update(tasks)
          .set({
            targetBranch: input.targetBranch ?? current.targetBranch,
            title: input.title ?? current.title,
            goal: input.goal ?? current.goal,
            acceptanceCriteriaJson:
              input.acceptanceCriteria === undefined
                ? current.acceptanceCriteriaJson
                : JSON.stringify(input.acceptanceCriteria),
            priority: input.priority ?? current.priority,
            version: current.version + 1,
            updatedAt: timestamp,
          })
          .where(and(eq(tasks.id, taskId), eq(tasks.version, input.expectedVersion)))
          .returning()
          .get();
        const event = this.insertDomainEvent("task", taskId, "task.updated", {
          taskId,
          version: row.version,
        });
        return { value: mapTask(row, project.name), events: [event] };
      },
    );
  }

  confirmTask(
    taskId: string,
    deviceId: string,
    input: {
      expectedVersion: number;
      idempotencyKey: string;
      baseStrategy: BaseStrategy;
      baseRef: string;
    },
  ): EventfulResult<Task> {
    return this.executeIdempotent(
      deviceId,
      input.idempotencyKey,
      "task.confirm",
      input.expectedVersion,
      () => {
        const current = this.requireTaskRow(taskId);
        assertTaskTransition(current.status, "READY");
        this.assertVersion(current.version, input.expectedVersion);
        const project = this.requireProjectRow(current.projectId);
        const revisionNumber =
          (this.handle.db
            .select({ value: max(taskRevisions.revision) })
            .from(taskRevisions)
            .where(eq(taskRevisions.taskId, taskId))
            .get()?.value ?? 0) + 1;
        const timestamp = now();
        const revisionId = randomUUID();
        const spec = {
          title: current.title,
          goal: current.goal,
          acceptanceCriteria: parseStringArray(current.acceptanceCriteriaJson),
          baseStrategy: input.baseStrategy,
          baseRef: current.targetBranch,
          targetBranch: current.targetBranch,
        };
        const specJson = JSON.stringify(spec);
        this.handle.db
          .insert(taskRevisions)
          .values({
            id: revisionId,
            taskId,
            revision: revisionNumber,
            specJson,
            specHash: hash(specJson),
            targetBranch: current.targetBranch,
            baseRef: current.targetBranch,
            baseStrategy: input.baseStrategy,
            confirmedBaseCommit: project.integrationCommit,
            createdFrom: current.activeRevisionId ?? "draft",
            createdByDeviceId: deviceId,
            confirmedAt: timestamp,
          })
          .run();
        const row = this.handle.db
          .update(tasks)
          .set({
            status: "READY",
            activeRevisionId: revisionId,
            version: current.version + 1,
            updatedAt: timestamp,
          })
          .where(and(eq(tasks.id, taskId), eq(tasks.version, input.expectedVersion)))
          .returning()
          .get();
        const event = this.insertDomainEvent("task", taskId, "task.status_changed", {
          taskId,
          from: current.status,
          to: "READY",
        });
        return { value: mapTask(row, project.name), events: [event] };
      },
    );
  }

  autoQueueTask(taskId: string, deviceId: string): EventfulResult<Task> | null {
    const current = this.requireTaskRow(taskId);
    if (current.status !== "DRAFT" || current.priority !== 100) {
      return null;
    }
    return this.confirmTask(taskId, deviceId, {
      expectedVersion: current.version,
      idempotencyKey: randomUUID(),
      baseStrategy: "LATEST_ACCEPTED",
      baseRef: current.targetBranch,
    });
  }

  unconfirmTask(
    taskId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<Task> {
    return this.executeIdempotent(
      deviceId,
      idempotencyKey,
      "task.unconfirm",
      expectedVersion,
      () => {
        const current = this.requireTaskRow(taskId);
        assertTaskTransition(current.status, "DRAFT");
        this.assertVersion(current.version, expectedVersion);
        const project = this.requireProjectRow(current.projectId);
        const row = this.handle.db
          .update(tasks)
          .set({ status: "DRAFT", version: current.version + 1, updatedAt: now() })
          .where(and(eq(tasks.id, taskId), eq(tasks.version, expectedVersion)))
          .returning()
          .get();
        const event = this.insertDomainEvent("task", taskId, "task.status_changed", {
          taskId,
          from: current.status,
          to: "DRAFT",
        });
        return { value: mapTask(row, project.name), events: [event] };
      },
    );
  }

  deleteTask(
    taskId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<Task> {
    return this.executeIdempotent(deviceId, idempotencyKey, "task.delete", expectedVersion, () => {
      const current = this.requireTaskRow(taskId);
      if (current.status === "RUNNING") {
        throw new Error("执行中的任务不能删除，请先取消执行");
      }
      this.assertVersion(current.version, expectedVersion);
      const project = this.requireProjectRow(current.projectId);
      const timestamp = now();
      const row = this.handle.db
        .update(tasks)
        .set({
          deletedAt: timestamp,
          deletedByDeviceId: deviceId,
          version: current.version + 1,
          updatedAt: timestamp,
        })
        .where(
          and(eq(tasks.id, taskId), eq(tasks.version, expectedVersion), isNull(tasks.deletedAt)),
        )
        .returning()
        .get();
      if (!row) {
        throw new Error("Version conflict: 任务已被其他设备修改");
      }
      const event = this.insertDomainEvent("task", taskId, "task.deleted", {
        taskId,
        deletedAt: timestamp,
        deletedByDeviceId: deviceId,
      });
      return { value: mapTask(row, project.name), events: [event] };
    });
  }

  claimNextTask(
    runner: string,
    readyBefore = now(),
    runnerVersion: string | null = null,
  ): EventfulResult<ClaimedTask> | null {
    return this.handle.sqlite.transaction(() => {
      const selected = this.handle.db
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(
          projects,
          and(eq(projects.id, tasks.projectId), isNotNull(projects.repositoryUrl)),
        )
        .where(
          and(
            eq(tasks.status, "READY"),
            isNull(tasks.deletedAt),
            lte(tasks.updatedAt, readyBefore),
          ),
        )
        .orderBy(desc(tasks.priority), tasks.createdAt)
        .get();
      const current = selected?.task;
      if (!current || !current.activeRevisionId) {
        return null;
      }

      const revision = this.handle.db
        .select()
        .from(taskRevisions)
        .where(eq(taskRevisions.id, current.activeRevisionId))
        .get();
      if (!revision) {
        throw new Error("任务的当前 Revision 不存在");
      }
      const project = this.requireProjectRow(current.projectId);
      assertTaskTransition(current.status, "RUNNING");
      const baseCommit =
        revision.baseStrategy === "LATEST_ACCEPTED"
          ? project.integrationCommit
          : revision.confirmedBaseCommit;
      const runId = randomUUID();
      const executionToken = randomUUID();
      const timestamp = now();
      const runInputHash = hash(
        JSON.stringify({
          taskRevisionId: revision.id,
          targetBranch: revision.targetBranch,
          baseCommit,
          runner,
          specHash: revision.specHash,
        }),
      );
      const runRow = this.handle.db
        .insert(taskRuns)
        .values({
          id: runId,
          taskId: current.id,
          taskRevisionId: revision.id,
          targetBranch: revision.targetBranch,
          runner,
          status: "CLAIMED",
          baseCommit,
          resultCommit: null,
          worktreePath: null,
          branchName: null,
          executionToken,
          processGroupId: null,
          runnerVersion: runner === "fake" ? "built-in" : runnerVersion,
          pushedAt: null,
          pushedCommit: null,
          runInputHash,
          summary: null,
          startedAt: timestamp,
          finishedAt: null,
        })
        .returning()
        .get();
      const taskRow = this.handle.db
        .update(tasks)
        .set({
          status: "RUNNING",
          latestRunId: runId,
          version: current.version + 1,
          updatedAt: timestamp,
        })
        .where(eq(tasks.id, current.id))
        .returning()
        .get();
      const worker = this.getWorkerState();
      this.handle.db
        .update(workerState)
        .set({
          activeRunId: runId,
          heartbeatAt: timestamp,
          version: worker.version + 1,
        })
        .where(eq(workerState.id, "primary"))
        .run();
      this.insertRunEvent(runId, "run.claimed", "Worker claimed the task", {});
      const taskEvent = this.insertDomainEvent("task", current.id, "task.status_changed", {
        taskId: current.id,
        from: "READY",
        to: "RUNNING",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.started", {
        runId,
        taskId: current.id,
      });
      return {
        value: {
          task: mapTask(taskRow, project.name),
          run: mapRun(runRow),
          projectPath: project.path,
          projectDefaultBaseRef: project.defaultBaseRef,
          goal: current.goal,
          acceptanceCriteria: parseStringArray(current.acceptanceCriteriaJson),
        },
        events: [taskEvent, runEvent],
        replayed: false,
      };
    })();
  }

  setRunWorkspace(
    runId: string,
    executionToken: string,
    input: { worktreePath: string; branchName: string },
  ): EventfulResult<TaskRun> {
    return this.handle.sqlite.transaction(() => {
      const row = this.handle.db
        .update(taskRuns)
        .set({ worktreePath: input.worktreePath, branchName: input.branchName })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!row) {
        throw new Error("当前 Run 的执行令牌已经失去 Worktree 所有权");
      }
      this.insertRunEvent(runId, "run.workspace_ready", "独立 Git Worktree 已准备完成", {
        worktreePath: input.worktreePath,
        branchName: input.branchName,
      });
      const event = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        status: row.status,
        message: "独立 Git Worktree 已准备完成",
      });
      return { value: mapRun(row), events: [event], replayed: false };
    })();
  }

  setRunBaseCommit(
    runId: string,
    executionToken: string,
    input: { targetBranch: string; baseCommit: string },
  ): EventfulResult<TaskRun> {
    return this.handle.sqlite.transaction(() => {
      const current = this.requireRunRow(runId);
      if (current.executionToken !== executionToken || current.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失去基础 Commit 所有权");
      }
      const revision = this.handle.db
        .select()
        .from(taskRevisions)
        .where(eq(taskRevisions.id, current.taskRevisionId))
        .get();
      if (!revision) {
        throw new Error("执行记录关联的 Revision 不存在");
      }
      const runInputHash = hash(
        JSON.stringify({
          taskRevisionId: revision.id,
          targetBranch: input.targetBranch,
          baseCommit: input.baseCommit,
          runner: current.runner,
          specHash: revision.specHash,
        }),
      );
      const row = this.handle.db
        .update(taskRuns)
        .set({ targetBranch: input.targetBranch, baseCommit: input.baseCommit, runInputHash })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!row) {
        throw new Error("当前 Run 的执行令牌已经失去基础 Commit 所有权");
      }
      this.insertRunEvent(
        runId,
        "run.base_resolved",
        `执行基线已解析：${input.baseCommit.slice(0, 12)}`,
        { baseCommit: input.baseCommit, targetBranch: input.targetBranch },
      );
      const event = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        status: row.status,
        message: "目标分支执行基线已解析",
      });
      return { value: mapRun(row), events: [event], replayed: false };
    })();
  }

  setRunPhase(
    runId: string,
    executionToken: string,
    status: RunStatus,
    eventType: string,
    message: string,
    data?: Record<string, unknown>,
  ): EventfulResult<TaskRun> {
    return this.handle.sqlite.transaction(() => {
      const current = this.requireRunRow(runId);
      if (current.executionToken !== executionToken || current.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const row = this.handle.db
        .update(taskRuns)
        .set({ status })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!row) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      this.insertRunEvent(runId, eventType, message, data ? { status, ...data } : { status });
      const event = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        status,
        message,
      });
      return { value: mapRun(row), events: [event], replayed: false };
    })();
  }

  completeRun(
    runId: string,
    executionToken: string,
    summary: string,
    resultCommit?: string,
  ): EventfulResult<{ task: Task; run: TaskRun }> {
    return this.handle.sqlite.transaction(() => {
      const currentRun = this.requireRunRow(runId);
      if (currentRun.executionToken !== executionToken || currentRun.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (currentTask.status !== "RUNNING" || currentTask.latestRunId !== runId) {
        throw new Error("当前任务已经不再由此 Run 执行");
      }
      assertTaskTransition(currentTask.status, "REVIEW");
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const runRow = this.handle.db
        .update(taskRuns)
        .set({
          status: "SUCCEEDED",
          summary,
          resultCommit: resultCommit ?? currentRun.baseCommit,
          finishedAt: timestamp,
        })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!runRow) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const taskRow = this.handle.db
        .update(tasks)
        .set({
          status: "REVIEW",
          version: currentTask.version + 1,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, currentTask.version),
            eq(tasks.status, "RUNNING"),
            eq(tasks.latestRunId, runId),
            isNull(tasks.deletedAt),
          ),
        )
        .returning()
        .get();
      if (!taskRow) {
        throw new Error("当前任务已经不再由此 Run 执行");
      }
      const worker = this.getWorkerState();
      this.handle.db
        .update(workerState)
        .set({
          activeRunId: null,
          heartbeatAt: timestamp,
          version: worker.version + 1,
        })
        .where(and(eq(workerState.id, "primary"), eq(workerState.activeRunId, runId)))
        .run();
      this.insertRunEvent(runId, "run.finished", "审核结果包已准备完成", { summary });
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "RUNNING",
        to: "REVIEW",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.finished", {
        runId,
        outcome: "succeeded",
      });
      return {
        value: { task: mapTask(taskRow, project.name), run: mapRun(runRow) },
        events: [taskEvent, runEvent],
        replayed: false,
      };
    })();
  }

  failRun(
    runId: string,
    executionToken: string,
    errorMessage: string,
  ): EventfulResult<{ task: Task; run: TaskRun }> {
    return this.handle.sqlite.transaction(() => {
      const currentRun = this.requireRunRow(runId);
      if (currentRun.executionToken !== executionToken || currentRun.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (currentTask.status !== "RUNNING" || currentTask.latestRunId !== runId) {
        throw new Error("当前任务已经不再由此 Run 执行");
      }
      assertTaskTransition(currentTask.status, "FAILED");
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const runRow = this.handle.db
        .update(taskRuns)
        .set({ status: "FAILED", summary: errorMessage, finishedAt: timestamp })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!runRow) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const taskRow = this.handle.db
        .update(tasks)
        .set({ status: "FAILED", version: currentTask.version + 1, updatedAt: timestamp })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, currentTask.version),
            eq(tasks.status, "RUNNING"),
            eq(tasks.latestRunId, runId),
            isNull(tasks.deletedAt),
          ),
        )
        .returning()
        .get();
      if (!taskRow) {
        throw new Error("当前任务已经不再由此 Run 执行");
      }
      const worker = this.getWorkerState();
      this.handle.db
        .update(workerState)
        .set({
          activeRunId: null,
          heartbeatAt: timestamp,
          version: worker.version + 1,
        })
        .where(and(eq(workerState.id, "primary"), eq(workerState.activeRunId, runId)))
        .run();
      this.insertRunEvent(runId, "run.failed", errorMessage, {});
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "RUNNING",
        to: "FAILED",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.finished", {
        runId,
        outcome: "failed",
      });
      return {
        value: { task: mapTask(taskRow, project.name), run: mapRun(runRow) },
        events: [taskEvent, runEvent],
        replayed: false,
      };
    })();
  }

  blockRun(
    runId: string,
    executionToken: string,
    reason: string,
  ): EventfulResult<{ task: Task; run: TaskRun }> {
    return this.handle.sqlite.transaction(() => {
      const currentRun = this.requireRunRow(runId);
      if (currentRun.executionToken !== executionToken || currentRun.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (currentTask.status !== "RUNNING" || currentTask.latestRunId !== runId) {
        throw new Error("当前任务已经不再由此 Run 执行");
      }
      assertTaskTransition(currentTask.status, "BLOCKED");
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const runRow = this.handle.db
        .update(taskRuns)
        .set({ status: "BLOCKED", summary: reason, finishedAt: timestamp })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!runRow) {
        throw new Error("当前 Run 的执行令牌已经失效");
      }
      const taskRow = this.handle.db
        .update(tasks)
        .set({ status: "BLOCKED", version: currentTask.version + 1, updatedAt: timestamp })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, currentTask.version),
            eq(tasks.status, "RUNNING"),
            eq(tasks.latestRunId, runId),
            isNull(tasks.deletedAt),
          ),
        )
        .returning()
        .get();
      if (!taskRow) {
        throw new Error("当前任务已经不再由此 Run 执行");
      }
      const worker = this.getWorkerState();
      this.handle.db
        .update(workerState)
        .set({
          activeRunId: null,
          heartbeatAt: timestamp,
          version: worker.version + 1,
        })
        .where(and(eq(workerState.id, "primary"), eq(workerState.activeRunId, runId)))
        .run();
      this.insertRunEvent(runId, "run.blocked", reason, {});
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "RUNNING",
        to: "BLOCKED",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.finished", {
        runId,
        outcome: "blocked",
      });
      return {
        value: { task: mapTask(taskRow, project.name), run: mapRun(runRow) },
        events: [taskEvent, runEvent],
        replayed: false,
      };
    })();
  }

  cancelRunningTask(
    taskId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<{ task: Task; run: TaskRun }> {
    return this.executeIdempotent(deviceId, idempotencyKey, "task.cancel", expectedVersion, () => {
      const currentTask = this.requireTaskRow(taskId);
      if (currentTask.status !== "RUNNING" || !currentTask.latestRunId) {
        throw new Error("只有执行中的任务可以取消");
      }
      this.assertVersion(currentTask.version, expectedVersion);
      const currentRun = this.requireRunRow(currentTask.latestRunId);
      const worker = this.getWorkerState();
      if (
        currentRun.taskId !== currentTask.id ||
        currentRun.finishedAt !== null ||
        worker.activeRunId !== currentRun.id
      ) {
        throw new Error("当前执行已经变化，请刷新后重试");
      }
      assertTaskTransition(currentTask.status, "CANCELLED");
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const runRow = this.handle.db
        .update(taskRuns)
        .set({
          status: "CANCELLED",
          summary: "执行已由用户取消，Worktree 和运行日志已保留。",
          executionToken: randomUUID(),
          finishedAt: timestamp,
        })
        .where(
          and(
            eq(taskRuns.id, currentRun.id),
            eq(taskRuns.executionToken, currentRun.executionToken),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!runRow) {
        throw new Error("当前执行已经变化，请刷新后重试");
      }
      const taskRow = this.handle.db
        .update(tasks)
        .set({
          status: "CANCELLED",
          version: currentTask.version + 1,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, expectedVersion),
            eq(tasks.status, "RUNNING"),
            isNull(tasks.deletedAt),
          ),
        )
        .returning()
        .get();
      if (!taskRow) {
        throw new Error("当前执行已经变化，请刷新后重试");
      }
      this.handle.db
        .update(workerState)
        .set({
          activeRunId: null,
          heartbeatAt: timestamp,
          version: worker.version + 1,
        })
        .where(and(eq(workerState.id, "primary"), eq(workerState.activeRunId, currentRun.id)))
        .run();
      this.insertRunEvent(currentRun.id, "run.cancelled", "执行已由用户取消", {
        deviceId,
      });
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "RUNNING",
        to: "CANCELLED",
      });
      const runEvent = this.insertDomainEvent("run", currentRun.id, "run.finished", {
        runId: currentRun.id,
        outcome: "cancelled",
      });
      return {
        value: { task: mapTask(taskRow, project.name), run: mapRun(runRow) },
        events: [taskEvent, runEvent],
      };
    });
  }

  getRunPublishContext(runId: string, expectedVersion: number): RunPublishContext {
    const currentRun = this.requireRunRow(runId);
    const currentTask = this.requireTaskRow(currentRun.taskId);
    if (currentRun.status !== "SUCCEEDED" || currentTask.status !== "REVIEW") {
      throw new Error("只有审核中的成功执行可以推送");
    }
    if (currentTask.latestRunId !== runId) {
      throw new Error("只有任务最近一次成功执行可以推送");
    }
    this.assertVersion(currentTask.version, expectedVersion);
    if (!currentRun.baseCommit || !currentRun.resultCommit) {
      throw new Error("执行记录缺少完整的 Git 结果范围");
    }
    const project = this.requireProjectRow(currentTask.projectId);
    if (!project.repositoryUrl) {
      throw new Error("旧本地项目需要重新注册远程 Git 仓库后才能推送");
    }
    return {
      repositoryPath: project.path,
      targetBranch: currentRun.targetBranch,
      baseCommit: currentRun.baseCommit,
      resultCommit: currentRun.resultCommit,
    };
  }

  getRunApprovalReplay(
    deviceId: string,
    idempotencyKey: string,
  ): PublishedRunApproval | null {
    const command = this.handle.db
      .select()
      .from(remoteCommands)
      .where(
        and(
          eq(remoteCommands.deviceId, deviceId),
          eq(remoteCommands.idempotencyKey, idempotencyKey),
          eq(remoteCommands.commandType, "run.approve"),
        ),
      )
      .get();
    return command ? (JSON.parse(command.resultJson) as PublishedRunApproval) : null;
  }

  approvePublishedRun(
    runId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
    publication: RunPublishResult,
  ): EventfulResult<PublishedRunApproval> {
    return this.executeIdempotent(deviceId, idempotencyKey, "run.approve", expectedVersion, () => {
      const currentRun = this.requireRunRow(runId);
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (currentRun.status !== "SUCCEEDED") {
        throw new Error("只有成功执行可以通过审核");
      }
      assertTaskTransition(currentTask.status, "COMPLETED");
      this.assertVersion(currentTask.version, expectedVersion);
      if (
        !currentRun.resultCommit ||
        publication.branch !== currentRun.targetBranch ||
        (publication.status === "pushed" && publication.currentCommit !== currentRun.resultCommit)
      ) {
        throw new Error("远程推送结果与当前 Run 的结果 Commit 不一致");
      }
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      this.handle.db
        .update(taskRuns)
        .set({ pushedAt: timestamp, pushedCommit: publication.currentCommit })
        .where(eq(taskRuns.id, runId))
        .run();
      const taskRow = this.handle.db
        .update(tasks)
        .set({ status: "COMPLETED", version: currentTask.version + 1, updatedAt: timestamp })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, expectedVersion),
            eq(tasks.status, "REVIEW"),
          ),
        )
        .returning()
        .get();
      if (!taskRow) {
        throw new Error("Version conflict: 任务审核状态已发生变化");
      }
      const projectRow = this.handle.db
        .update(projects)
        .set({
          integrationCommit: publication.currentCommit,
          lastFetchedAt: timestamp,
          version: project.version + 1,
          updatedAt: timestamp,
        })
        .where(and(eq(projects.id, project.id), eq(projects.version, project.version)))
        .returning()
        .get();
      if (!projectRow) {
        throw new Error("Version conflict: 项目同步状态已发生变化");
      }
      this.handle.db
        .insert(reviewDecisions)
        .values({
          id: randomUUID(),
          runId,
          decision: "APPROVED",
          feedback: null,
          deviceId,
          createdAt: timestamp,
        })
        .run();
      this.insertRunEvent(
        runId,
        "run.pushed",
        publication.status === "already_pushed"
          ? `远程分支 ${publication.branch} 已包含本次结果`
          : `本次结果已推送到远程分支 ${publication.branch}`,
        { ...publication },
      );
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "REVIEW",
        to: "COMPLETED",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.pushed", {
        runId,
        ...publication,
      });
      return {
        value: { task: mapTask(taskRow, project.name), publication },
        events: [taskEvent, runEvent],
      };
    });
  }

  getRunApplicationContext(runId: string, expectedVersion: number): RunApplicationContext {
    const currentRun = this.requireRunRow(runId);
    const currentTask = this.requireTaskRow(currentRun.taskId);
    if (currentRun.status !== "SUCCEEDED") {
      throw new Error("Only successful runs can be applied");
    }
    if (currentTask.status !== "COMPLETED" || currentTask.latestRunId !== runId) {
      throw new Error("Only the approved latest run can be applied");
    }
    this.assertVersion(currentTask.version, expectedVersion);
    const approval = this.handle.db
      .select()
      .from(reviewDecisions)
      .where(and(eq(reviewDecisions.runId, runId), eq(reviewDecisions.decision, "APPROVED")))
      .get();
    if (!approval) {
      throw new Error("Only approved runs can be applied");
    }
    if (!currentRun.baseCommit || !currentRun.resultCommit) {
      throw new Error("Approved run has no complete Git result range");
    }
    const project = this.requireProjectRow(currentTask.projectId);
    return {
      projectPath: project.path,
      targetBranch: currentRun.targetBranch,
      baseCommit: currentRun.baseCommit,
      resultCommit: currentRun.resultCommit,
    };
  }

  recordRunApplication(
    runId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
    application: RunApplicationResult,
  ): EventfulResult<RunApplicationResult> {
    return this.executeIdempotent(
      deviceId,
      idempotencyKey,
      "run.apply_to_project",
      expectedVersion,
      () => {
        this.getRunApplicationContext(runId, expectedVersion);
        const message =
          application.status === "applied"
            ? application.branchCreated
              ? `目标分支 ${application.branch} 已创建并写入本次结果`
              : `本次结果已写入目标分支 ${application.branch}`
            : `目标分支 ${application.branch} 已包含本次结果`;
        this.insertRunEvent(runId, "run.applied", message, { ...application });
        const event = this.insertDomainEvent("run", runId, "run.applied", {
          runId,
          ...application,
        });
        return { value: application, events: [event] };
      },
    );
  }

  rejectRun(
    runId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
    feedback: string,
  ): EventfulResult<Task> {
    return this.executeIdempotent(deviceId, idempotencyKey, "run.reject", expectedVersion, () => {
      const currentRun = this.requireRunRow(runId);
      const currentTask = this.requireTaskRow(currentRun.taskId);
      assertTaskTransition(currentTask.status, "READY");
      this.assertVersion(currentTask.version, expectedVersion);
      const currentRevision = this.handle.db
        .select()
        .from(taskRevisions)
        .where(eq(taskRevisions.id, currentRun.taskRevisionId))
        .get();
      if (!currentRevision) {
        throw new Error("执行记录关联的 Revision 不存在");
      }
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const revisionNumber =
        (this.handle.db
          .select({ value: max(taskRevisions.revision) })
          .from(taskRevisions)
          .where(eq(taskRevisions.taskId, currentTask.id))
          .get()?.value ?? 0) + 1;
      const revisionId = randomUUID();
      const previousSpec = JSON.parse(currentRevision.specJson) as Record<string, unknown>;
      const specJson = JSON.stringify({ ...previousSpec, reviewFeedback: feedback });
      this.handle.db
        .insert(taskRevisions)
        .values({
          id: revisionId,
          taskId: currentTask.id,
          revision: revisionNumber,
          specJson,
          specHash: hash(specJson),
          targetBranch: currentRevision.targetBranch,
          baseRef: currentRevision.baseRef,
          baseStrategy: currentRevision.baseStrategy,
          confirmedBaseCommit: project.integrationCommit,
          createdFrom: currentRevision.id,
          createdByDeviceId: deviceId,
          confirmedAt: timestamp,
        })
        .run();
      const taskRow = this.handle.db
        .update(tasks)
        .set({
          status: "READY",
          activeRevisionId: revisionId,
          version: currentTask.version + 1,
          updatedAt: timestamp,
        })
        .where(eq(tasks.id, currentTask.id))
        .returning()
        .get();
      this.handle.db
        .insert(reviewDecisions)
        .values({
          id: randomUUID(),
          runId,
          decision: "REJECTED",
          feedback,
          deviceId,
          createdAt: timestamp,
        })
        .run();
      const event = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "REVIEW",
        to: "READY",
      });
      return { value: mapTask(taskRow, project.name), events: [event] };
    });
  }

  getRun(runId: string): TaskRun | null {
    const row = this.handle.db.select().from(taskRuns).where(eq(taskRuns.id, runId)).get();
    return row ? mapRun(row) : null;
  }

  listRuns(limit = 50): TaskRun[] {
    return this.handle.db
      .select()
      .from(taskRuns)
      .orderBy(desc(taskRuns.startedAt))
      .limit(limit)
      .all()
      .map(mapRun);
  }

  getRunEvents(runId: string): RunEvent[] {
    return this.handle.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(runEvents.sequence)
      .all()
      .map(mapRunEvent);
  }

  getWorkerState(): WorkerState {
    const row = this.handle.db
      .select()
      .from(workerState)
      .where(eq(workerState.id, "primary"))
      .get();
    if (!row) {
      throw new Error("Worker state not initialized");
    }
    return {
      status: row.status,
      heartbeatAt: row.heartbeatAt,
      activeRunId: row.activeRunId,
      version: row.version,
    };
  }

  setWorkerStatus(status: WorkerState["status"]): EventfulResult<WorkerState> {
    return this.handle.sqlite.transaction(() => {
      const current = this.getWorkerState();
      const timestamp = now();
      const row = this.handle.db
        .update(workerState)
        .set({ status, heartbeatAt: timestamp, version: current.version + 1 })
        .where(eq(workerState.id, "primary"))
        .returning()
        .get();
      const event = this.insertDomainEvent("worker", "primary", "worker.status_changed", {
        status,
      });
      return {
        value: {
          status: row.status,
          heartbeatAt: row.heartbeatAt,
          activeRunId: row.activeRunId,
          version: row.version,
        },
        events: [event],
        replayed: false,
      };
    })();
  }

  heartbeat(): void {
    this.handle.db
      .update(workerState)
      .set({ heartbeatAt: now() })
      .where(eq(workerState.id, "primary"))
      .run();
  }

  listDomainEvents(afterId = 0, limit = 200): DomainEvent[] {
    return this.handle.db
      .select()
      .from(domainEvents)
      .where(gt(domainEvents.id, afterId))
      .orderBy(domainEvents.id)
      .limit(limit)
      .all()
      .map(mapDomainEvent);
  }

  listDevices(): PairedDevice[] {
    return this.handle.db
      .select()
      .from(pairedDevices)
      .orderBy(desc(pairedDevices.createdAt))
      .all()
      .map(mapDevice);
  }

  authenticateDevice(token: string): PairedDevice | null {
    const row = this.handle.db
      .select()
      .from(pairedDevices)
      .where(and(eq(pairedDevices.credentialHash, hash(token)), isNull(pairedDevices.revokedAt)))
      .get();
    if (!row) {
      return null;
    }
    const timestamp = now();
    this.handle.db
      .update(pairedDevices)
      .set({ lastSeenAt: timestamp })
      .where(eq(pairedDevices.id, row.id))
      .run();
    return mapDevice({ ...row, lastSeenAt: timestamp });
  }

  createPairingSession(externalBaseUrl: string | null): {
    code: string;
    expiresAt: string;
    url: string | null;
  } {
    const code = randomInt(100000, 1000000).toString();
    const timestamp = now();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.handle.db
      .insert(pairingSessions)
      .values({
        id: randomUUID(),
        codeHash: hash(code),
        externalBaseUrl,
        expiresAt,
        usedAt: null,
        createdAt: timestamp,
      })
      .run();
    return {
      code,
      expiresAt,
      url: externalBaseUrl ? `${externalBaseUrl.replace(/\/$/, "")}/pair?code=${code}` : null,
    };
  }

  pairDevice(
    code: string,
    name: string,
  ): { device: PairedDevice; token: string; events: DomainEvent[] } {
    return this.handle.sqlite.transaction(() => {
      const session = this.handle.db
        .select()
        .from(pairingSessions)
        .where(and(eq(pairingSessions.codeHash, hash(code)), isNull(pairingSessions.usedAt)))
        .get();
      if (!session || session.expiresAt <= now()) {
        throw new Error("Pairing code is invalid or expired");
      }
      const token = randomBytes(32).toString("base64url");
      const timestamp = now();
      const row = this.handle.db
        .insert(pairedDevices)
        .values({
          id: randomUUID(),
          name,
          role: "viewer",
          credentialHash: hash(token),
          lastSeenAt: timestamp,
          revokedAt: null,
          version: 0,
          createdAt: timestamp,
        })
        .returning()
        .get();
      this.handle.db
        .update(pairingSessions)
        .set({ usedAt: timestamp })
        .where(eq(pairingSessions.id, session.id))
        .run();
      const event = this.insertDomainEvent("device", row.id, "device.paired", {
        deviceId: row.id,
      });
      return { device: mapDevice(row), token, events: [event] };
    })();
  }

  updateDeviceRole(
    deviceId: string,
    role: DeviceRole,
    expectedVersion: number,
    actorDeviceId: string,
    idempotencyKey: string,
  ): EventfulResult<PairedDevice> {
    return this.executeIdempotent(
      actorDeviceId,
      idempotencyKey,
      "device.update_role",
      expectedVersion,
      () => {
        const current = this.handle.db
          .select()
          .from(pairedDevices)
          .where(and(eq(pairedDevices.id, deviceId), isNull(pairedDevices.revokedAt)))
          .get();
        if (!current) {
          throw new Error("Device not found");
        }
        this.assertVersion(current.version, expectedVersion);
        const row = this.handle.db
          .update(pairedDevices)
          .set({ role, version: current.version + 1 })
          .where(
            and(
              eq(pairedDevices.id, deviceId),
              eq(pairedDevices.version, expectedVersion),
              isNull(pairedDevices.revokedAt),
            ),
          )
          .returning()
          .get();
        if (!row) {
          throw new Error("Device not found");
        }
        const event = this.insertDomainEvent("device", deviceId, "device.updated", { role });
        return { value: mapDevice(row), events: [event] };
      },
    );
  }

  revokeDevice(
    deviceId: string,
    expectedVersion: number,
    actorDeviceId: string,
    idempotencyKey: string,
  ): EventfulResult<PairedDevice> {
    return this.executeIdempotent(
      actorDeviceId,
      idempotencyKey,
      "device.revoke",
      expectedVersion,
      () => {
        const current = this.handle.db
          .select()
          .from(pairedDevices)
          .where(and(eq(pairedDevices.id, deviceId), isNull(pairedDevices.revokedAt)))
          .get();
        if (!current) {
          throw new Error("Device not found");
        }
        this.assertVersion(current.version, expectedVersion);
        const row = this.handle.db
          .update(pairedDevices)
          .set({ revokedAt: now(), version: current.version + 1 })
          .where(
            and(
              eq(pairedDevices.id, deviceId),
              eq(pairedDevices.version, expectedVersion),
              isNull(pairedDevices.revokedAt),
            ),
          )
          .returning()
          .get();
        if (!row) {
          throw new Error("Device not found");
        }
        const event = this.insertDomainEvent("device", deviceId, "device.revoked", {
          deviceId,
        });
        return { value: mapDevice(row), events: [event] };
      },
    );
  }

  private executeIdempotent<T>(
    deviceId: string,
    idempotencyKey: string,
    commandType: string,
    expectedVersion: number,
    action: () => { value: T; events: DomainEvent[] },
  ): EventfulResult<T> {
    return this.handle.sqlite.transaction(() => {
      const existing = this.handle.db
        .select()
        .from(remoteCommands)
        .where(
          and(
            eq(remoteCommands.deviceId, deviceId),
            eq(remoteCommands.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
      if (existing) {
        return {
          value: JSON.parse(existing.resultJson) as T,
          events: [],
          replayed: true,
        };
      }
      const result = action();
      this.handle.db
        .insert(remoteCommands)
        .values({
          id: randomUUID(),
          deviceId,
          idempotencyKey,
          commandType,
          expectedVersion,
          status: "SUCCEEDED",
          resultJson: JSON.stringify(result.value),
          createdAt: now(),
        })
        .run();
      return { ...result, replayed: false };
    })();
  }

  private requireTaskRow(taskId: string): TaskRow {
    const row = this.handle.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
      .get();
    if (!row) {
      throw new Error("任务不存在");
    }
    return row;
  }

  private requireProjectRow(projectId: string): ProjectRow {
    const row = this.handle.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) {
      throw new Error("项目不存在");
    }
    return row;
  }

  private requireRunRow(runId: string): TaskRunRow {
    const row = this.handle.db.select().from(taskRuns).where(eq(taskRuns.id, runId)).get();
    if (!row) {
      throw new Error("执行记录不存在");
    }
    return row;
  }

  private requireSkillRow(skillId: string): SkillRow {
    const row = this.handle.db.select().from(skills).where(eq(skills.id, skillId)).get();
    if (!row) {
      throw new Error("Skill not found");
    }
    return row;
  }

  private requireSkillVersionRow(versionId: string): SkillVersionRow {
    const row = this.handle.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.id, versionId))
      .get();
    if (!row) {
      throw new Error("Skill version not found");
    }
    return row;
  }

  private assertVersion(current: number, expected: number): void {
    if (current !== expected) {
      throw new Error(`Version conflict: expected ${expected}, current ${current}`);
    }
  }

  private insertDomainEvent(
    aggregateType: DomainEvent["aggregateType"],
    aggregateId: string,
    type: string,
    payload: Record<string, unknown>,
  ): DomainEvent {
    const row = this.handle.db
      .insert(domainEvents)
      .values({
        aggregateType,
        aggregateId,
        type,
        payloadJson: JSON.stringify(payload),
        createdAt: now(),
      })
      .returning()
      .get();
    return mapDomainEvent(row);
  }

  private insertRunEvent(
    runId: string,
    type: string,
    message: string,
    payload: Record<string, unknown>,
  ): RunEvent {
    const sequence =
      (this.handle.db
        .select({ value: max(runEvents.sequence) })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get()?.value ?? 0) + 1;
    const row = this.handle.db
      .insert(runEvents)
      .values({
        id: randomUUID(),
        runId,
        sequence,
        type,
        message,
        payloadJson: JSON.stringify(payload),
        createdAt: now(),
      })
      .returning()
      .get();
    return mapRunEvent(row);
  }
}
