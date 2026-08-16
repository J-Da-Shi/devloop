import { describe, expect, it } from "vitest";
import { buildSkillsPrompt, MAX_SKILLS_PROMPT_CHARACTERS } from "./skill-prompt.js";
import type { RunnerSkill } from "./types.js";

const createSkill = (id: string, content: string): RunnerSkill => ({
  id,
  name: `quality-${id}`,
  description: `执行 ${id} 质量检查`,
  version: 1,
  contentHash: `hash-${id}`,
  content,
});

describe("Skill Prompt", () => {
  it("允许单个最大 Skill，并拒绝超过总字符上限的组合", () => {
    const maximumSkill = createSkill("maximum", "x".repeat(100_000));
    const prompt = buildSkillsPrompt([maximumSkill]).join("\n");

    expect(prompt.length).toBeLessThanOrEqual(MAX_SKILLS_PROMPT_CHARACTERS);
    expect(() =>
      buildSkillsPrompt([maximumSkill, createSkill("second", "y".repeat(100_000))]),
    ).toThrow(`超过 ${MAX_SKILLS_PROMPT_CHARACTERS} 个字符上限`);
  });
});
