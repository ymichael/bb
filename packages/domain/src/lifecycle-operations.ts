import { z } from "zod";

export const lifecycleOperationStateValues = [
  "requested",
  "queued",
  "fetched",
  "completed",
  "failed",
  "cancelled",
] as const;
export const lifecycleOperationStateSchema = z.enum(
  lifecycleOperationStateValues,
);
export type LifecycleOperationState = z.infer<
  typeof lifecycleOperationStateSchema
>;

export const environmentOperationKindValues = [
  "provision",
  "reprovision",
  "destroy",
] as const;
export const environmentOperationKindSchema = z.enum(
  environmentOperationKindValues,
);
export type EnvironmentOperationKind = z.infer<
  typeof environmentOperationKindSchema
>;

export const threadOperationKindValues = [
  "start",
  "stop",
] as const;
export const threadOperationKindSchema = z.enum(threadOperationKindValues);
export type ThreadOperationKind = z.infer<typeof threadOperationKindSchema>;

export const projectOperationKindValues = [
  "delete",
] as const;
export const projectOperationKindSchema = z.enum(projectOperationKindValues);
export type ProjectOperationKind = z.infer<typeof projectOperationKindSchema>;
