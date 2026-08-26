import type { RunnerResult } from "@devloop/runners";

const runnersRequiringWorktree = new Set(["codex", "claude-code"]);

export const runnerRequiresWorktree = (runnerId: string): boolean =>
  runnersRequiringWorktree.has(runnerId);

export class AutoConflictResolutionError extends Error {
  public constructor(
    public readonly outcome: "blocked" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "AutoConflictResolutionError";
  }
}

export const formatRunnerResult = (result: RunnerResult): string => {
  const criteria = result.acceptanceCriteria?.map(
    (item) =>
      `${item.status === "passed" ? "通过" : item.status === "failed" ? "失败" : "无法验证"}：${item.criterion}（${item.evidence}）`,
  );
  return [
    result.summary,
    result.blockedReason ? `阻塞原因：${result.blockedReason}` : null,
    criteria?.length ? `验收结果：\n${criteria.join("\n")}` : null,
    result.risks.length ? `风险：\n${result.risks.join("\n")}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
};

export type ConflictResolutionStage = "continuation" | "review";

export interface AgentWorkspace {
  path: string | null;
  baseCommit: string | null;
}
