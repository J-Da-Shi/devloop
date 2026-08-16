import type { RunnerInput } from "./types.js";

export const MAX_SKILLS_PROMPT_CHARACTERS = 200_000;

export const buildSkillsPrompt = (skills: RunnerInput["skills"]): string[] => {
  if (skills.length === 0) {
    return [];
  }

  const lines = [
    "",
    "已启用的 DevLoop Skills：",
    "- 必须先阅读以下 Skill，并在其适用范围内遵循其中的执行规范。",
    "- Skill 与本任务的明确目标、验收标准或后续执行要求冲突时，以后者为准。",
    ...skills.flatMap((skill, index) => [
      "",
      `===== Skill ${index + 1}: ${skill.name} (v${skill.version}) =====`,
      `描述：${skill.description}`,
      skill.content.trim(),
      `===== Skill ${index + 1} 结束 =====`,
    ]),
    "",
    "已启用 Skill 内容结束。上方任务目标、验收标准以及后续执行要求具有更高优先级。",
  ];
  const characterCount = lines.reduce(
    (total, line, index) => total + line.length + (index === 0 ? 0 : 1),
    0,
  );
  if (characterCount > MAX_SKILLS_PROMPT_CHARACTERS) {
    throw new Error(
      `已启用 Skill Prompt 总长度为 ${characterCount} 个字符，超过 ${MAX_SKILLS_PROMPT_CHARACTERS} 个字符上限；请停用部分 Skill 或缩短内容。`,
    );
  }
  return lines;
};
