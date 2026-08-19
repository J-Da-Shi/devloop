import type { SkillValidationResult } from "@devloop/shared";

export type SkillValidationState = "idle" | "waiting" | "checking";

export interface SkillEditorState {
  target: string | "new" | null;
  content: string;
  baseline: string;
  expectedVersion: number | null;
  currentVersionId: string | null;
}

export type SkillValidation = SkillValidationResult | null;
