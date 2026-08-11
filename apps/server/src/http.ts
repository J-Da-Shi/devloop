import type { DeviceRole, PairedDevice } from "@devloop/shared";
import type { DevLoopRepository } from "@devloop/db";
import type { FastifyRequest } from "fastify";

export const deviceCookieName = "devloop_device";

export class HttpError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export interface RequestIdentity {
  id: string;
  name: string;
  role: DeviceRole;
  local: boolean;
  device: PairedDevice | null;
}

const roleRank: Record<DeviceRole, number> = {
  viewer: 0,
  operator: 1,
  editor: 2,
};

const isLoopback = (address: string | undefined): boolean =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

export function resolveIdentity(
  request: FastifyRequest,
  repository: DevLoopRepository,
): RequestIdentity | null {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (isLoopback(request.raw.socket.remoteAddress) && forwardedFor === undefined) {
    return {
      id: "local-desktop",
      name: "本机桌面",
      role: "editor",
      local: true,
      device: null,
    };
  }

  const authorization = request.headers.authorization;
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
  const token = bearerToken ?? request.cookies[deviceCookieName];
  if (!token) {
    return null;
  }
  const device = repository.authenticateDevice(token);
  if (!device) {
    return null;
  }
  return {
    id: device.id,
    name: device.name,
    role: device.role,
    local: false,
    device,
  };
}

export function requireRole(
  request: FastifyRequest,
  repository: DevLoopRepository,
  minimumRole: DeviceRole,
): RequestIdentity {
  const identity = resolveIdentity(request, repository);
  if (!identity) {
    throw new HttpError(401, "需要先完成设备配对", "AUTH_REQUIRED");
  }
  if (roleRank[identity.role] < roleRank[minimumRole]) {
    throw new HttpError(403, "当前设备没有执行此操作的权限", "ROLE_REQUIRED");
  }
  return identity;
}

export function requireLocalEditor(
  request: FastifyRequest,
  repository: DevLoopRepository,
): RequestIdentity {
  const identity = requireRole(request, repository, "editor");
  if (!identity.local) {
    throw new HttpError(403, "此操作只能在本机桌面端完成", "LOCAL_ONLY");
  }
  return identity;
}
