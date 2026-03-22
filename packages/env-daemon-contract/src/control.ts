import type { Hono } from "hono";
import { hc } from "hono/client";
import { z } from "zod";
import type { EmptyInput, Endpoint } from "./common.js";

export const ENVIRONMENT_DAEMON_PROTOCOL_VERSION = 1 as const;

export const daemonDeliveryReasonSchema = z.enum([
  "accepted",
  "duplicate",
  "sequence_gap",
  "transport_error",
  "thread_archived",
  "thread_inactive",
]);
export type DaemonDeliveryReason = z.infer<
  typeof daemonDeliveryReasonSchema
>;

export const daemonDeliveryRuntimeStateSchema = z.enum([
  "healthy",
  "retrying",
  "stalled",
  "stopped",
]);
export type DaemonDeliveryRuntimeState = z.infer<
  typeof daemonDeliveryRuntimeStateSchema
>;

export const environmentDaemonProviderLaunchWrapperSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
});
export type EnvironmentDaemonProviderLaunchWrapper = z.infer<
  typeof environmentDaemonProviderLaunchWrapperSchema
>;

export const environmentDaemonProviderFilePlacementSchema = z.enum(["home"]);
export type EnvironmentDaemonProviderFilePlacement = z.infer<
  typeof environmentDaemonProviderFilePlacementSchema
>;

export const environmentDaemonProviderFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  placement: environmentDaemonProviderFilePlacementSchema,
});
export type EnvironmentDaemonProviderFile = z.infer<
  typeof environmentDaemonProviderFileSchema
>;

export const environmentDaemonProviderSpecSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  launchCommand: z.string().min(1).optional(),
  launchArgs: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  files: z.array(environmentDaemonProviderFileSchema).optional(),
});
export type EnvironmentDaemonProviderSpec = z.infer<
  typeof environmentDaemonProviderSpecSchema
>;

export const environmentDaemonServerConnectionConfigSchema = z.object({
  serverUrl: z.string().url().optional(),
  authToken: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
  lastAckedSequence: z.number().int().nonnegative().optional(),
});
export type EnvironmentDaemonServerConnectionConfig = z.infer<
  typeof environmentDaemonServerConnectionConfigSchema
>;

export const environmentDaemonConnectionTargetSchema = z.object({
  transport: z.literal("http"),
  baseUrl: z.string().url(),
  headers: z.record(z.string()).optional(),
  serverConnection: environmentDaemonServerConnectionConfigSchema.optional(),
  providerLaunch: environmentDaemonProviderLaunchWrapperSchema.optional(),
});
export type EnvironmentDaemonConnectionTarget = z.infer<
  typeof environmentDaemonConnectionTargetSchema
>;

export const daemonStatusSnapshotSchema = z.object({
  protocolVersion: z.literal(ENVIRONMENT_DAEMON_PROTOCOL_VERSION),
  threadId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
  latestSequence: z.number().int().nonnegative(),
  lastAckedSequence: z.number().int().nonnegative().optional(),
  connectedToServer: z.boolean(),
  pendingEventCount: z.number().int().nonnegative(),
  pendingCommandCount: z.number().int().nonnegative(),
  deliveryState: daemonDeliveryRuntimeStateSchema,
  deliveryIssue: daemonDeliveryReasonSchema.optional(),
  retryAttemptCount: z.number().int().nonnegative(),
  nextRetryAt: z.number().int().nonnegative().optional(),
  lastDeliveryError: z.string().optional(),
});
export type DaemonStatusSnapshot = z.infer<
  typeof daemonStatusSnapshotSchema
>;

export const daemonSessionSyncResponseSchema = z.object({
  ok: z.literal(true),
  status: daemonStatusSnapshotSchema,
});
export type DaemonSessionSyncResponse = z.infer<
  typeof daemonSessionSyncResponseSchema
>;

export const daemonShutdownResponseSchema = z.object({
  ok: z.literal(true),
});
export type DaemonShutdownResponse = z.infer<
  typeof daemonShutdownResponseSchema
>;

export type DaemonControlSchema = {
  "/control/status": {
    $post: Endpoint<EmptyInput, DaemonStatusSnapshot>;
  };
  "/control/session-sync": {
    $post: Endpoint<EmptyInput, DaemonSessionSyncResponse, 202>;
  };
  "/control/shutdown": {
    $post: Endpoint<EmptyInput, DaemonShutdownResponse, 202>;
  };
};

export type DaemonControlRoutes = Hono<{}, DaemonControlSchema, "/">;

export function createDaemonControlClient(baseUrl: string, authToken: string) {
  return hc<DaemonControlRoutes>(`${baseUrl}`, {
    headers: { authorization: `Bearer ${authToken}` },
  });
}
