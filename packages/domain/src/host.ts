import { z } from "zod";
import { jsonValueSchema } from "./json-value.js";
import { permissionModeSchema } from "./shared-types.js";

const hostStatusValues = ["connected", "disconnected"] as const;
export const hostStatusSchema = z.enum(hostStatusValues);

export const machineProviderSelectionSchema = z.object({
  inputs: jsonValueSchema.nullable(),
});
export type MachineProviderSelection = z.infer<
  typeof machineProviderSelectionSchema
>;

export const machineLifecycleSchema = z.object({
  phase: z.enum(["active", "suspended", "retiring", "destroyed"]),
  suspendedAt: z.number().nullable(),
  retireAt: z.number().nullable(),
  progress: z.string().nullable(),
  teardown: z
    .object({
      status: z.enum(["running", "failed", "removed"]),
      attempt: z.number().int().nonnegative(),
      message: z.string().optional(),
    })
    .nullable(),
});
export type MachineLifecycle = z.infer<typeof machineLifecycleSchema>;

export const hostSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: hostStatusSchema,
  machineProviderId: z.string().nullable(),
  machineProviderSelection: machineProviderSelectionSchema.nullable(),
  lifecycle: machineLifecycleSchema,
  maxPermissionMode: permissionModeSchema,
  lastSeenAt: z.number().nullable(),
  lastRejectedProtocolVersion: z.number().int().positive().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Host = z.infer<typeof hostSchema>;
