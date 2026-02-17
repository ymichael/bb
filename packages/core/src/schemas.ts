import { z } from "zod";

export const promptInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
  }),
]);

export const taskStatusSchema = z.enum([
  "open",
  "in_progress",
  "blocked",
  "closed",
]);

export const taskCloseReasonSchema = z.enum([
  "completed",
  "failed",
  "canceled",
]);

export const taskDependencyTypeSchema = z.enum([
  "blocks",
  "parent-child",
  "related",
]);

// Thread schemas
export const spawnThreadSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1).optional(),
  model: z.string().optional(),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  sandboxMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional(),
});

export const tellThreadSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  sandboxMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional(),
  mode: z.enum(["auto", "start", "steer"]).optional(),
});

// Task schemas
export const createTaskSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  parentId: z.string().optional(),
  assignee: z.string().min(1).optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: taskStatusSchema.optional(),
  closeReason: taskCloseReasonSchema.optional(),
  resultSummary: z.string().optional(),
  assignee: z.string().min(1).optional(),
});

export const assignTaskSchema = z.object({
  assignee: z.string().min(1),
});

export const taskChatSchema = z.object({
  input: z.array(promptInputSchema).min(1),
});

export const createTaskDependencySchema = z.object({
  dependsOnTaskId: z.string(),
  type: taskDependencyTypeSchema,
});

// Project schemas
export const createProjectSchema = z.object({
  name: z.string(),
  rootPath: z.string(),
});
