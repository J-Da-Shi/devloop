import { z } from "zod";
import type { TaskType } from "@devloop/shared";

export const taskFormSchema = z.object({
  projectId: z.string().uuid("请选择项目"),
  taskType: z.enum(["DEVELOPMENT", "RESEARCH"]),
  targetBranch: z.string().trim().min(1, "请输入目标分支").max(200, "分支名过长"),
  title: z.string().trim().min(1, "请输入任务标题").max(160, "标题不能超过 160 个字符"),
  goal: z.string().trim().min(1, "请输入任务目标").max(8_000, "目标内容过长"),
  criteriaText: z.string().trim().min(1, "请至少填写一条验收标准"),
  priority: z.number().int().min(0).max(100),
  autoResolveConflicts: z.boolean(),
});

export type TaskFormValues = z.infer<typeof taskFormSchema>;

export const splitCriteria = (value: string): string[] =>
  value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

export const taskTypeOptions: Array<{ label: string; value: TaskType }> = [
  { label: "代码开发", value: "DEVELOPMENT" },
  { label: "互联网研究", value: "RESEARCH" },
];
