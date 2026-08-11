import type {
  ConfirmTaskInput,
  CreateProjectInput,
  CreateTaskInput,
  DashboardSnapshot,
  DeviceRole,
  DomainEvent,
  PairedDevice,
  PairDeviceInput,
  Project,
  RejectRunInput,
  RunApplicationResult,
  RunEvent,
  Task,
  TaskCommandInput,
  TaskRun,
  UpdateTaskInput,
} from "@devloop/shared";

export interface RequestIdentity {
  id: string;
  name: string;
  role: DeviceRole;
  local: boolean;
  device: PairedDevice | null;
}

export interface RunDetails {
  run: TaskRun;
  task: Task | null;
  events: RunEvent[];
}

export interface PairingSession {
  code: string;
  expiresAt: string;
  url: string | null;
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
  tasks: ["tasks"] as const,
  runs: ["runs"] as const,
  run: (runId: string) => ["runs", runId] as const,
  devices: ["devices"] as const,
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
  runs: () => request<{ runs: TaskRun[] }>("/api/runs"),
  run: (runId: string) => request<RunDetails>(`/api/runs/${runId}`),
  approveRun: (runId: string, input: TaskCommandInput) =>
    request<{ task: Task; replayed: boolean }>(`/api/runs/${runId}/approve`, {
      method: "POST",
      body: json(input),
    }),
  applyRun: (runId: string, input: TaskCommandInput) =>
    request<{ application: RunApplicationResult; replayed: boolean }>(`/api/runs/${runId}/apply`, {
      method: "POST",
      body: json(input),
    }),
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
  devices: () => request<{ devices: PairedDevice[] }>("/api/devices"),
  createPairing: (externalBaseUrl?: string) =>
    request<{ pairing: PairingSession }>("/api/devices/pairing", {
      method: "POST",
      body: json(externalBaseUrl ? { externalBaseUrl } : {}),
    }),
  pair: (input: PairDeviceInput) =>
    request<{ device: PairedDevice }>("/api/pair", { method: "POST", body: json(input) }),
  updateDevice: (
    deviceId: string,
    input: { role: DeviceRole; expectedVersion: number; idempotencyKey: string },
  ) =>
    request<{ device: PairedDevice; replayed: boolean }>(`/api/devices/${deviceId}`, {
      method: "PATCH",
      body: json(input),
    }),
  revokeDevice: (deviceId: string, input: TaskCommandInput) =>
    request<{ device: PairedDevice; replayed: boolean }>(`/api/devices/${deviceId}`, {
      method: "DELETE",
      body: json(input),
    }),
};

export const eventNames: DomainEvent["type"][] = [
  "project.created",
  "task.created",
  "task.updated",
  "task.status_changed",
  "run.started",
  "run.step_changed",
  "run.finished",
  "run.applied",
  "worker.status_changed",
  "device.paired",
  "device.updated",
  "device.revoked",
];
