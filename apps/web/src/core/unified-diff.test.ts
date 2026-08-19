import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./unified-diff.js";

describe("parseUnifiedDiff", () => {
  it("为上下文、删除和新增行分配对应的旧新行号", () => {
    const lines = parseUnifiedDiff(
      [
        "diff --git a/example.ts b/example.ts",
        "index 1234567..7654321 100644",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -2,3 +2,4 @@ export function example() {",
        " const stable = true;",
        "-const removed = true;",
        "+const inserted = true;",
        "+const another = true;",
        " return stable;",
      ].join("\n"),
    );

    expect(
      lines.map(({ text, oldLineNumber, newLineNumber }) => [text, oldLineNumber, newLineNumber]),
    ).toEqual([
      ["diff --git a/example.ts b/example.ts", null, null],
      ["index 1234567..7654321 100644", null, null],
      ["--- a/example.ts", null, null],
      ["+++ b/example.ts", null, null],
      ["@@ -2,3 +2,4 @@ export function example() {", null, null],
      [" const stable = true;", 2, 2],
      ["-const removed = true;", 3, null],
      ["+const inserted = true;", null, 3],
      ["+const another = true;", null, 4],
      [" return stable;", 4, 5],
    ]);
  });

  it("在多个 hunk 与空范围中重新开始计数", () => {
    const lines = parseUnifiedDiff(
      [
        "@@ -0,0 +1,2 @@",
        "+first",
        "+second",
        "@@ -8,2 +10,0 @@",
        "-before",
        "-after",
        "\\ No newline at end of file",
      ].join("\n"),
    );

    expect(lines.map(({ oldLineNumber, newLineNumber }) => [oldLineNumber, newLineNumber])).toEqual(
      [
        [null, null],
        [null, 1],
        [null, 2],
        [null, null],
        [8, null],
        [9, null],
        [null, null],
      ],
    );
  });

  it("保留冲突标记的高亮类型，同时计算其所在的新行号", () => {
    const [header, marker] = parseUnifiedDiff(["@@ -4 +4 @@", "+<<<<<<< result"].join("\n"));

    expect(header).toMatchObject({ kind: "hunk", oldLineNumber: null, newLineNumber: null });
    expect(marker).toMatchObject({ kind: "conflict", oldLineNumber: null, newLineNumber: 4 });
  });

  it("不会把 hunk 内以加减号开头的代码误判为文件元数据", () => {
    const [, removed, added, nextFileHeader] = parseUnifiedDiff(
      ["@@ -7 +7 @@", "---removedOption", "+++addedOption", "--- a/next.ts"].join("\n"),
    );

    expect(removed).toMatchObject({ kind: "del", oldLineNumber: 7, newLineNumber: null });
    expect(added).toMatchObject({ kind: "add", oldLineNumber: null, newLineNumber: 7 });
    expect(nextFileHeader).toMatchObject({
      kind: "meta",
      oldLineNumber: null,
      newLineNumber: null,
    });
  });
});
