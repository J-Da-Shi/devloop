import type {
  BaseStrategy,
  DeviceRole,
  RunStatus,
  TaskStatus,
  WorkerStatus,
} from "@devloop/shared";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = () => ({
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    defaultBaseRef: text("default_base_ref").notNull(),
    integrationRef: text("integration_ref").notNull(),
    integrationCommit: text("integration_commit"),
    version: integer("version").notNull().default(0),
    ...timestamps(),
  },
  (table) => [uniqueIndex("projects_path_unique").on(table.path)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    targetBranch: text("target_branch").notNull().default("HEAD"),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    acceptanceCriteriaJson: text("acceptance_criteria_json").notNull(),
    status: text("status").$type<TaskStatus>().notNull(),
    priority: integer("priority").notNull().default(50),
    activeRevisionId: text("active_revision_id"),
    latestRunId: text("latest_run_id"),
    version: integer("version").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    index("tasks_project_status_idx").on(table.projectId, table.status),
    index("tasks_queue_idx").on(table.status, table.priority, table.createdAt),
  ],
);

export const taskRevisions = sqliteTable(
  "task_revisions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    specJson: text("spec_json").notNull(),
    specHash: text("spec_hash").notNull(),
    targetBranch: text("target_branch").notNull().default("HEAD"),
    baseRef: text("base_ref").notNull(),
    baseStrategy: text("base_strategy").$type<BaseStrategy>().notNull(),
    confirmedBaseCommit: text("confirmed_base_commit"),
    createdFrom: text("created_from").notNull(),
    createdByDeviceId: text("created_by_device_id"),
    confirmedAt: text("confirmed_at").notNull(),
  },
  (table) => [uniqueIndex("task_revisions_number_unique").on(table.taskId, table.revision)],
);

export const taskRuns = sqliteTable(
  "task_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    taskRevisionId: text("task_revision_id")
      .notNull()
      .references(() => taskRevisions.id, { onDelete: "restrict" }),
    targetBranch: text("target_branch").notNull().default("HEAD"),
    runner: text("runner").notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    baseCommit: text("base_commit"),
    resultCommit: text("result_commit"),
    worktreePath: text("worktree_path"),
    branchName: text("branch_name"),
    executionToken: text("execution_token").notNull(),
    processGroupId: integer("process_group_id"),
    runnerVersion: text("runner_version"),
    runInputHash: text("run_input_hash").notNull(),
    summary: text("summary"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [index("task_runs_task_idx").on(table.taskId, table.startedAt)],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    message: text("message").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("run_events_sequence_unique").on(table.runId, table.sequence)],
);

export const domainEvents = sqliteTable(
  "domain_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("domain_events_aggregate_idx").on(table.aggregateType, table.aggregateId)],
);

export const workerState = sqliteTable("worker_state", {
  id: text("id").primaryKey(),
  status: text("status").$type<WorkerStatus>().notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
  activeRunId: text("active_run_id"),
  version: integer("version").notNull().default(0),
});

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    path: text("path").notNull(),
    size: integer("size").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("artifacts_run_idx").on(table.runId)],
);

export const reviewDecisions = sqliteTable(
  "review_decisions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(),
    feedback: text("feedback"),
    deviceId: text("device_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("review_decisions_run_idx").on(table.runId)],
);

export const pairedDevices = sqliteTable("paired_devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").$type<DeviceRole>().notNull(),
  credentialHash: text("credential_hash").notNull(),
  lastSeenAt: text("last_seen_at"),
  revokedAt: text("revoked_at"),
  version: integer("version").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const pairingSessions = sqliteTable(
  "pairing_sessions",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    externalBaseUrl: text("external_base_url"),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("pairing_sessions_code_hash_unique").on(table.codeHash)],
);

export const remoteCommands = sqliteTable(
  "remote_commands",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandType: text("command_type").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    status: text("status").notNull(),
    resultJson: text("result_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("remote_commands_idempotency_unique").on(table.deviceId, table.idempotencyKey),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("audit_events_aggregate_idx").on(table.aggregateType, table.aggregateId)],
);

export const schema = {
  projects,
  tasks,
  taskRevisions,
  taskRuns,
  runEvents,
  domainEvents,
  workerState,
  artifacts,
  reviewDecisions,
  pairedDevices,
  pairingSessions,
  remoteCommands,
  auditEvents,
};

export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskRevisionRow = typeof taskRevisions.$inferSelect;
export type TaskRunRow = typeof taskRuns.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type DomainEventRow = typeof domainEvents.$inferSelect;
export type PairedDeviceRow = typeof pairedDevices.$inferSelect;
