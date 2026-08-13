import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DevLoopRepository, openDatabase, type DatabaseHandle } from "@devloop/db";
import { SkillService, SkillValidationError } from "./skill-service.js";

const migrationsFolder = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));
const handles: DatabaseHandle[] = [];
const temporaryDirectories: string[] = [];

const validContent = (description = "规范化前端界面并检查交互一致性") => `---
name: frontend-quality
description: ${description}
---

# 工作流

1. 阅读现有设计规范。
2. 完成界面修改并检查响应式布局。
`;

const createService = async (): Promise<SkillService> => {
  const root = await mkdtemp(join(tmpdir(), "devloop-skills-"));
  temporaryDirectories.push(root);
  const handle = openDatabase({ filePath: ":memory:", migrationsFolder });
  handles.push(handle);
  return new SkillService(new DevLoopRepository(handle), root);
};

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SkillService", () => {
  it("校验并创建不可变的第一版 Skill", async () => {
    const service = await createService();
    const validation = service.validate(validContent());

    expect(validation.valid).toBe(true);
    expect(validation.name).toBe("frontend-quality");
    expect(validation.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const created = await service.create(validContent(), "local-desktop");
    const details = await service.get(created.value.id);

    expect(created.value.currentVersion).toBe(1);
    expect(details?.versions).toHaveLength(1);
    expect(details?.content).toBe(validContent());
    expect(details?.skill.contentHash).toBe(validation.contentHash);
  });

  it("发布新内容时创建新版本并保留旧文件", async () => {
    const service = await createService();
    const created = await service.create(validContent(), "local-desktop");
    const firstDetails = await service.get(created.value.id);
    const nextContent = validContent("对前端界面执行专业级设计检查和响应式验证");

    const updated = await service.createVersion(
      created.value.id,
      {
        content: nextContent,
        expectedVersion: created.value.version,
        idempotencyKey: crypto.randomUUID(),
      },
      "local-desktop",
    );
    const details = await service.get(created.value.id);

    expect(updated.value.currentVersion).toBe(2);
    expect(details?.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(details?.content).toBe(nextContent);
    const firstVersion = firstDetails?.versions[0];
    expect(firstVersion?.contentHash).not.toBe(details?.skill.contentHash);
  });

  it("拒绝未知 Frontmatter 字段和不合法名称", async () => {
    const service = await createService();
    const content = `---
name: Frontend Quality
description: 界面检查
metadata: 不允许
---

# 工作流

执行检查。
`;
    const validation = service.validate(content);

    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["NAME_INVALID", "FRONTMATTER_UNKNOWN_FIELDS"]),
    );
    await expect(service.create(content, "local-desktop")).rejects.toBeInstanceOf(
      SkillValidationError,
    );
  });

  it("启停 Skill 时使用乐观并发版本", async () => {
    const service = await createService();
    const created = await service.create(validContent(), "local-desktop");

    const disabled = service.setEnabled(
      created.value.id,
      {
        enabled: false,
        expectedVersion: created.value.version,
        idempotencyKey: crypto.randomUUID(),
      },
      "local-desktop",
    );

    expect(disabled.value.enabled).toBe(false);
    expect(disabled.value.version).toBe(created.value.version + 1);
    expect(() =>
      service.setEnabled(
        created.value.id,
        {
          enabled: true,
          expectedVersion: created.value.version,
          idempotencyKey: crypto.randomUUID(),
        },
        "local-desktop",
      ),
    ).toThrow("Version conflict");
  });
});
