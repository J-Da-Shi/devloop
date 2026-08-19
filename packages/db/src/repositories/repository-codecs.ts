import { createHash } from "node:crypto";
import type {
  DomainEvent,
  PairedDevice,
  Project,
  ReviewDecision,
  RunArtifact,
  RunEvent,
  RunSkillSnapshot,
  Skill,
  SkillVersion,
  Task,
  TaskRevision,
  TaskRun,
  TaskType,
} from "@devloop/shared";
import type {
  ArtifactRow,
  DomainEventRow,
  PairedDeviceRow,
  ProjectRow,
  ReviewDecisionRow,
  RunEventRow,
  SkillRow,
  SkillVersionRow,
  TaskRevisionRow,
  TaskRow,
  TaskRunRow,
} from "../schema.js";
import type { TaskRevisionSpecSnapshot } from "./repository-types.js";

const maxRetryContextEvents = 16;
const maxRetryContextSummaryCharacters = 12_000;
const maxRetryContextEventCharacters = 1_200;
const maxRetryContextCharacters = 30_000;

export const now = (): string => new Date().toISOString();

export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export const parseStringArray = (value: string): string[] => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("数据库中的字符串数组格式无效");
  }
  return parsed;
};

export const parseRunSkillSnapshot = (value: string | null): RunSkillSnapshot[] | null => {
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

export const buildRunInputHash = (input: {
  taskRevisionId: string;
  targetBranch: string;
  baseCommit: string | null;
  runner: string;
  specHash: string;
  skillSnapshot: RunSkillSnapshot[];
}): string => hash(JSON.stringify(input));

export const truncateRetryContextText = (value: string, maximum: number): string => {
  const normalized = value.trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 24))}\n[已截断历史输出]`;
};

export const parseRetryContext = (value: unknown): TaskRevisionSpecSnapshot["retryContext"] => {
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
    sourceStatus,
    sourceRunner,
    sourceFinishedAt,
    summary,
    baseCommit: normalizedBaseCommit,
    resultCommit: normalizedResultCommit,
    events: parsedEvents,
  };
};

export const parseTaskRevisionSpec = (value: string): TaskRevisionSpecSnapshot => {
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
    taskType: (taskType ?? "DEVELOPMENT") as TaskType,
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

export const mapProject = (row: ProjectRow): Project => ({
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

export const mapArtifact = (row: ArtifactRow): RunArtifact => ({
  id: row.id,
  runId: row.runId,
  kind: row.kind,
  size: row.size,
  checksum: row.checksum,
  createdAt: row.createdAt,
});

export const mapTask = (row: TaskRow, projectName: string): Task => ({
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

export const mapTaskRevision = (row: TaskRevisionRow): TaskRevision => {
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

export const mapRun = (row: TaskRunRow): TaskRun => ({
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

export const mapRunEvent = (row: RunEventRow): RunEvent => ({
  id: row.id,
  runId: row.runId,
  sequence: row.sequence,
  type: row.type,
  message: row.message,
  payload: JSON.parse(row.payloadJson) as unknown,
  createdAt: row.createdAt,
});

export const mapReviewDecision = (row: ReviewDecisionRow): ReviewDecision => ({
  id: row.id,
  runId: row.runId,
  decision: row.decision,
  feedback: row.feedback,
  deviceId: row.deviceId,
  createdAt: row.createdAt,
});

export const mapDevice = (row: PairedDeviceRow): PairedDevice => ({
  id: row.id,
  name: row.name,
  role: row.role,
  lastSeenAt: row.lastSeenAt,
  revokedAt: row.revokedAt,
  version: row.version,
  createdAt: row.createdAt,
});

export const mapSkillVersion = (row: SkillVersionRow): SkillVersion => ({
  id: row.id,
  skillId: row.skillId,
  version: row.version,
  contentHash: row.contentHash,
  createdByDeviceId: row.createdByDeviceId,
  createdAt: row.createdAt,
});

export const mapSkill = (row: SkillRow, currentVersion: SkillVersionRow): Skill => ({
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

export const mapDomainEvent = (row: DomainEventRow): DomainEvent => ({
  id: row.id,
  aggregateType: row.aggregateType as DomainEvent["aggregateType"],
  aggregateId: row.aggregateId,
  type: row.type,
  payload: JSON.parse(row.payloadJson) as unknown,
  createdAt: row.createdAt,
});

export const retryContextLimits = {
  eventCount: maxRetryContextEvents,
  eventCharacters: maxRetryContextEventCharacters,
  summaryCharacters: maxRetryContextSummaryCharacters,
} as const;
