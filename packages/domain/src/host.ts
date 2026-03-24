import { z } from "zod";

export const hostTypeValues = ["persistent", "ephemeral"] as const;
export const hostTypeSchema = z.enum(hostTypeValues);
export type HostType = z.infer<typeof hostTypeSchema>;

export const hostSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: hostTypeSchema,
  provider: z.string().optional(),
  externalId: z.string().optional(),
  lastSeenAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Host = z.infer<typeof hostSchema>;
