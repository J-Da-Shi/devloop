import { describe, expect, it } from "vitest";
import { buildRetryContextFragments, buildRetryContextPrompt } from "./retry-context-prompt.js";

const sampleRetryContext = {
  sourceRunId: "r0",
  sourceStatus: "FAILED" as const,
  sourceRunner: "codex",
  sourceFinishedAt: "2026-08-20T00:00:00Z",
  summary: "失败原因摘要",
  baseCommit: null,
  resultCommit: null,
  events: [
    { type: "run.playwright.failed", message: "断言失败", createdAt: "2026-08-20T00:00:01Z" },
    { type: "runner.command", message: "npm test", createdAt: "2026-08-20T00:00:00Z" },
  ],
};

describe("buildRetryContextFragments", () => {
  it("空 retryContext 返回空数组", () => {
    expect(buildRetryContextFragments(null)).toEqual([]);
    expect(buildRetryContextFragments(undefined)).toEqual([]);
  });

  it("summary 落 review.feedback、events 按类型打 event: 前缀", () => {
    const specs = buildRetryContextFragments(sampleRetryContext);
    const summaryFrag = specs.find((s) => s.text.includes("失败原因摘要"));
    expect(summaryFrag?.metadata?.source).toBe("review.feedback");
    const failedFrag = specs.find((s) => s.text.includes("断言失败"));
    expect(failedFrag?.metadata?.source).toBe("event:run.playwright.failed");
    const cmdFrag = specs.find((s) => s.text.includes("npm test"));
    expect(cmdFrag?.metadata?.source).toBe("event:runner.command");
  });

  it("头尾说明段带 template.rules", () => {
    const specs = buildRetryContextFragments(sampleRetryContext);
    expect(specs[0]!.metadata?.source).toBe("template.rules");
    expect(specs[specs.length - 1]!.metadata?.source).toBe("template.rules");
  });

  it("events 附 ageTurns 数值", () => {
    const specs = buildRetryContextFragments(sampleRetryContext);
    const eventSpecs = specs.filter((s) => s.metadata?.source?.startsWith("event:"));
    for (const spec of eventSpecs) {
      expect(typeof spec.metadata?.ageTurns).toBe("number");
    }
  });
});

describe("buildRetryContextPrompt 兼容旧字符串数组", () => {
  it("返回字符串数组且包含摘要与事件", () => {
    const lines = buildRetryContextPrompt(sampleRetryContext);
    const joined = lines.join("\n");
    expect(joined).toContain("失败原因摘要");
    expect(joined).toContain("断言失败");
    expect(joined).toContain("从失败点继续排查和实施");
  });
});
