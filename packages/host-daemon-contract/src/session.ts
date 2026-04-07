import type { Hono } from "hono";
import { hc } from "hono/client";
import {
  ENVIRONMENT_CHANGE_KINDS,
  hostTypeSchema,
  threadEventSchema,
  toolCallRequestSchema,
  toolCallResponseSchema,
} from "@bb/domain";
import { z } from "zod";
import type { Endpoint } from "./common.js";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonCommandEnvelopeSchema,
  hostDaemonCommandResultReportSchema,
} from "./commands.js";

const nonNegativeIntegerStringSchema = z.string().regex(/^\d+$/);
export const HOST_DAEMON_WEBSOCKET_PROTOCOL = "bb-host-daemon.v1";

export const hostDaemonActiveThreadSchema = z.object({
  threadId: z.string().min(1),
});
export type HostDaemonActiveThread = z.infer<typeof hostDaemonActiveThreadSchema>;

export const hostDaemonTrackedThreadTargetSchema = z.object({
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
});
export type HostDaemonTrackedThreadTarget = z.infer<
  typeof hostDaemonTrackedThreadTargetSchema
>;

export const hostDaemonSessionOpenRequestSchema = z.object({
  hostId: z.string().min(1),
  instanceId: z.string().min(1),
  hostName: z.string().min(1),
  hostType: hostTypeSchema,
  dataDir: z.string().min(1),
  protocolVersion: z.literal(HOST_DAEMON_PROTOCOL_VERSION),
  activeThreads: z.array(hostDaemonActiveThreadSchema),
});
export type HostDaemonSessionOpenRequest = z.infer<
  typeof hostDaemonSessionOpenRequestSchema
>;

export const hostDaemonEnrollRequestSchema = z.object({
  hostId: z.string().min(1),
  hostName: z.string().min(1),
  hostType: hostTypeSchema,
}).strict();
export type HostDaemonEnrollRequest = z.infer<
  typeof hostDaemonEnrollRequestSchema
>;

export const hostDaemonEnrollResponseSchema = z.object({
  hostId: z.string().min(1),
  hostKey: z.string().min(1),
}).strict();
export type HostDaemonEnrollResponse = z.infer<
  typeof hostDaemonEnrollResponseSchema
>;

export const hostDaemonSessionOpenResponseSchema = z.object({
  sessionId: z.string().min(1),
  heartbeatIntervalMs: z.number().int().positive(),
  leaseTimeoutMs: z.number().int().positive(),
  trackedThreadTargets: z.array(hostDaemonTrackedThreadTargetSchema),
  threadHighWaterMarks: z.record(z.string(), z.number().int().nonnegative()),
});
export type HostDaemonSessionOpenResponse = z.infer<
  typeof hostDaemonSessionOpenResponseSchema
>;

export const hostDaemonCommandsQuerySchema = z.object({
  sessionId: z.string().min(1),
  limit: nonNegativeIntegerStringSchema,
  waitMs: nonNegativeIntegerStringSchema,
});
export type HostDaemonCommandsQuery = z.infer<
  typeof hostDaemonCommandsQuerySchema
>;

export const hostDaemonCommandBatchSchema = z.object({
  commands: z.array(hostDaemonCommandEnvelopeSchema),
});
export type HostDaemonCommandBatch = z.infer<typeof hostDaemonCommandBatchSchema>;

export const hostDaemonEventEnvelopeSchema = z.object({
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  event: threadEventSchema,
});
export type HostDaemonEventEnvelope = z.infer<
  typeof hostDaemonEventEnvelopeSchema
>;

export const hostDaemonEventBatchRequestSchema = z.object({
  sessionId: z.string().min(1),
  events: z.array(hostDaemonEventEnvelopeSchema),
});
export type HostDaemonEventBatchRequest = z.infer<
  typeof hostDaemonEventBatchRequestSchema
>;

export const hostDaemonEventBatchResponseSchema = z.object({
  threadHighWaterMarks: z.record(z.string(), z.number().int().nonnegative()),
});
export type HostDaemonEventBatchResponse = z.infer<
  typeof hostDaemonEventBatchResponseSchema
>;

export const hostDaemonEnvironmentChangeSchema = z
  .enum(ENVIRONMENT_CHANGE_KINDS)
  .extract(["work-status-changed", "thread-storage-changed"]);
export type HostDaemonEnvironmentChange = z.infer<
  typeof hostDaemonEnvironmentChangeSchema
>;

export const hostDaemonEnvironmentChangePayloadSchema = z.object({
  environmentId: z.string().min(1),
  change: hostDaemonEnvironmentChangeSchema,
});
export type HostDaemonEnvironmentChangePayload = z.infer<
  typeof hostDaemonEnvironmentChangePayloadSchema
>;

export const hostDaemonEnvironmentChangeRequestSchema = z.object({
  sessionId: z.string().min(1),
  ...hostDaemonEnvironmentChangePayloadSchema.shape,
});
export type HostDaemonEnvironmentChangeRequest = z.infer<
  typeof hostDaemonEnvironmentChangeRequestSchema
>;

export const hostDaemonHeartbeatPayloadSchema = z.object({
  bufferDepth: z.number().int().nonnegative(),
  lastCommandCursor: z.number().int().nonnegative().nullable(),
});
export type HostDaemonHeartbeatPayload = z.infer<
  typeof hostDaemonHeartbeatPayloadSchema
>;
export const hostDaemonServerWsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("commands-available"),
  }),
  z.object({
    type: z.literal("session-close"),
    reason: z.enum(["replaced", "expired", "daemon-disconnect"]),
  }),
]);
export type HostDaemonServerWsMessage = z.infer<
  typeof hostDaemonServerWsMessageSchema
>;

export const hostDaemonDaemonWsMessageSchema = z.object({
  type: z.literal("heartbeat"),
}).strict();
export type HostDaemonDaemonWsMessage = z.infer<
  typeof hostDaemonDaemonWsMessageSchema
>;

export const hostDaemonToolCallRequestSchema = toolCallRequestSchema
  .pick({
    threadId: true,
    providerThreadId: true,
    turnId: true,
    callId: true,
    tool: true,
    arguments: true,
  })
  .extend({
    sessionId: z.string().min(1),
  });
export type HostDaemonToolCallRequest = z.infer<
  typeof hostDaemonToolCallRequestSchema
>;

export const hostDaemonToolCallResponseSchema = toolCallResponseSchema;
export type HostDaemonToolCallResponse = z.infer<
  typeof hostDaemonToolCallResponseSchema
>;

export type HostDaemonInternalSchema = {
  "/hosts/enroll": {
    /** Used by the daemon to exchange bootstrap material for its long-lived host credential. */
    $post: Endpoint<
      { json: HostDaemonEnrollRequest },
      HostDaemonEnrollResponse,
      201
    >;
  };
  "/session/open": {
    /** Used by the daemon to establish a session with the server. Replaces any prior session for the same host. */
    $post: Endpoint<
      { json: HostDaemonSessionOpenRequest },
      HostDaemonSessionOpenResponse,
      201
    >;
  };
  "/session/commands": {
    /** Used by the daemon to fetch pending commands. Supports long-poll via `waitMs`. */
    $get:
      | Endpoint<{ query: HostDaemonCommandsQuery }, HostDaemonCommandBatch, 200>
      | Endpoint<{ query: HostDaemonCommandsQuery }, undefined, 204>;
  };
  "/session/command-result": {
    /** Used by the daemon to report that a command has completed (success or error). */
    $post: Endpoint<
      { json: z.infer<typeof hostDaemonCommandResultReportSchema> },
      { ok: true }
    >;
  };
  "/session/events": {
    /** Used by the daemon to stream provider events (turn progress, completions, errors) back to the server. */
    $post: Endpoint<
      { json: HostDaemonEventBatchRequest },
      HostDaemonEventBatchResponse
    >;
  };
  "/session/environment-change": {
    /** Used by the daemon to report raw environment workspace change hints for server-side validation and fan-out. */
    $post: Endpoint<{ json: HostDaemonEnvironmentChangeRequest }, { ok: true }>;
  };
  "/session/tool-call": {
    /** Used by the daemon to execute server-side tool calls on behalf of a provider (e.g. message_user). */
    $post: Endpoint<
      { json: HostDaemonToolCallRequest },
      HostDaemonToolCallResponse
    >;
  };
};

export type HostDaemonInternalRoutes = Hono<{}, HostDaemonInternalSchema, "/">;

function parseProtocolHeader(protocolHeader: string | undefined): string[] {
  if (!protocolHeader) {
    return [];
  }

  return protocolHeader
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function buildHostDaemonWebSocketAuthorizationHeader(
  hostKey: string,
): string {
  return `Bearer ${hostKey}`;
}

export function buildHostDaemonWebSocketProtocols(): string[] {
  return [HOST_DAEMON_WEBSOCKET_PROTOCOL];
}

export function hasHostDaemonWebSocketProtocol(
  protocolHeader: string | undefined,
): boolean {
  return parseProtocolHeader(protocolHeader).includes(
    HOST_DAEMON_WEBSOCKET_PROTOCOL,
  );
}

export function createHostDaemonClient(baseUrl: string, hostKey: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const internalBaseUrl = normalizedBaseUrl.endsWith("/internal")
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/internal`;
  return hc<HostDaemonInternalRoutes>(internalBaseUrl, {
    headers: {
      authorization: `Bearer ${hostKey}`,
    },
  });
}
