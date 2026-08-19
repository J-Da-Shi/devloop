import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { DevLoopRepository } from "@devloop/db";
import {
  playwrightValidationReportSchema,
  type PlaywrightValidationReport,
  type RunArtifact,
} from "@devloop/shared";

export interface RunValidationArtifacts {
  report: PlaywrightValidationReport | null;
  artifacts: RunArtifact[];
}

export class ArtifactService {
  public constructor(
    private readonly repository: DevLoopRepository,
    private readonly artifactsRoot: string,
  ) {}

  async write(
    runId: string,
    kind: string,
    extension: string,
    content: Uint8Array | string,
  ): Promise<RunArtifact> {
    const directory = resolve(this.artifactsRoot, runId, "playwright");
    this.assertManagedPath(directory);
    await mkdir(directory, { recursive: true });
    const storagePath = resolve(directory, `${randomUUID()}.${extension.replace(/^\./, "")}`);
    this.assertManagedPath(storagePath);
    const buffer =
      typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    await writeFile(storagePath, buffer);
    return this.repository.createRunArtifact({
      runId,
      kind,
      storagePath,
      size: buffer.byteLength,
      checksum: createHash("sha256").update(buffer).digest("hex"),
    });
  }

  async writeValidationReport(
    runId: string,
    report: PlaywrightValidationReport,
  ): Promise<RunArtifact> {
    const parsed = playwrightValidationReportSchema.parse(report);
    return this.write(runId, "playwright-report", "json", JSON.stringify(parsed, null, 2));
  }

  async getValidationArtifacts(runId: string): Promise<RunValidationArtifacts> {
    const artifacts = this.repository.listRunArtifacts(runId);
    const reportArtifact = artifacts.filter((item) => item.kind === "playwright-report").at(-1);
    if (!reportArtifact) {
      return { report: null, artifacts };
    }
    const stored = this.repository.getRunArtifact(runId, reportArtifact.id);
    if (!stored) {
      return { report: null, artifacts };
    }
    const content = await this.readManagedFile(stored.storagePath);
    return {
      report: playwrightValidationReportSchema.parse(JSON.parse(content.toString("utf8"))),
      artifacts,
    };
  }

  async read(
    runId: string,
    artifactId: string,
  ): Promise<{
    artifact: RunArtifact;
    content: Buffer;
  } | null> {
    const stored = this.repository.getRunArtifact(runId, artifactId);
    if (!stored) return null;
    return {
      artifact: stored.artifact,
      content: await this.readManagedFile(stored.storagePath),
    };
  }

  private async readManagedFile(storagePath: string): Promise<Buffer> {
    this.assertManagedPath(storagePath);
    return readFile(storagePath);
  }

  private assertManagedPath(candidate: string): void {
    const root = resolve(this.artifactsRoot);
    const target = resolve(candidate);
    const relativePath = relative(root, target);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("产物路径超出 DevLoop 受管目录");
    }
  }
}
