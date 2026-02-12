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

// Project schemas
export const createProjectSchema = z.object({
  name: z.string(),
  rootPath: z.string(),
});
