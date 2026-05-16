import { z } from "zod";

export const threadStatusValues = [
  "created",
  "provisioning",
  "idle",
  "active",
  "error",
] as const;
export const threadStatusSchema = z.enum(threadStatusValues);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;
