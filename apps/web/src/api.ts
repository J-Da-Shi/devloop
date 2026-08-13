import type {
  ConfirmTaskInput,
  CreateProjectInput,
  CreateSkillInput,
  CreateSkillVersionInput,
  CreateTaskInput,
  DashboardSnapshot,
  DeviceRole,
  DomainEvent,
  Project,
  RejectRunInput,
  RunEvent,
  Skill,
  SkillDetails,
  SkillValidationResult,
  Task,
  TaskCommandInput,
  TaskRun,
  RunPublishResult,
  UpdateSkillInput,
  UpdateTaskInput,
} from "@devloop/shared";

export interface RequestIdentity {
  id: string;
  name: string;
  role: DeviceRole;
  kind: "owner";
}

export interface RunDetails {
  run: TaskRun;
  task: Task | null;
  events: RunEvent[];
}

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
  }
}

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "REQUEST_FAILED",
      payload?.error?.message ?? `请求失败（${response.status}）`,
      payload?.error?.details,
    );
  }
  return payload as T;
};

const json = (value: unknown): string => JSON.stringify(value);

export const queryKeys = {
  session: ["session"] as const,
  dashboard: ["dashboard"] as const,
  projects: ["projects"] as const,
  skills: ["skills"] as const,
  skill: (skillId: string) => ["skills", skillId] as const,
  tasks: ["tasks"] as const,
  runs: ["runs"] as const,
  run: (runId: string) => ["runs", runId] as const,
};

export const getDashboardRefetchInterval = (dashboard: DashboardSnapshot | undefined): number =>
  dashboard?.currentRun ||
  dashboard?.tasks.some((task) => task.status === "READY" || task.status === "RUNNING")
    ? 1_000
    : 15_000;

export const api = {
  session: () => request<{ identity: RequestIdentity }>("/api/session"),
  dashboard: () => request<DashboardSnapshot>("/api/dashboard"),
  projects: () => request<{ projects: Project[] }>("/api/projects"),
  createProject: (input: CreateProjectInput) =>
    request<{ project: Project }>("/api/projects", { method: "POST", body: json(input) }),
  syncProject: (projectId: string) =>
    request<{ project: Project }>(`/api/projects/${projectId}/sync`, { method: "POST" }),
  skills: () => request<{ skills: Skill[] }>("/api/skills"),
  skill: (skillId: string) => request<SkillDetails>(`/api/skills/${skillId}`),
  validateSkill: (input: CreateSkillInput) =>
    request<{ validation: SkillValidationResult }>("/api/skills/validate", {
      method: "POST",
      body: json(input),
    }),
  createSkill: (input: CreateSkillInput) =>
    request<{ skill: Skill }>("/api/skills", { method: "POST", body: json(input) }),
  createSkillVersion: (skillId: string, input: CreateSkillVersionInput) =>
    request<{ skill: Skill; replayed: boolean }>(`/api/skills/${skillId}/versions`, {
      method: "POST",
      body: json(input),
    }),
  updateSkill: (skillId: string, input: UpdateSkillInput) =>
    request<{ skill: Skill; replayed: boolean }>(`/api/skills/${skillId}`, {
      method: "PATCH",
      body: json(input),
    }),
  tasks: () => request<{ tasks: Task[] }>("/api/tasks"),
  createTask: (input: CreateTaskInput) =>
    request<{ task: Task }>("/api/tasks", { method: "POST", body: json(input) }),
  updateTask: (taskId: string, input: UpdateTaskInput) =>
    request<{ task: Task; replayed: boolean }>(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: json(input),
    }),
  confirmTask: (taskId: string, input: ConfirmTaskInput) =>
    request<{ task: Task; replayed: boolean }>(`/api/tasks/${taskId}/confirm`, {
      method: "POST",
      body: json(input),
    }),
  unconfirmTask: (taskId: string, input: TaskCommandInput) =>
    request<{ task: Task; replayed: boolean }>(`/api/tasks/${taskId}/unconfirm`, {
      method: "POST",
      body: json(input),
    }),
  cancelTask: (taskId: string, input: TaskCommandInput) =>
    request<{ task: Task; run: TaskRun; replayed: boolean }>(`/api/tasks/${taskId}/cancel`, {
      method: "POST",
      body: json(input),
    }),
  deleteTask: (taskId: string, input: TaskCommandInput) =>
    request<{ task: Task; replayed: boolean }>(`/api/tasks/${taskId}`, {
      method: "DELETE",
      body: json(input),
    }),
  runs: () => request<{ runs: TaskRun[] }>("/api/runs"),
  run: (runId: string) => request<RunDetails>(`/api/runs/${runId}`),
  approveRun: (runId: string, input: TaskCommandInput) =>
    request<{ task: Task; publication: RunPublishResult; replayed: boolean }>(
      `/api/runs/${runId}/approve`,
      {
        method: "POST",
        body: json(input),
      },
    ),
  rejectRun: (runId: string, input: RejectRunInput) =>
    request<{ task: Task; replayed: boolean }>(`/api/runs/${runId}/reject`, {
      method: "POST",
      body: json(input),
    }),
  setWorkerStatus: (status: "RUNNING" | "PAUSED") =>
    request<{ worker: DashboardSnapshot["worker"] }>("/api/worker/status", {
      method: "POST",
      body: json({ status }),
    }),
};

export const eventNames: DomainEvent["type"][] = [
  "project.created",
  "project.synced",
  "skill.created",
  "skill.version_created",
  "skill.updated",
  "task.created",
  "task.updated",
  "task.status_changed",
  "task.deleted",
  "run.started",
  "run.step_changed",
  "run.finished",
  "run.pushed",
  "worker.status_changed",
];
