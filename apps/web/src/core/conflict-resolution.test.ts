import { describe, expect, it } from "vitest";
import {
  findConflictBlocks,
  hasUnresolvedConflictMarkers,
  resolveConflictBlock,
} from "./conflict-resolution.js";

const content = [
  "header\n",
  "<<<<<<< ours\n",
  "target one\n",
  "=======\n",
  "result one\n",
  ">>>>>>> theirs\n",
  "middle\n",
  "<<<<<<< ours\n",
  "target two\n",
  "=======\n",
  "result two\n",
  ">>>>>>> theirs\n",
  "footer\n",
].join("");

describe("conflict resolution", () => {
  it("定位冲突块并保留字符偏移", () => {
    const blocks = findConflictBlocks(content);

    expect(blocks).toHaveLength(2);
    expect(content.slice(blocks[0]?.startOffset, blocks[0]?.endOffset)).toContain("target one");
    expect(content.slice(blocks[1]?.startOffset, blocks[1]?.endOffset)).toContain("result two");
  });

  it("可以逐块采用目标分支、本次结果或双方内容", () => {
    const firstResolved = resolveConflictBlock(content, 0, "target");
    expect(firstResolved).toContain("target one");
    expect(firstResolved).not.toContain("result one");
    expect(findConflictBlocks(firstResolved)).toHaveLength(1);

    const secondResolved = resolveConflictBlock(firstResolved, 0, "both");
    expect(secondResolved).toContain("target two\nresult two\n");
    expect(hasUnresolvedConflictMarkers(secondResolved)).toBe(false);

    expect(resolveConflictBlock(content, 0, "result")).toContain("result one\nmiddle");
  });

  it("残留任意冲突标记时仍视为未解决", () => {
    expect(hasUnresolvedConflictMarkers(content)).toBe(true);
    expect(hasUnresolvedConflictMarkers("<<<<<<< ours\nonly one marker\n")).toBe(true);
    expect(hasUnresolvedConflictMarkers("normal content\n")).toBe(false);
  });
});
