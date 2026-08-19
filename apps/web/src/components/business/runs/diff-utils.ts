import type { RunChangedFile, RunConflictFile, RunConflictResolution } from "@devloop/shared";

export const statusLabel: Record<RunChangedFile["status"], string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  typechange: "类型变更",
};

export function findFileConflict(
  file: RunChangedFile,
  conflicts: RunConflictFile[],
): RunConflictFile | undefined {
  return conflicts.find(
    (conflict) => conflict.path === file.path || conflict.path === file.oldPath,
  );
}

export function conflictResolutionsEqual(
  left: RunConflictResolution | undefined,
  right: RunConflictResolution | undefined,
): boolean {
  if (!left || !right || left.path !== right.path || left.strategy !== right.strategy) {
    return false;
  }
  return (
    left.strategy !== "content" || right.strategy !== "content" || left.content === right.content
  );
}
