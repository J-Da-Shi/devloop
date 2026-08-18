import { z } from "zod";
import { baseStrategySchema, projectRunnerSchema, taskStatusSchema } from "./domain.js";

const isSshRepositoryUrl = (value: string): boolean => {
  if (value.startsWith("ssh://")) {
    return /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+(?::\d+)?\/[^\s/][^\s]*$/.test(value);
  }
  if (value.includes("://")) {
    return false;
  }
  return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:[^\s]+$/.test(value);
};

export const repositoryUrlSchema = z
  .string()
  .trim()
  .min(1, "仓库地址不能为空")
  .max(2048, "仓库地址不能超过 2048 个字符")
  .refine(isSshRepositoryUrl, "首版仅支持 SSH Git 地址，且地址中不能包含密码");

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  repositoryUrl: repositoryUrlSchema,
  defaultBaseRef: z.string().trim().min(1).max(200).default("main"),
  runner: projectRunnerSchema.default("codex"),
});

export const createLocalProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1, "项目目录不能为空").max(2048),
  runner: projectRunnerSchema.default("codex"),
});

export const updateProjectRunnerInputSchema = z.object({
  runner: projectRunnerSchema,
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().uuid(),
});

export const targetBranchSchema = z
  .string()
  .trim()
  .min(1, "目标分支不能为空")
  .max(200, "目标分支不能超过 200 个字符");

export const createTaskInputSchema = z.object({
  projectId: z.string().uuid(),
  targetBranch: targetBranchSchema,
  autoResolveConflicts: z.boolean().default(true),
  title: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(8000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  priority: z.number().int().min(0).max(100).default(50),
});

export const updateTaskInputSchema = z
  .object({
    targetBranch: targetBranchSchema.optional(),
    autoResolveConflicts: z.boolean().optional(),
    title: z.string().trim().min(1).max(160).optional(),
    goal: z.string().trim().min(1).max(8000).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(20).optional(),
    priority: z.number().int().min(0).max(100).optional(),
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().uuid(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.targetBranch !== undefined ||
      value.autoResolveConflicts !== undefined ||
      value.goal !== undefined ||
      value.acceptanceCriteria !== undefined ||
      value.priority !== undefined,
    "At least one editable field is required",
  );

export const taskCommandInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().uuid(),
});

const conflictPathSchema = z.string().min(1).max(1024);
const commitHashSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "目标 Commit 格式无效");
export const runConflictResolutionSchema = z.discriminatedUnion("strategy", [
  z.object({
    path: conflictPathSchema,
    strategy: z.literal("content"),
    content: z.string().max(750_000),
  }),
  z.object({ path: conflictPathSchema, strategy: z.literal("target") }),
  z.object({ path: conflictPathSchema, strategy: z.literal("result") }),
]);

export const approveRunInputSchema = taskCommandInputSchema
  .extend({
    expectedTargetCommit: commitHashSchema.nullable().optional(),
    conflictResolutions: z.array(runConflictResolutionSchema).max(100).optional(),
  })
  .superRefine((value, context) => {
    const paths = new Set<string>();
    let contentLength = 0;
    for (const [index, resolution] of (value.conflictResolutions ?? []).entries()) {
      if (paths.has(resolution.path)) {
        context.addIssue({
          code: "custom",
          path: ["conflictResolutions", index, "path"],
          message: "同一个冲突文件只能提交一份解决结果",
        });
      }
      paths.add(resolution.path);
      if (resolution.strategy === "content") {
        contentLength += resolution.content.length;
      }
    }
    if (contentLength > 900_000) {
      context.addIssue({
        code: "custom",
        path: ["conflictResolutions"],
        message: "冲突解决内容总长度不能超过 900000 个字符",
      });
    }
  });

export const resolveRunConflictsInputSchema = taskCommandInputSchema.extend({
  expectedTargetCommit: commitHashSchema,
});

export const runConflictAgentResolutionSchema = z.object({
  targetCommit: commitHashSchema,
  resolutions: z.array(runConflictResolutionSchema).max(100),
  summary: z.string().min(1).max(16_000),
  completedAt: z.string().datetime(),
});

export const confirmTaskInputSchema = taskCommandInputSchema.extend({
  baseStrategy: baseStrategySchema.default("LATEST_ACCEPTED"),
  baseRef: z.string().trim().min(1).max(200).default("HEAD"),
});

export const rejectRunInputSchema = taskCommandInputSchema.extend({
  feedback: z.string().trim().min(1).max(4000),
});

export const skillContentSchema = z
  .string()
  .min(1, "Skill 内容不能为空")
  .max(100_000, "Skill 内容不能超过 100000 个字符");

export const validateSkillInputSchema = z.object({
  content: skillContentSchema,
});

export const createSkillInputSchema = validateSkillInputSchema;

export const createSkillVersionInputSchema = validateSkillInputSchema.extend({
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().uuid(),
});

export const updateSkillInputSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().uuid(),
});

export const taskQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  projectId: z.string().uuid().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type CreateLocalProjectInput = z.infer<typeof createLocalProjectInputSchema>;
export type UpdateProjectRunnerInput = z.infer<typeof updateProjectRunnerInputSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;
export type TaskCommandInput = z.infer<typeof taskCommandInputSchema>;
export type ApproveRunInput = z.infer<typeof approveRunInputSchema>;
export type ResolveRunConflictsInput = z.infer<typeof resolveRunConflictsInputSchema>;
export type ConfirmTaskInput = z.infer<typeof confirmTaskInputSchema>;
export type RejectRunInput = z.infer<typeof rejectRunInputSchema>;
export type ValidateSkillInput = z.infer<typeof validateSkillInputSchema>;
export type CreateSkillInput = z.infer<typeof createSkillInputSchema>;
export type CreateSkillVersionInput = z.infer<typeof createSkillVersionInputSchema>;
export type UpdateSkillInput = z.infer<typeof updateSkillInputSchema>;
