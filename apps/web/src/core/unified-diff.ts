export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "conflict" | "context";

export interface UnifiedDiffLine {
  text: string;
  kind: DiffLineKind;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

interface HunkPosition {
  oldLineNumber: number;
  newLineNumber: number;
  oldLinesRemaining: number;
  newLinesRemaining: number;
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(patch: string): UnifiedDiffLine[] {
  let hunk: HunkPosition | null = null;

  return patch.split("\n").map((text) => {
    const hunkMatch = text.match(hunkHeaderPattern);
    const kind = classifyDiffLine(text);

    if (hunkMatch) {
      hunk = {
        oldLineNumber: parseNumber(hunkMatch[1], 0),
        oldLinesRemaining: parseNumber(hunkMatch[2], 1),
        newLineNumber: parseNumber(hunkMatch[3], 0),
        newLinesRemaining: parseNumber(hunkMatch[4], 1),
      };
      return createLine(text, kind);
    }

    if (hunk) {
      if (text.startsWith("+") && hunk.newLinesRemaining > 0) {
        const line = createLine(text, contentKind(kind, "add"), null, hunk.newLineNumber);
        hunk.newLineNumber += 1;
        hunk.newLinesRemaining -= 1;
        hunk = finishHunk(hunk);
        return line;
      }
      if (text.startsWith("-") && hunk.oldLinesRemaining > 0) {
        const line = createLine(text, contentKind(kind, "del"), hunk.oldLineNumber, null);
        hunk.oldLineNumber += 1;
        hunk.oldLinesRemaining -= 1;
        hunk = finishHunk(hunk);
        return line;
      }
      if (text.startsWith(" ") && hunk.oldLinesRemaining > 0 && hunk.newLinesRemaining > 0) {
        const line = createLine(
          text,
          contentKind(kind, "context"),
          hunk.oldLineNumber,
          hunk.newLineNumber,
        );
        hunk.oldLineNumber += 1;
        hunk.newLineNumber += 1;
        hunk.oldLinesRemaining -= 1;
        hunk.newLinesRemaining -= 1;
        hunk = finishHunk(hunk);
        return line;
      }
    }

    return createLine(text, kind);
  });
}

function parseNumber(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.parseInt(value, 10);
}

function finishHunk(hunk: HunkPosition): HunkPosition | null {
  return hunk.oldLinesRemaining === 0 && hunk.newLinesRemaining === 0 ? null : hunk;
}

function contentKind(kind: DiffLineKind, fallback: "add" | "del" | "context"): DiffLineKind {
  return kind === "conflict" ? kind : fallback;
}

function createLine(
  text: string,
  kind: DiffLineKind,
  oldLineNumber: number | null = null,
  newLineNumber: number | null = null,
): UnifiedDiffLine {
  return { text, kind, oldLineNumber, newLineNumber };
}

function classifyDiffLine(text: string): DiffLineKind {
  const conflictContent = text.replace(/^[ +\-]{0,2}/, "");
  if (
    conflictContent.startsWith("<<<<<<<") ||
    conflictContent.startsWith("=======") ||
    conflictContent.startsWith(">>>>>>>")
  ) {
    return "conflict";
  }
  if (text.startsWith("+++") || text.startsWith("---")) return "meta";
  if (text.startsWith("@@")) return "hunk";
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "del";
  if (
    text.startsWith("diff ") ||
    text.startsWith("index ") ||
    text.startsWith("new file") ||
    text.startsWith("deleted file") ||
    text.startsWith("rename ") ||
    text.startsWith("similarity ") ||
    text.startsWith("Binary files") ||
    text.startsWith("\\ No newline at end of file")
  ) {
    return "meta";
  }
  return "context";
}
