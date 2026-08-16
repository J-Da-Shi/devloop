import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type {
  CreateSkillVersionInput,
  Skill,
  SkillDetails,
  SkillValidationIssue,
  SkillValidationResult,
  UpdateSkillInput,
} from "@devloop/shared";
import type { DevLoopRepository, EventfulResult } from "@devloop/db";
import type { RunnerSkill } from "@devloop/runners";
import { parse } from "yaml";

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ParsedSkill {
  content: string;
  name: string;
  description: string;
  contentHash: string;
  issues: SkillValidationIssue[];
}

export class SkillValidationError extends Error {
  public constructor(public readonly validation: SkillValidationResult) {
    super("Skill 内容校验失败");
  }
}

const normalizeContent = (content: string): string => `${content.replace(/\r\n?/g, "\n").trim()}\n`;

const hashContent = (content: string): string => createHash("sha256").update(content).digest("hex");

const validationResult = (
  parsed: Pick<ParsedSkill, "name" | "description" | "contentHash" | "issues"> | null,
  issues: SkillValidationIssue[],
): SkillValidationResult => ({
  valid: issues.every((issue) => issue.severity !== "error"),
  name: parsed?.name ?? null,
  description: parsed?.description ?? null,
  contentHash: parsed?.contentHash ?? null,
  issues,
});

export class SkillService {
  public constructor(
    private readonly repository: DevLoopRepository,
    private readonly storageRoot: string,
  ) {}

  validate(content: string): SkillValidationResult {
    const parsed = this.parseContent(content);
    return validationResult(parsed, parsed.issues);
  }

  list(): Skill[] {
    return this.repository.listSkills();
  }

  async listEnabledForExecution(): Promise<RunnerSkill[]> {
    const storedSkills = this.repository
      .listSkills()
      .filter((skill) => skill.enabled)
      .map((skill) => {
        const details = this.repository.getSkillDetails(skill.id);
        if (!details) {
          throw new Error(`找不到已启用 Skill：${skill.name}`);
        }
        return details;
      });

    return Promise.all(
      storedSkills.map(async ({ skill, storagePath }) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        version: skill.currentVersion,
        contentHash: skill.contentHash,
        content: await readFile(this.resolveStoragePath(storagePath), "utf8"),
      })),
    );
  }

  async get(skillId: string): Promise<SkillDetails | null> {
    const details = this.repository.getSkillDetails(skillId);
    if (!details) {
      return null;
    }
    const content = await readFile(this.resolveStoragePath(details.storagePath), "utf8");
    return { skill: details.skill, versions: details.versions, content };
  }

  async create(content: string, deviceId: string): Promise<EventfulResult<Skill>> {
    const parsed = this.requireValidContent(content);
    const stored = await this.writeVersion(parsed.content);
    try {
      return this.repository.createSkill(
        {
          name: parsed.name,
          description: parsed.description,
          contentHash: parsed.contentHash,
          storagePath: stored.storagePath,
        },
        deviceId,
      );
    } catch (error) {
      await stored.cleanup();
      throw error;
    }
  }

  async createVersion(
    skillId: string,
    input: CreateSkillVersionInput,
    deviceId: string,
  ): Promise<EventfulResult<Skill>> {
    const parsed = this.requireValidContent(input.content);
    const stored = await this.writeVersion(parsed.content);
    try {
      const result = this.repository.createSkillVersion(skillId, deviceId, {
        name: parsed.name,
        description: parsed.description,
        contentHash: parsed.contentHash,
        storagePath: stored.storagePath,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      });
      if (result.replayed) {
        await stored.cleanup();
      }
      return result;
    } catch (error) {
      await stored.cleanup();
      throw error;
    }
  }

  setEnabled(skillId: string, input: UpdateSkillInput, deviceId: string): EventfulResult<Skill> {
    return this.repository.setSkillEnabled(
      skillId,
      input.enabled,
      input.expectedVersion,
      deviceId,
      input.idempotencyKey,
    );
  }

  private requireValidContent(content: string): ParsedSkill {
    const parsed = this.parseContent(content);
    const result = validationResult(parsed, parsed.issues);
    if (!result.valid) {
      throw new SkillValidationError(result);
    }
    return parsed;
  }

  private parseContent(content: string): ParsedSkill {
    const normalized = normalizeContent(content);
    const issues: SkillValidationIssue[] = [];
    const lines = normalized.split("\n");
    if (lines[0] !== "---") {
      issues.push({
        severity: "error",
        code: "FRONTMATTER_REQUIRED",
        message: "SKILL.md 必须以 YAML Frontmatter 开始",
      });
      return {
        content: normalized,
        name: "",
        description: "",
        contentHash: hashContent(normalized),
        issues,
      };
    }

    const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
    if (closingIndex < 0) {
      issues.push({
        severity: "error",
        code: "FRONTMATTER_UNCLOSED",
        message: "YAML Frontmatter 缺少结束分隔线",
      });
      return {
        content: normalized,
        name: "",
        description: "",
        contentHash: hashContent(normalized),
        issues,
      };
    }

    const frontmatter = lines.slice(1, closingIndex).join("\n");
    const body = lines
      .slice(closingIndex + 1)
      .join("\n")
      .trim();
    let metadata: unknown;
    try {
      metadata = parse(frontmatter);
    } catch (error) {
      issues.push({
        severity: "error",
        code: "FRONTMATTER_INVALID",
        message: `YAML Frontmatter 无法解析：${error instanceof Error ? error.message : "格式错误"}`,
      });
      return {
        content: normalized,
        name: "",
        description: "",
        contentHash: hashContent(normalized),
        issues,
      };
    }

    const record =
      metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : null;
    if (!record) {
      issues.push({
        severity: "error",
        code: "FRONTMATTER_OBJECT_REQUIRED",
        message: "YAML Frontmatter 必须是键值对象",
      });
    }

    const name = typeof record?.name === "string" ? record.name.trim() : "";
    const description = typeof record?.description === "string" ? record.description.trim() : "";
    const unknownKeys = record
      ? Object.keys(record).filter((key) => key !== "name" && key !== "description")
      : [];
    if (unknownKeys.length > 0) {
      issues.push({
        severity: "error",
        code: "FRONTMATTER_UNKNOWN_FIELDS",
        message: `YAML Frontmatter 只允许 name 和 description，发现：${unknownKeys.join("、")}`,
      });
    }
    if (!name) {
      issues.push({ severity: "error", code: "NAME_REQUIRED", message: "Skill name 不能为空" });
    } else if (name.length > 64 || !skillNamePattern.test(name)) {
      issues.push({
        severity: "error",
        code: "NAME_INVALID",
        message: "Skill name 只能包含小写字母、数字和连字符，且不能超过 64 个字符",
      });
    }
    if (!description) {
      issues.push({
        severity: "error",
        code: "DESCRIPTION_REQUIRED",
        message: "Skill description 不能为空",
      });
    } else if (description.length > 2_000) {
      issues.push({
        severity: "error",
        code: "DESCRIPTION_TOO_LONG",
        message: "Skill description 不能超过 2000 个字符",
      });
    }
    if (!body) {
      issues.push({ severity: "error", code: "BODY_REQUIRED", message: "Skill 正文不能为空" });
    }
    if (body.split("\n").length > 500) {
      issues.push({
        severity: "warning",
        code: "BODY_TOO_LONG",
        message: "Skill 正文超过 500 行，建议把详细资料拆分到 references 目录",
      });
    }

    return {
      content: normalized,
      name,
      description,
      contentHash: hashContent(normalized),
      issues,
    };
  }

  private async writeVersion(content: string): Promise<{
    storagePath: string;
    cleanup(): Promise<void>;
  }> {
    const storageId = randomUUID();
    const stagingDirectory = join(this.storageRoot, ".staging", storageId);
    const finalDirectory = join(this.storageRoot, "versions", storageId);
    await mkdir(stagingDirectory, { recursive: true });
    try {
      await writeFile(join(stagingDirectory, "SKILL.md"), content, {
        encoding: "utf8",
        mode: 0o600,
      });
      await mkdir(dirname(finalDirectory), { recursive: true });
      await rename(stagingDirectory, finalDirectory);
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
    return {
      storagePath: join("versions", storageId, "SKILL.md"),
      cleanup: () => rm(finalDirectory, { recursive: true, force: true }),
    };
  }

  private resolveStoragePath(storagePath: string): string {
    const root = resolve(this.storageRoot);
    const target = resolve(root, storagePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error("Skill 存储路径越界");
    }
    return target;
  }
}
