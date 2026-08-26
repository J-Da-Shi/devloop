export type SkillValidationState = "idle" | "waiting" | "checking";

export interface SkillEditorState {
  target: string | "new" | null;
  content: string;
  baseline: string;
  expectedVersion: number | null;
  currentVersionId: string | null;
}
