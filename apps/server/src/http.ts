import type { DeviceRole } from "@devloop/shared";
import type { FastifyRequest } from "fastify";

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
  kind: "owner";
}

const roleRank: Record<DeviceRole, number> = {
  viewer: 0,
  operator: 1,
  editor: 2,
};

export function resolveIdentity(): RequestIdentity {
  return {
    id: "instance-owner",
    name: "实例所有者",
    role: "editor",
    kind: "owner",
  };
}

export function requireRole(
  _request: FastifyRequest,
  minimumRole: DeviceRole,
): RequestIdentity {
  const identity = resolveIdentity();
  if (roleRank[identity.role] < roleRank[minimumRole]) {
    throw new HttpError(403, "当前实例没有执行此操作的权限", "ROLE_REQUIRED");
  }
  return identity;
}
