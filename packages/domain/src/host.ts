import { z } from "zod";
import { permissionModeSchema } from "./shared-types.js";

const hostTypeValues = ["persistent"] as const;
export const hostTypeSchema = z.enum(hostTypeValues);
export type HostType = z.infer<typeof hostTypeSchema>;

const hostStatusValues = ["connected", "disconnected"] as const;
export const hostStatusSchema = z.enum(hostStatusValues);

export const hostSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: hostTypeSchema,
  status: hostStatusSchema,
  maxPermissionMode: permissionModeSchema,
  lastSeenAt: z.number().nullable(),
  lastRejectedProtocolVersion: z.number().int().positive().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Host = z.infer<typeof hostSchema>;
