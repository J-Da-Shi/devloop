import { randomUUID } from "node:crypto";
import type { Skill } from "@devloop/shared";
import { and, desc, eq } from "drizzle-orm";
import { skillVersions, skills } from "../schema.js";
import { mapSkill, mapSkillVersion, now } from "./repository-codecs.js";
import { ProjectRepository } from "./project-repository.js";
import type {
  EventfulResult,
  StoredSkillDetails,
  StoredSkillVersionInput,
} from "./repository-types.js";

export class SkillRepository extends ProjectRepository {
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
}
