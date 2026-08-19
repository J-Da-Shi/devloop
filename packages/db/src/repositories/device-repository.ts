import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { DeviceRole, DomainEvent, PairedDevice } from "@devloop/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { pairedDevices, pairingSessions } from "../schema.js";
import { hash, mapDevice, now } from "./repository-codecs.js";
import { WorkerRepository } from "./worker-repository.js";
import type { EventfulResult } from "./repository-types.js";

export class DeviceRepository extends WorkerRepository {
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
}
