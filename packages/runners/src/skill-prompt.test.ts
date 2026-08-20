import { describe, expect, it } from "vitest";
import { buildSkillFragments, buildSkillsPrompt } from "./skill-prompt.js";
import type { RunnerSkill } from "./types.js";

const skill = (id: string, content: string): RunnerSkill => ({
  id,
  name: `s-${id}`,
  description: `s ${id}`,
  version: 1,
  contentHash: `h${id}`,
  content,
});

describe("buildSkillFragments", () => {
  it("每个 skill 产出独立 CITATION Fragment 并附 source=skill", () => {
    const specs = buildSkillFragments([skill("a", "内容 A"), skill("b", "内容 B")]);
    expect(specs.length).toBeGreaterThanOrEqual(2);
    const skillSpecs = specs.filter((s) => s.metadata?.source === "skill");
    expect(skillSpecs).toHaveLength(2);
    expect(skillSpecs[0]!.text).toContain("s-a");
    expect(skillSpecs[0]!.text).toContain("内容 A");
    expect(skillSpecs[1]!.text).toContain("s-b");
  });

  it("头尾说明分别落 template.header / template.footer", () => {
    const specs = buildSkillFragments([skill("a", "内容")]);
    expect(specs[0]!.metadata?.source).toBe("template.header");
    expect(specs[specs.length - 1]!.metadata?.source).toBe("template.footer");
  });

  it("空 skill 列表返回空数组", () => {
    expect(buildSkillFragments([])).toEqual([]);
  });

  it("超长内容不再抛异常（去掉 200KB 硬上限）", () => {
    const huge = skill("big", "x".repeat(300_000));
    expect(() => buildSkillFragments([huge])).not.toThrow();
  });
});

describe("兼容旧 buildSkillsPrompt", () => {
  it("返回字符串数组", () => {
    const lines = buildSkillsPrompt([skill("a", "内容")]);
    expect(lines).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(lines.join("\n")).toContain("s-a");
  });
});
