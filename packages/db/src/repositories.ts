import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  assertTaskTransition,
  type BaseStrategy,
  type CreateTaskInput,
  type DeviceRole,
  type DomainEvent,
  type PairedDevice,
  type Project,
  type ReviewDecision,
  type RunArtifact,
  type RunApplicationResult,
  type RunPublishResult,
  type RunEvent,
  type RetryContext,
  type RunStatus,
  type RunSkillSnapshot,
  type Skill,
  type SkillVersion,
  type Task,
  type TaskRevision,
  type TaskRun,
  type TaskStatus,
  type TaskType,
  type UpdateProjectPreviewInput,
  type WorkerState,
  workerConcurrencyMax,
  workerConcurrencyMin,
} from "@devloop/shared";
import { and, desc, eq, gt, isNull, lte, max } from "drizzle-orm";
import type { DatabaseHandle } from "./client.js";
import {
  artifacts,
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
  type ArtifactRow,
  type PairedDeviceRow,
  type ProjectRow,
  type ReviewDecisionRow,
  type RunEventRow,
  type SkillRow,
  type SkillVersionRow,
  type TaskRevisionRow,
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

const parseRunSkillSnapshot = (value: string | null): RunSkillSnapshot[] | null => {
  if (value === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("数据库中的 Run Skill 快照格式无效");
  }
  const snapshot = parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("数据库中的 Run Skill 快照格式无效");
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.skillId !== "string" ||
      !record.skillId ||
      typeof record.version !== "number" ||
      !Number.isSafeInteger(record.version) ||
      record.version <= 0 ||
      typeof record.contentHash !== "string" ||
      !record.contentHash
    ) {
      throw new Error("数据库中的 Run Skill 快照格式无效");
    }
    return {
      skillId: record.skillId,
      version: record.version,
      contentHash: record.contentHash,
    };
  });
  if (new Set(snapshot.map((skill) => skill.skillId)).size !== snapshot.length) {
    throw new Error("数据库中的 Run Skill 快照包含重复 Skill");
  }
  return snapshot;
};

const buildRunInputHash = (input: {
  taskRevisionId: string;
  targetBranch: string;
  baseCommit: string | null;
  runner: string;
  specHash: string;
  skillSnapshot: RunSkillSnapshot[];
}): string => hash(JSON.stringify(input));

const maxRetryContextEvents = 16;
const maxRetryContextSummaryCharacters = 12_000;
const maxRetryContextEventCharacters = 1_200;
const maxRetryContextCharacters = 30_000;

const truncateRetryContextText = (value: string, maximum: number): string => {
  const normalized = value.trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 24))}\n[已截断历史输出]`;
};

const parseRetryContext = (value: unknown): RetryContext | null => {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("任务 Revision 重试上下文格式无效");
  }
  const record = value as Record<string, unknown>;
  const sourceStatus = record.sourceStatus;
  const events = record.events;
  const baseCommit = record.baseCommit;
  const resultCommit = record.resultCommit;
  if (
    typeof record.sourceRunId !== "string" ||
    !record.sourceRunId ||
    typeof record.sourceRunner !== "string" ||
    !record.sourceRunner ||
    typeof record.sourceFinishedAt !== "string" ||
    !record.sourceFinishedAt ||
    (sourceStatus !== "BLOCKED" && sourceStatus !== "FAILED") ||
    typeof record.summary !== "string" ||
    !record.summary ||
    record.summary.length > maxRetryContextSummaryCharacters ||
    (baseCommit !== null && (typeof baseCommit !== "string" || !baseCommit.trim())) ||
    (resultCommit !== null && (typeof resultCommit !== "string" || !resultCommit.trim())) ||
    !Array.isArray(events) ||
    events.length > maxRetryContextEvents
  ) {
    throw new Error("任务 Revision 重试上下文格式无效");
  }
  const parsedEvents = events.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("任务 Revision 重试上下文格式无效");
    }
    const eventRecord = event as Record<string, unknown>;
    if (
      typeof eventRecord.type !== "string" ||
      !eventRecord.type ||
      typeof eventRecord.message !== "string" ||
      !eventRecord.message ||
      eventRecord.message.length > maxRetryContextEventCharacters ||
      typeof eventRecord.createdAt !== "string" ||
      !eventRecord.createdAt
    ) {
      throw new Error("任务 Revision 重试上下文格式无效");
    }
    return {
      type: eventRecord.type,
      message: eventRecord.message,
      createdAt: eventRecord.createdAt,
    };
  });
  const sourceRunId = record.sourceRunId as string;
  const sourceRunner = record.sourceRunner as string;
  const sourceFinishedAt = record.sourceFinishedAt as string;
  const summary = record.summary as string;
  const normalizedBaseCommit = baseCommit as string | null;
  const normalizedResultCommit = resultCommit as string | null;
  const characterCount =
    sourceRunId.length +
    sourceRunner.length +
    sourceFinishedAt.length +
    summary.length +
    (normalizedBaseCommit?.length ?? 0) +
    (normalizedResultCommit?.length ?? 0) +
    parsedEvents.reduce(
      (total, event) => total + event.type.length + event.message.length + event.createdAt.length,
      0,
    );
  if (characterCount > maxRetryContextCharacters) {
    throw new Error("任务 Revision 重试上下文超过大小限制");
  }
  return {
    sourceRunId,
    sourceStatus: sourceStatus as RetryContext["sourceStatus"],
    sourceRunner,
    sourceFinishedAt,
    summary,
    baseCommit: normalizedBaseCommit,
    resultCommit: normalizedResultCommit,
    events: parsedEvents,
  };
};

interface TaskRevisionSpecSnapshot {
  taskType: TaskType;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  reviewFeedback: string | null;
  autoResolveConflicts: boolean;
  retryContext: RetryContext | null;
  continuationBaseCommit: string | null;
  continuationResultCommit: string | null;
}

const parseTaskRevisionSpec = (value: string): TaskRevisionSpecSnapshot => {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("任务 Revision 内容格式无效");
  }
  const record = parsed as Record<string, unknown>;
  const taskType = record.taskType;
  const acceptanceCriteria = record.acceptanceCriteria;
  const reviewFeedback = record.reviewFeedback;
  const autoResolveConflicts = record.autoResolveConflicts;
  const retryContext = parseRetryContext(record.retryContext);
  const continuationBaseCommit = record.continuationBaseCommit;
  const continuationResultCommit = record.continuationResultCommit;
  if (
    typeof record.title !== "string" ||
    typeof record.goal !== "string" ||
    (taskType !== undefined && taskType !== "DEVELOPMENT" && taskType !== "RESEARCH") ||
    !Array.isArray(acceptanceCriteria) ||
    !acceptanceCriteria.every((item) => typeof item === "string") ||
    (reviewFeedback !== undefined &&
      reviewFeedback !== null &&
      typeof reviewFeedback !== "string") ||
    (autoResolveConflicts !== undefined && typeof autoResolveConflicts !== "boolean") ||
    (continuationBaseCommit !== undefined &&
      continuationBaseCommit !== null &&
      (typeof continuationBaseCommit !== "string" || !continuationBaseCommit.trim())) ||
    (continuationResultCommit !== undefined &&
      continuationResultCommit !== null &&
      (typeof continuationResultCommit !== "string" || !continuationResultCommit.trim())) ||
    (continuationBaseCommit === undefined || continuationBaseCommit === null) !==
      (continuationResultCommit === undefined || continuationResultCommit === null)
  ) {
    throw new Error("任务 Revision 内容格式无效");
  }
  return {
    taskType: taskType ?? "DEVELOPMENT",
    title: record.title,
    goal: record.goal,
    acceptanceCriteria,
    reviewFeedback: reviewFeedback ?? null,
    autoResolveConflicts: autoResolveConflicts ?? true,
    retryContext,
    continuationBaseCommit: continuationBaseCommit ?? null,
    continuationResultCommit: continuationResultCommit ?? null,
  };
};

const mapProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  repositoryUrl: row.repositoryUrl,
  defaultBaseRef: row.defaultBaseRef,
  integrationRef: row.integrationRef,
  integrationCommit: row.integrationCommit,
  runner: (row.runner as Project["runner"]) ?? "codex",
  previewCommand: row.previewCommand,
  previewWorkingDirectory: row.previewWorkingDirectory,
  previewHealthPath: row.previewHealthPath,
  playwrightEnabled: row.playwrightEnabled,
  playwrightTestCommand: row.playwrightTestCommand,
  lastFetchedAt: row.lastFetchedAt,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapArtifact = (row: ArtifactRow): RunArtifact => ({
  id: row.id,
  runId: row.runId,
  kind: row.kind,
  size: row.size,
  checksum: row.checksum,
  createdAt: row.createdAt,
});

const mapTask = (row: TaskRow, projectName: string): Task => ({
  id: row.id,
  projectId: row.projectId,
  projectName,
  taskType: row.taskType,
  targetBranch: row.targetBranch,
  autoResolveConflicts: row.autoResolveConflicts,
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

const mapTaskRevision = (row: TaskRevisionRow): TaskRevision => {
  const spec = parseTaskRevisionSpec(row.specJson);
  return {
    id: row.id,
    taskId: row.taskId,
    revision: row.revision,
    taskType: spec.taskType,
    autoResolveConflicts: spec.autoResolveConflicts,
    title: spec.title,
    goal: spec.goal,
    acceptanceCriteria: spec.acceptanceCriteria,
    reviewFeedback: spec.reviewFeedback,
    retryContext: spec.retryContext,
    specHash: row.specHash,
    targetBranch: row.targetBranch,
    baseRef: row.baseRef,
    baseStrategy: row.baseStrategy,
    confirmedBaseCommit: row.confirmedBaseCommit,
    createdFrom: row.createdFrom,
    createdByDeviceId: row.createdByDeviceId,
    confirmedAt: row.confirmedAt,
  };
};

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
  skillSnapshot: parseRunSkillSnapshot(row.skillSnapshotJson),
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
  payload: JSON.parse(row.payloadJson) as unknown,
  createdAt: row.createdAt,
});

const mapReviewDecision = (row: ReviewDecisionRow): ReviewDecision => ({
  id: row.id,
  runId: row.runId,
  decision: row.decision,
  feedback: row.feedback,
  deviceId: row.deviceId,
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
  runner?: string;
}

export interface ProjectExecutionContext {
  project: Project;
  repositoryPath: string;
}

export interface ClaimedTask {
  task: Task;
  run: TaskRun;
  taskType: TaskType;
  projectPath: string;
  projectDefaultBaseRef: string;
  projectRepositoryUrl: string | null;
  projectRunner: string;
  previewCommand: string | null;
  previewWorkingDirectory: string;
  previewHealthPath: string;
  playwrightEnabled: boolean;
  playwrightTestCommand: string | null;
  autoResolveConflicts: boolean;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  reviewFeedback: string | null;
  retryContext: RetryContext | null;
  continuationBaseCommit: string | null;
  continuationResultCommit: string | null;
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

export interface AppliedRunApproval {
  task: Task;
  application: RunApplicationResult;
}

export interface ResearchRunApproval {
  task: Task;
  research: {
    status: "accepted";
    summary: string;
  };
}

export type RunApprovalResult = PublishedRunApproval | AppliedRunApproval | ResearchRunApproval;

export type RunApprovalContext =
  | { type: "remote"; context: RunPublishContext }
  | { type: "local"; context: RunApplicationContext }
  | { type: "research"; context: { summary: string } };

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

export interface StoredRunArtifact {
  artifact: RunArtifact;
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
          lastFetchedAt: input.lastFetchedAt === undefined ? timestamp : input.lastFetchedAt,
          defaultBaseRef: input.defaultBaseRef,
          integrationRef,
          integrationCommit: input.headCommit,
          runner: input.runner ?? "codex",
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

  findProjectByPath(path: string): Project | null {
    const row = this.handle.db.select().from(projects).where(eq(projects.path, path)).get();
    return row ? mapProject(row) : null;
  }

  getProjectExecutionContext(projectId: string): ProjectExecutionContext | null {
    const row = this.handle.db.select().from(projects).where(eq(projects.id, projectId)).get();
    return row ? { project: mapProject(row), repositoryPath: row.path } : null;
  }

  updateProjectRunner(
    projectId: string,
    runner: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<Project> {
    return this.executeIdempotent(
      deviceId,
      idempotencyKey,
      "project.update_runner",
      expectedVersion,
      () => {
        const current = this.requireProjectRow(projectId);
        this.assertVersion(current.version, expectedVersion);
        const timestamp = now();
        const row = this.handle.db
          .update(projects)
          .set({
            runner,
            version: current.version + 1,
            updatedAt: timestamp,
          })
          .where(and(eq(projects.id, projectId), eq(projects.version, expectedVersion)))
          .returning()
          .get();
        if (!row) {
          throw new Error("Version conflict: 项目已被其他请求更新");
        }
        const event = this.insertDomainEvent("project", projectId, "project.runner_changed", {
          projectId,
          runner,
        });
        return { value: mapProject(row), events: [event] };
      },
    );
  }

  updateProjectPreview(
    projectId: string,
    input: UpdateProjectPreviewInput,
    deviceId: string,
  ): EventfulResult<Project> {
    return this.executeIdempotent(
      deviceId,
      input.idempotencyKey,
      "project.update_preview",
      input.expectedVersion,
      () => {
        const current = this.requireProjectRow(projectId);
        this.assertVersion(current.version, input.expectedVersion);
        const timestamp = now();
        const row = this.handle.db
          .update(projects)
          .set({
            previewCommand: input.previewCommand,
            previewWorkingDirectory: input.previewWorkingDirectory,
            previewHealthPath: input.previewHealthPath,
            playwrightEnabled: input.playwrightEnabled,
            playwrightTestCommand: input.playwrightTestCommand,
            version: current.version + 1,
            updatedAt: timestamp,
          })
          .where(and(eq(projects.id, projectId), eq(projects.version, input.expectedVersion)))
          .returning()
          .get();
        if (!row) {
          throw new Error("Version conflict: 项目已被其他请求更新");
        }
        const event = this.insertDomainEvent("project", projectId, "project.preview_changed", {
          projectId,
          playwrightEnabled: input.playwrightEnabled,
          configured: input.previewCommand !== null,
        });
        return { value: mapProject(row), events: [event] };
      },
    );
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

  createTask(
    input: Omit<CreateTaskInput, "autoResolveConflicts" | "taskType"> & {
      autoResolveConflicts?: boolean;
      taskType?: TaskType;
    },
  ): EventfulResult<Task> {
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
          taskType: input.taskType ?? "DEVELOPMENT",
          targetBranch: input.targetBranch,
          autoResolveConflicts: input.autoResolveConflicts ?? true,
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
      taskType?: TaskType | undefined;
      targetBranch?: string | undefined;
      autoResolveConflicts?: boolean | undefined;
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
            taskType: input.taskType ?? current.taskType,
            targetBranch: input.targetBranch ?? current.targetBranch,
            autoResolveConflicts: input.autoResolveConflicts ?? current.autoResolveConflicts,
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
        const previousRevision = current.activeRevisionId
          ? this.handle.db
              .select()
              .from(taskRevisions)
              .where(eq(taskRevisions.id, current.activeRevisionId))
              .get()
          : null;
        const previousSpec = previousRevision
          ? parseTaskRevisionSpec(previousRevision.specJson)
          : null;
        const latestRun = current.latestRunId
          ? this.handle.db.select().from(taskRuns).where(eq(taskRuns.id, current.latestRunId)).get()
          : null;
        const latestReviewDecision = latestRun
          ? this.handle.db
              .select()
              .from(reviewDecisions)
              .where(eq(reviewDecisions.runId, latestRun.id))
              .orderBy(desc(reviewDecisions.createdAt))
              .get()
          : null;
        const continuesAcceptedRevision = Boolean(
          latestRun &&
          latestRun.status === "SUCCEEDED" &&
          latestRun.taskRevisionId === current.activeRevisionId &&
          latestReviewDecision?.decision === "APPROVED",
        );
        const continuesDevelopmentRevision =
          current.taskType === "DEVELOPMENT" && previousSpec?.taskType === "DEVELOPMENT";
        const retryableLatestRun =
          latestRun &&
          latestRun.taskRevisionId === current.activeRevisionId &&
          (latestRun.status === "FAILED" || latestRun.status === "BLOCKED")
            ? latestRun
            : null;
        const retryContext = retryableLatestRun ? this.buildRetryContext(retryableLatestRun) : null;
        const resumesFailedDevelopmentCheckpoint = Boolean(
          retryableLatestRun &&
          continuesDevelopmentRevision &&
          retryableLatestRun.baseCommit &&
          retryableLatestRun.resultCommit,
        );
        const continuationBaseCommit =
          continuesAcceptedRevision || !continuesDevelopmentRevision
            ? null
            : resumesFailedDevelopmentCheckpoint
              ? retryableLatestRun!.baseCommit
              : (previousSpec?.continuationBaseCommit ?? null);
        const continuationResultCommit =
          continuesAcceptedRevision || !continuesDevelopmentRevision
            ? null
            : resumesFailedDevelopmentCheckpoint
              ? retryableLatestRun!.resultCommit
              : (previousSpec?.continuationResultCommit ?? null);
        const baseStrategy = continuationResultCommit ? "PINNED" : input.baseStrategy;
        const baseRef = continuationResultCommit ?? current.targetBranch;
        const spec = {
          taskType: current.taskType,
          title: current.title,
          goal: current.goal,
          acceptanceCriteria: parseStringArray(current.acceptanceCriteriaJson),
          reviewFeedback: continuesAcceptedRevision ? null : (previousSpec?.reviewFeedback ?? null),
          autoResolveConflicts: current.autoResolveConflicts,
          retryContext,
          continuationBaseCommit,
          continuationResultCommit,
          baseStrategy,
          baseRef,
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
            baseRef,
            baseStrategy,
            confirmedBaseCommit: continuationResultCommit ?? project.integrationCommit,
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

  continueCompletedTask(
    taskId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<Task> {
    return this.executeIdempotent(
      deviceId,
      idempotencyKey,
      "task.continue",
      expectedVersion,
      () => {
        const current = this.requireTaskRow(taskId);
        if (current.status !== "COMPLETED") {
          throw new Error("只有已完成任务可以继续迭代");
        }
        assertTaskTransition(current.status, "DRAFT");
        this.assertVersion(current.version, expectedVersion);
        if (!current.latestRunId || !current.activeRevisionId) {
          throw new Error("已完成任务缺少最近执行或 Revision");
        }
        const latestRun = this.requireRunRow(current.latestRunId);
        const reviewDecision = this.handle.db
          .select()
          .from(reviewDecisions)
          .where(eq(reviewDecisions.runId, latestRun.id))
          .orderBy(desc(reviewDecisions.createdAt))
          .get();
        if (
          latestRun.status !== "SUCCEEDED" ||
          latestRun.taskRevisionId !== current.activeRevisionId ||
          reviewDecision?.decision !== "APPROVED"
        ) {
          throw new Error("已完成任务缺少可继续迭代的审核结果");
        }
        const project = this.requireProjectRow(current.projectId);
        const timestamp = now();
        const row = this.handle.db
          .update(tasks)
          .set({ status: "DRAFT", version: current.version + 1, updatedAt: timestamp })
          .where(
            and(
              eq(tasks.id, taskId),
              eq(tasks.version, expectedVersion),
              eq(tasks.status, "COMPLETED"),
              isNull(tasks.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!row) {
          throw new Error("Version conflict: 已完成任务状态已发生变化");
        }
        const event = this.insertDomainEvent("task", taskId, "task.status_changed", {
          taskId,
          from: "COMPLETED",
          to: "DRAFT",
          continuedFromRunId: latestRun.id,
          continuedFromRevisionId: latestRun.taskRevisionId,
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
    options: {
      readyBefore?: string;
      resolveRunnerVersion?: (runnerId: string) => string | null;
    } = {},
  ): EventfulResult<ClaimedTask> | null {
    const readyBefore = options.readyBefore ?? now();
    return this.handle.sqlite.transaction(() => {
      const selected = this.handle.db
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
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
      const revisionSpec = parseTaskRevisionSpec(revision.specJson);
      const project = this.requireProjectRow(current.projectId);
      const runner = project.runner;
      const runnerVersion = options.resolveRunnerVersion?.(runner) ?? null;
      assertTaskTransition(current.status, "RUNNING");
      const baseCommit =
        revision.baseStrategy === "LATEST_ACCEPTED"
          ? project.integrationCommit
          : revision.confirmedBaseCommit;
      const runId = randomUUID();
      const executionToken = randomUUID();
      const timestamp = now();
      const runInputHash = buildRunInputHash({
        taskRevisionId: revision.id,
        targetBranch: revision.targetBranch,
        baseCommit,
        runner,
        specHash: revision.specHash,
        skillSnapshot: [],
      });
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
          skillSnapshotJson: null,
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
      this.refreshWorkerActivity(timestamp);
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
          taskType: revisionSpec.taskType,
          projectPath: project.path,
          projectDefaultBaseRef: project.defaultBaseRef,
          projectRepositoryUrl: project.repositoryUrl,
          projectRunner: runner,
          previewCommand: project.previewCommand,
          previewWorkingDirectory: project.previewWorkingDirectory,
          previewHealthPath: project.previewHealthPath,
          playwrightEnabled: project.playwrightEnabled,
          playwrightTestCommand: project.playwrightTestCommand,
          autoResolveConflicts: revisionSpec.autoResolveConflicts,
          title: revisionSpec.title,
          goal: revisionSpec.goal,
          acceptanceCriteria: revisionSpec.acceptanceCriteria,
          reviewFeedback: revisionSpec.reviewFeedback,
          retryContext: revisionSpec.retryContext,
          continuationBaseCommit: revisionSpec.continuationBaseCommit,
          continuationResultCommit: revisionSpec.continuationResultCommit,
        },
        events: [taskEvent, runEvent],
        replayed: false,
      };
    })();
  }

  setRunSkillSnapshot(
    runId: string,
    executionToken: string,
    skillSnapshot: RunSkillSnapshot[],
  ): EventfulResult<TaskRun> {
    return this.handle.sqlite.transaction(() => {
      const current = this.requireRunRow(runId);
      if (current.executionToken !== executionToken || current.finishedAt !== null) {
        throw new Error("当前 Run 的执行令牌已经失去 Skill 快照所有权");
      }
      if (current.skillSnapshotJson !== null) {
        throw new Error("当前 Run 的 Skill 快照已经固定");
      }
      const normalizedSnapshot = parseRunSkillSnapshot(JSON.stringify(skillSnapshot));
      if (normalizedSnapshot === null) {
        throw new Error("Run Skill 快照不能为空");
      }
      const revision = this.handle.db
        .select()
        .from(taskRevisions)
        .where(eq(taskRevisions.id, current.taskRevisionId))
        .get();
      if (!revision) {
        throw new Error("执行记录关联的 Revision 不存在");
      }
      const runInputHash = buildRunInputHash({
        taskRevisionId: revision.id,
        targetBranch: current.targetBranch,
        baseCommit: current.baseCommit,
        runner: current.runner,
        specHash: revision.specHash,
        skillSnapshot: normalizedSnapshot,
      });
      const row = this.handle.db
        .update(taskRuns)
        .set({
          skillSnapshotJson: JSON.stringify(normalizedSnapshot),
          runInputHash,
        })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.executionToken, executionToken),
            isNull(taskRuns.skillSnapshotJson),
            isNull(taskRuns.finishedAt),
          ),
        )
        .returning()
        .get();
      if (!row) {
        throw new Error("当前 Run 的执行令牌已经失去 Skill 快照所有权");
      }
      this.insertRunEvent(
        runId,
        "run.skill_snapshot_recorded",
        `已固定 ${normalizedSnapshot.length} 个 Skill 执行快照`,
        { skills: normalizedSnapshot },
      );
      const event = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        status: row.status,
        message: "Skill 执行快照已固定",
      });
      return { value: mapRun(row), events: [event], replayed: false };
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

  setRunProcessGroupId(runId: string, executionToken: string, processGroupId: number | null): void {
    if (processGroupId !== null && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)) {
      throw new Error("进程组 ID 无效");
    }
    const row = this.handle.db
      .update(taskRuns)
      .set({ processGroupId })
      .where(
        and(
          eq(taskRuns.id, runId),
          eq(taskRuns.executionToken, executionToken),
          isNull(taskRuns.finishedAt),
        ),
      )
      .returning({ id: taskRuns.id })
      .get();
    if (!row) {
      throw new Error("当前 Run 的执行令牌已经失效");
    }
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
      const runInputHash = buildRunInputHash({
        taskRevisionId: revision.id,
        targetBranch: input.targetBranch,
        baseCommit: input.baseCommit,
        runner: current.runner,
        specHash: revision.specHash,
        skillSnapshot: parseRunSkillSnapshot(current.skillSnapshotJson) ?? [],
      });
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
          processGroupId: null,
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
      this.refreshWorkerActivity(timestamp);
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
      assertTaskTransition(currentTask.status, "FAILED");
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const runRow = this.handle.db
        .update(taskRuns)
        .set({
          status: "FAILED",
          summary: errorMessage,
          resultCommit: resultCommit ?? currentRun.resultCommit,
          processGroupId: null,
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
      this.refreshWorkerActivity(timestamp);
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
      assertTaskTransition(currentTask.status, "BLOCKED");
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const runRow = this.handle.db
        .update(taskRuns)
        .set({
          status: "BLOCKED",
          summary: reason,
          resultCommit: resultCommit ?? currentRun.resultCommit,
          processGroupId: null,
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
      this.refreshWorkerActivity(timestamp);
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
      if (currentRun.taskId !== currentTask.id || currentRun.finishedAt !== null) {
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
          processGroupId: null,
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
      this.refreshWorkerActivity(timestamp);
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

  getRunApprovalContext(runId: string, expectedVersion: number): RunApprovalContext {
    const currentRun = this.requireRunRow(runId);
    const currentTask = this.requireTaskRow(currentRun.taskId);
    if (currentRun.status !== "SUCCEEDED" || currentTask.status !== "REVIEW") {
      throw new Error("只有审核中的成功执行可以通过");
    }
    if (currentTask.latestRunId !== runId) {
      throw new Error("只有任务最近一次成功执行可以通过");
    }
    this.assertVersion(currentTask.version, expectedVersion);
    if (currentTask.taskType === "RESEARCH") {
      if (!currentRun.summary) {
        throw new Error("研究执行缺少可审核的总结");
      }
      return { type: "research", context: { summary: currentRun.summary } };
    }
    if (!currentRun.baseCommit || !currentRun.resultCommit) {
      throw new Error("执行记录缺少完整的 Git 结果范围");
    }
    const project = this.requireProjectRow(currentTask.projectId);
    if (project.repositoryUrl) {
      return {
        type: "remote",
        context: {
          repositoryPath: project.path,
          targetBranch: currentRun.targetBranch,
          baseCommit: currentRun.baseCommit,
          resultCommit: currentRun.resultCommit,
        },
      };
    }
    return {
      type: "local",
      context: {
        projectPath: project.path,
        targetBranch: currentRun.targetBranch,
        baseCommit: currentRun.baseCommit,
        resultCommit: currentRun.resultCommit,
      },
    };
  }

  getRunPublishContext(runId: string, expectedVersion: number): RunPublishContext {
    const approval = this.getRunApprovalContext(runId, expectedVersion);
    if (approval.type !== "remote") {
      throw new Error("本地项目的执行结果不能推送到远程仓库");
    }
    return approval.context;
  }

  getRunApprovalReplay(deviceId: string, idempotencyKey: string): RunApprovalResult | null {
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
    return command ? (JSON.parse(command.resultJson) as RunApprovalResult) : null;
  }

  approveResearchRun(
    runId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): EventfulResult<ResearchRunApproval> {
    return this.executeIdempotent(deviceId, idempotencyKey, "run.approve", expectedVersion, () => {
      const currentRun = this.requireRunRow(runId);
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (
        currentTask.taskType !== "RESEARCH" ||
        currentRun.status !== "SUCCEEDED" ||
        currentTask.status !== "REVIEW" ||
        currentTask.latestRunId !== runId ||
        !currentRun.summary
      ) {
        throw new Error("只有待审核的最新研究总结可以通过");
      }
      assertTaskTransition(currentTask.status, "COMPLETED");
      this.assertVersion(currentTask.version, expectedVersion);
      const project = this.requireProjectRow(currentTask.projectId);
      const timestamp = now();
      const taskRow = this.handle.db
        .update(tasks)
        .set({ status: "COMPLETED", version: currentTask.version + 1, updatedAt: timestamp })
        .where(
          and(
            eq(tasks.id, currentTask.id),
            eq(tasks.version, expectedVersion),
            eq(tasks.status, "REVIEW"),
            isNull(tasks.deletedAt),
          ),
        )
        .returning()
        .get();
      if (!taskRow) {
        throw new Error("Version conflict: 研究任务审核状态已发生变化");
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
      this.insertRunEvent(runId, "run.research_approved", "研究总结已通过审核", {});
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "REVIEW",
        to: "COMPLETED",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.finished", {
        runId,
        outcome: "accepted",
        taskType: "RESEARCH",
      });
      return {
        value: {
          task: mapTask(taskRow, project.name),
          research: { status: "accepted", summary: currentRun.summary },
        },
        events: [taskEvent, runEvent],
      };
    });
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

  approveAppliedRun(
    runId: string,
    deviceId: string,
    expectedVersion: number,
    idempotencyKey: string,
    application: RunApplicationResult,
  ): EventfulResult<AppliedRunApproval> {
    return this.executeIdempotent(deviceId, idempotencyKey, "run.approve", expectedVersion, () => {
      const currentRun = this.requireRunRow(runId);
      const currentTask = this.requireTaskRow(currentRun.taskId);
      if (currentRun.status !== "SUCCEEDED" || currentTask.latestRunId !== runId) {
        throw new Error("只有任务最近一次成功执行可以通过审核");
      }
      assertTaskTransition(currentTask.status, "COMPLETED");
      this.assertVersion(currentTask.version, expectedVersion);
      const project = this.requireProjectRow(currentTask.projectId);
      if (project.repositoryUrl) {
        throw new Error("远程项目必须推送结果后才能通过审核");
      }
      if (
        (currentRun.targetBranch !== "HEAD" && application.branch !== currentRun.targetBranch) ||
        !application.currentCommit
      ) {
        throw new Error("本地写回结果与当前 Run 不一致");
      }
      const timestamp = now();
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
          integrationCommit: application.currentCommit,
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
      const message =
        application.status === "already_applied"
          ? `本地分支 ${application.branch} 已包含本次结果`
          : application.workingTreeUpdated
            ? `本次结果已写入本地分支 ${application.branch} 和当前工作目录`
            : `本次结果已写入本地分支 ${application.branch}`;
      this.insertRunEvent(runId, "run.applied", message, { ...application });
      const taskEvent = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "REVIEW",
        to: "COMPLETED",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.applied", {
        runId,
        ...application,
      });
      return {
        value: { task: mapTask(taskRow, project.name), application },
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
      if (
        currentRun.status !== "SUCCEEDED" ||
        currentTask.status !== "REVIEW" ||
        currentTask.latestRunId !== runId
      ) {
        throw new Error("只有任务最近一次成功执行可以驳回");
      }
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
      const researchTask = currentTask.taskType === "RESEARCH";
      if (!researchTask && (!currentRun.baseCommit || !currentRun.resultCommit)) {
        throw new Error("执行记录缺少连续迭代所需的基础或结果 Commit");
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
      const nextBaseRef = researchTask ? currentRevision.baseRef : currentRun.resultCommit!;
      const nextBaseStrategy = researchTask ? currentRevision.baseStrategy : "PINNED";
      const nextConfirmedBaseCommit = researchTask
        ? currentRevision.confirmedBaseCommit
        : currentRun.resultCommit!;
      const specJson = JSON.stringify({
        ...previousSpec,
        reviewFeedback: feedback,
        continuationBaseCommit: researchTask ? null : currentRun.baseCommit,
        continuationResultCommit: researchTask ? null : currentRun.resultCommit,
        baseStrategy: nextBaseStrategy,
        baseRef: nextBaseRef,
      });
      this.handle.db
        .insert(taskRevisions)
        .values({
          id: revisionId,
          taskId: currentTask.id,
          revision: revisionNumber,
          specJson,
          specHash: hash(specJson),
          targetBranch: currentRevision.targetBranch,
          baseRef: nextBaseRef,
          baseStrategy: nextBaseStrategy,
          confirmedBaseCommit: nextConfirmedBaseCommit,
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
      this.insertRunEvent(runId, "run.rejected", `审核已驳回：${feedback}`, {
        feedback,
        nextRevisionId: revisionId,
      });
      const event = this.insertDomainEvent("task", currentTask.id, "task.status_changed", {
        taskId: currentTask.id,
        from: "REVIEW",
        to: "READY",
      });
      const runEvent = this.insertDomainEvent("run", runId, "run.rejected", {
        runId,
        feedback,
        nextRevisionId: revisionId,
      });
      return { value: mapTask(taskRow, project.name), events: [event, runEvent] };
    });
  }

  getRun(runId: string): TaskRun | null {
    const row = this.handle.db.select().from(taskRuns).where(eq(taskRuns.id, runId)).get();
    return row ? mapRun(row) : null;
  }

  getTaskRevision(revisionId: string): TaskRevision | null {
    const row = this.handle.db
      .select()
      .from(taskRevisions)
      .where(eq(taskRevisions.id, revisionId))
      .get();
    return row ? mapTaskRevision(row) : null;
  }

  getRunReviewDecision(runId: string): ReviewDecision | null {
    const row = this.handle.db
      .select()
      .from(reviewDecisions)
      .where(eq(reviewDecisions.runId, runId))
      .orderBy(desc(reviewDecisions.createdAt))
      .get();
    return row ? mapReviewDecision(row) : null;
  }

  getRunProcessGroupId(runId: string): number | null {
    const row = this.handle.db
      .select({ processGroupId: taskRuns.processGroupId })
      .from(taskRuns)
      .where(eq(taskRuns.id, runId))
      .get();
    return row?.processGroupId ?? null;
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

  listActiveRuns(): TaskRun[] {
    return this.handle.db
      .select()
      .from(taskRuns)
      .where(isNull(taskRuns.finishedAt))
      .orderBy(taskRuns.startedAt)
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

  private buildRetryContext(run: TaskRunRow): RetryContext {
    if (run.status !== "FAILED" && run.status !== "BLOCKED") {
      throw new Error("只有失败或阻塞的执行记录可以生成重试上下文");
    }
    const events = this.handle.db
      .select({
        type: runEvents.type,
        message: runEvents.message,
        createdAt: runEvents.createdAt,
      })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(desc(runEvents.sequence))
      .limit(maxRetryContextEvents)
      .all()
      .reverse()
      .map((event) => ({
        type: event.type,
        message: truncateRetryContextText(event.message, maxRetryContextEventCharacters),
        createdAt: event.createdAt,
      }));
    return {
      sourceRunId: run.id,
      sourceStatus: run.status,
      sourceRunner: run.runner,
      sourceFinishedAt: run.finishedAt ?? run.startedAt,
      summary: truncateRetryContextText(
        run.summary ?? "上一轮未记录失败摘要，请根据下方执行日志继续排查。",
        maxRetryContextSummaryCharacters,
      ),
      baseCommit: run.baseCommit,
      resultCommit: run.resultCommit,
      events,
    };
  }

  createRunArtifact(input: {
    runId: string;
    kind: string;
    storagePath: string;
    size: number;
    checksum: string;
  }): RunArtifact {
    this.requireRunRow(input.runId);
    const row = this.handle.db
      .insert(artifacts)
      .values({
        id: randomUUID(),
        runId: input.runId,
        kind: input.kind,
        path: input.storagePath,
        size: input.size,
        checksum: input.checksum,
        createdAt: now(),
      })
      .returning()
      .get();
    return mapArtifact(row);
  }

  listRunArtifacts(runId: string): RunArtifact[] {
    return this.handle.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(artifacts.createdAt)
      .all()
      .map(mapArtifact);
  }

  getRunArtifact(runId: string, artifactId: string): StoredRunArtifact | null {
    const row = this.handle.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.runId, runId)))
      .get();
    return row ? { artifact: mapArtifact(row), storagePath: row.path } : null;
  }

  recordRunEvent(
    runId: string,
    type: string,
    message: string,
    payload: Record<string, unknown>,
  ): EventfulResult<RunEvent> {
    return this.handle.sqlite.transaction(() => {
      this.requireRunRow(runId);
      const runEvent = this.insertRunEvent(runId, type, message, payload);
      const domainEvent = this.insertDomainEvent("run", runId, "run.step_changed", {
        runId,
        eventType: type,
      });
      return { value: runEvent, events: [domainEvent], replayed: false };
    })();
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
    const activeRunIds = this.handle.db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(isNull(taskRuns.finishedAt))
      .orderBy(taskRuns.startedAt)
      .all()
      .map((run) => run.id);
    return {
      status: row.status,
      heartbeatAt: row.heartbeatAt,
      activeRunId: activeRunIds[0] ?? null,
      activeRunIds,
      concurrencyLimit: row.concurrencyLimit,
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
      if (!row) {
        throw new Error("Worker state not initialized");
      }
      const event = this.insertDomainEvent("worker", "primary", "worker.status_changed", {
        status,
      });
      return {
        value: this.getWorkerState(),
        events: [event],
        replayed: false,
      };
    })();
  }

  setWorkerConcurrency(concurrencyLimit: number): EventfulResult<WorkerState> {
    if (
      !Number.isSafeInteger(concurrencyLimit) ||
      concurrencyLimit < workerConcurrencyMin ||
      concurrencyLimit > workerConcurrencyMax
    ) {
      throw new Error(
        `Worker 并发数必须是 ${workerConcurrencyMin}-${workerConcurrencyMax} 之间的整数`,
      );
    }
    return this.handle.sqlite.transaction(() => {
      const current = this.getWorkerState();
      const timestamp = now();
      const row = this.handle.db
        .update(workerState)
        .set({
          concurrencyLimit,
          heartbeatAt: timestamp,
          version: current.version + 1,
        })
        .where(eq(workerState.id, "primary"))
        .returning()
        .get();
      if (!row) {
        throw new Error("Worker state not initialized");
      }
      const event = this.insertDomainEvent("worker", "primary", "worker.concurrency_changed", {
        concurrencyLimit,
      });
      return { value: this.getWorkerState(), events: [event], replayed: false };
    })();
  }

  heartbeat(): void {
    this.handle.db
      .update(workerState)
      .set({ heartbeatAt: now() })
      .where(eq(workerState.id, "primary"))
      .run();
  }

  private refreshWorkerActivity(timestamp: string): void {
    const activeRun = this.handle.db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(isNull(taskRuns.finishedAt))
      .orderBy(taskRuns.startedAt)
      .get();
    const current = this.handle.db
      .select({ version: workerState.version })
      .from(workerState)
      .where(eq(workerState.id, "primary"))
      .get();
    if (!current) {
      throw new Error("Worker state not initialized");
    }
    this.handle.db
      .update(workerState)
      .set({
        activeRunId: activeRun?.id ?? null,
        heartbeatAt: timestamp,
        version: current.version + 1,
      })
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
