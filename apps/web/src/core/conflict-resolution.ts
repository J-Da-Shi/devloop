export type ConflictChoice = "target" | "result" | "both";

export interface ConflictBlock {
  startLine: number;
  separatorLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

const markerPattern = /^(?:<{7}|={7}|>{7})(?: .*)?$/;
const startMarkerPattern = /^<{7}(?: .*)?$/;
const separatorMarkerPattern = /^={7}(?: .*)?$/;
const endMarkerPattern = /^>{7}(?: .*)?$/;

const splitLines = (content: string): string[] => content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const lineText = (line: string): string => line.replace(/\r?\n$/, "");

export const hasUnresolvedConflictMarkers = (content: string): boolean =>
  splitLines(content).some((line) => markerPattern.test(lineText(line)));

export function findConflictBlocks(content: string): ConflictBlock[] {
  const lines = splitLines(content);
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
  }

  const blocks: ConflictBlock[] = [];
  for (let startLine = 0; startLine < lines.length; startLine += 1) {
    if (!startMarkerPattern.test(lineText(lines[startLine] ?? ""))) continue;
    let separatorLine = -1;
    let endLine = -1;
    for (let index = startLine + 1; index < lines.length; index += 1) {
      const text = lineText(lines[index] ?? "");
      if (separatorLine < 0 && separatorMarkerPattern.test(text)) {
        separatorLine = index;
        continue;
      }
      if (separatorLine >= 0 && endMarkerPattern.test(text)) {
        endLine = index;
        break;
      }
    }
    if (separatorLine < 0 || endLine < 0) continue;
    blocks.push({
      startLine,
      separatorLine,
      endLine,
      startOffset: offsets[startLine] ?? 0,
      endOffset: (offsets[endLine] ?? 0) + (lines[endLine]?.length ?? 0),
    });
    startLine = endLine;
  }
  return blocks;
}

export function resolveConflictBlock(
  content: string,
  blockIndex: number,
  choice: ConflictChoice,
): string {
  const lines = splitLines(content);
  const block = findConflictBlocks(content)[blockIndex];
  if (!block) return content;

  const targetLines = lines.slice(block.startLine + 1, block.separatorLine);
  const resultLines = lines.slice(block.separatorLine + 1, block.endLine);
  const replacement =
    choice === "target"
      ? targetLines
      : choice === "result"
        ? resultLines
        : [...targetLines, ...resultLines];
  return [
    ...lines.slice(0, block.startLine),
    ...replacement,
    ...lines.slice(block.endLine + 1),
  ].join("");
}
