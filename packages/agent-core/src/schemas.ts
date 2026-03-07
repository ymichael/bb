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
  z.object({
    type: z.literal("localFile"),
    path: z.string(),
    name: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().optional(),
  }),
]);

// Thread schemas
export const spawnThreadSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1).optional(),
  model: z.string().optional(),
  serviceTier: z.enum(["fast", "flex"]).optional(),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  sandboxMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional(),
  environmentId: z.string().min(1).optional(),
  developerInstructions: z.string().optional(),
  parentThreadId: z.string().optional(),
});

export const tellThreadSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: z.enum(["fast", "flex"]).optional(),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  sandboxMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional(),
  mode: z.enum(["auto", "start", "steer"]).optional(),
  demotePrimaryIfNeeded: z.boolean().optional(),
});

export const enqueueThreadMessageSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: z.enum(["fast", "flex"]).optional(),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  sandboxMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional(),
});

export const sendQueuedThreadMessageSchema = z.object({
  mode: z.enum(["auto", "steer-if-active", "steer"]).optional(),
});

export const updateThreadSchema = z
  .object({
    title: z.string().min(1).optional(),
  })
  .refine((value) => value.title !== undefined, "At least one field must be provided");

// Project schemas
export const createProjectSchema = z.object({
  name: z.string(),
  rootPath: z.string(),
});

export const updateProjectSchema = z
  .object({
    name: z.string().optional(),
    rootPath: z.string().optional(),
    projectInstructions: z.string().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.rootPath !== undefined ||
      value.projectInstructions !== undefined,
    "At least one field must be provided",
  );

const commitOperationOptionsSchema = z.object({
  message: z.string().min(1).optional(),
  includeUnstaged: z.boolean().optional(),
  autoArchiveOnSuccess: z.boolean().optional(),
});

const squashMergeOperationOptionsSchema = z.object({
  commitIfNeeded: z.boolean().optional(),
  includeUnstaged: z.boolean().optional(),
  commitMessage: z.string().min(1).optional(),
  squashMessage: z.string().min(1).optional(),
  mergeBaseBranch: z.string().min(1).optional(),
  autoArchiveOnSuccess: z.boolean().optional(),
});

export const threadOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("commit"),
    options: commitOperationOptionsSchema.optional(),
  }),
  z.object({
    operation: z.literal("squash_merge"),
    options: squashMergeOperationOptionsSchema.optional(),
  }),
]);
