import { randomUUID } from "node:crypto";
import type { Project, UpdateProjectPreviewInput } from "@devloop/shared";
import { and, eq } from "drizzle-orm";
import { projects } from "../schema.js";
import { mapProject, now } from "./repository-codecs.js";
import { RepositoryBase } from "./repository-base.js";
import type {
  EventfulResult,
  ProjectExecutionContext,
  RegisteredProjectInput,
} from "./repository-types.js";

export class ProjectRepository extends RepositoryBase {
  listProjects(): Project[] {
    return this.handle.db.select().from(projects).orderBy(projects.name).all().map(mapProject);
  }

  createProject(input: RegisteredProjectInput): EventfulResult<Project> {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const integrationRef = `refs/devloop/${id}/accepted`;

    return this.handle.sqlite.transaction(() => {
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
      const event = this.insertDomainEvent("project", id, "project.created", { projectId: id });
      return { value: mapProject(row), events: [event], replayed: false };
    })();
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
}
