import type { FragmentSpec } from "@devloop/context";
import type { RunnerSkill } from "./types.js";

/**
 * 把启用的 Skill 序列化成 Fragment 列表（供 pipeline 消费）：
 * - 头部与尾部说明使用 source=template.header / template.footer，被识别为 SYSTEM。
 * - 每个 skill 一个独立 CITATION Fragment（source=skill），压缩器在 STRONG 阶段仍保留。
 * - 不再有 200KB 硬上限；超预算时由 pipeline 与压缩器统一降级。
 */
export const buildSkillFragments = (skills: RunnerSkill[]): FragmentSpec[] => {
  if (skills.length === 0) return [];
  const specs: FragmentSpec[] = [];
  specs.push({
    text: [
      "已启用的 DevLoop Skills：",
      "- 必须先阅读以下 Skill，并在其适用范围内遵循其中的执行规范。",
      "- Skill 与本任务的明确目标、验收标准或后续执行要求冲突时，以后者为准。",
    ].join("\n"),
    metadata: { source: "template.header" },
  });
  for (const [index, skill] of skills.entries()) {
    specs.push({
      text: [
        `===== Skill ${index + 1}: ${skill.name} (v${skill.version}) =====`,
        `描述：${skill.description}`,
        skill.content.trim(),
        `===== Skill ${index + 1} 结束 =====`,
      ].join("\n"),
      metadata: { source: "skill" },
    });
  }
  specs.push({
    text: "已启用 Skill 内容结束。上方任务目标、验收标准以及后续执行要求具有更高优先级。",
    metadata: { source: "template.footer" },
  });
  return specs;
};

/**
 * 兼容旧调用：把 Fragment 列表压平成字符串数组，返给还没走 pipeline 的地方（例如 conflict-resolution 分支的老代码）。
 */
export const buildSkillsPrompt = (skills: RunnerSkill[]): string[] =>
  buildSkillFragments(skills).map((s) => s.text);
