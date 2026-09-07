import { z } from "zod";

export const bashArgsSchema = z
  .object({
    command: z.string().optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
