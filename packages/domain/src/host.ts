import { z } from "zod";

export const hostTypeValues = ["persistent", "ephemeral"] as const;
export const hostTypeSchema = z.enum(hostTypeValues);
export type HostType = z.infer<typeof hostTypeSchema>;

export const hostStatusValues = [
  "connected",
  "disconnected",
  "suspended",
] as const;
export const hostStatusSchema = z.enum(hostStatusValues);
export type HostStatus = z.infer<typeof hostStatusSchema>;

export const hostSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: hostTypeSchema,
  status: hostStatusSchema.optional(),
  provider: z.string().optional(),
  externalId: z.string().optional(),
  lastSeenAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Host = z.infer<typeof hostSchema>;
