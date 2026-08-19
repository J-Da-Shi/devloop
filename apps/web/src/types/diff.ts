export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "conflict" | "context";

export interface UnifiedDiffLine {
  text: string;
  kind: DiffLineKind;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export type ConflictChoice = "target" | "result" | "both";

export interface ConflictBlock {
  startLine: number;
  separatorLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}
