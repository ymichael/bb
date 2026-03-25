import type { Hono } from "hono";
import { hc } from "hono/client";
import {
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

export const hostDaemonActiveThreadSchema = z.object({
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
  providerThreadId: z.string().min(1).optional(),
});
export type HostDaemonActiveThread = z.infer<typeof hostDaemonActiveThreadSchema>;

export const hostDaemonSessionOpenRequestSchema = z.object({
  hostId: z.string().min(1),
  instanceId: z.string().min(1),
  hostName: z.string().min(1),
  hostType: hostTypeSchema,
  protocolVersion: z.literal(HOST_DAEMON_PROTOCOL_VERSION),
  activeThreads: z.array(hostDaemonActiveThreadSchema).optional(),
});
export type HostDaemonSessionOpenRequest = z.infer<
  typeof hostDaemonSessionOpenRequestSchema
>;

export const hostDaemonSessionOpenResponseSchema = z.object({
  sessionId: z.string().min(1),
  heartbeatIntervalMs: z.number().int().positive(),
  leaseTimeoutMs: z.number().int().positive(),
  threadHighWaterMarks: z.record(z.string(), z.number().int().nonnegative()),
});
export type HostDaemonSessionOpenResponse = z.infer<
  typeof hostDaemonSessionOpenResponseSchema
>;

export const hostDaemonCommandsQuerySchema = z.object({
  sessionId: z.string().min(1),
  afterCursor: z.string().optional(),
  limit: z.string().optional(),
  waitMs: z.string().optional(),
});
export type HostDaemonCommandsQuery = z.infer<
  typeof hostDaemonCommandsQuerySchema
>;

export const hostDaemonCommandBatchSchema = z.object({
  commands: z.array(hostDaemonCommandEnvelopeSchema),
});
export type HostDaemonCommandBatch = z.infer<typeof hostDaemonCommandBatchSchema>;

export const hostDaemonEventEnvelopeSchema = z.object({
  id: z.string().min(1),
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

export const hostDaemonHeartbeatPayloadSchema = z.object({
  bufferDepth: z.number().int().nonnegative(),
  lastCommandCursor: z.number().int().nonnegative().optional(),
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
  bufferDepth: z.number().int().nonnegative(),
  lastCommandCursor: z.number().int().nonnegative().optional(),
});
export type HostDaemonDaemonWsMessage = z.infer<
  typeof hostDaemonDaemonWsMessageSchema
>;

export const hostDaemonToolCallRequestSchema = toolCallRequestSchema.and(
  z.object({
    sessionId: z.string().min(1),
  }),
);
export type HostDaemonToolCallRequest = z.infer<
  typeof hostDaemonToolCallRequestSchema
>;

export const hostDaemonToolCallResponseSchema = toolCallResponseSchema;
export type HostDaemonToolCallResponse = z.infer<
  typeof hostDaemonToolCallResponseSchema
>;

export type HostDaemonInternalSchema = {
  "/session/open": {
    /**
     * Daemon opens a session with the server.
     * Server upserts the host record, creates a new session, and closes any existing session
     * for the same hostId (sends `session-close` with reason "replaced" over the old WS).
     * Runs reconciliation: compares the daemon's reported `activeThreads` against DB state.
     * Returns sessionId, heartbeat config (intervalMs, leaseTimeoutMs), and
     * threadHighWaterMarks for event deduplication.
     */
    $post: Endpoint<
      { json: HostDaemonSessionOpenRequest },
      HostDaemonSessionOpenResponse,
      201
    >;
  };
  "/session/commands": {
    /**
     * Daemon polls for pending commands.
     * Long-poll: if no commands are available and `waitMs > 0`, the server holds the request
     * open up to `waitMs` milliseconds waiting for a commands-available notification.
     * Returns 204 if the timeout expires with no commands. Supports cursor-based pagination
     * via `afterCursor` and `limit`.
     */
    $get:
      | Endpoint<{ query: HostDaemonCommandsQuery }, HostDaemonCommandBatch, 200>
      | Endpoint<{ query: HostDaemonCommandsQuery }, undefined, 204>;
  };
  "/session/command-result": {
    /**
     * Daemon reports command completion.
     * Handles provisioning results: success transitions environment to ready, failure
     * transitions environment+thread to error state. On provision success with pending
     * thread input, queues `thread.start` as a follow-up command.
     * Updates the server-side cursor (contiguous advancement only).
     * Side effects: fires WS notifications to connected clients.
     */
    $post: Endpoint<
      { json: z.infer<typeof hostDaemonCommandResultReportSchema> },
      { ok: true }
    >;
  };
  "/session/events": {
    /**
     * Daemon posts a batch of thread events.
     * Server deduplicates events by (threadId, sequence) -- re-posting an already-stored
     * sequence is silently ignored. Returns threadHighWaterMarks for acknowledgment.
     * Side effects: `turn/completed` events transition the thread to idle; if the thread
     * is a child of a manager, notifies the parent thread.
     */
    $post: Endpoint<
      { json: HostDaemonEventBatchRequest },
      HostDaemonEventBatchResponse
    >;
  };
  "/session/tool-call": {
    /**
     * Daemon proxies a tool call to the server for execution.
     * Currently only `spawn_thread` is supported -- creates a child thread that reuses
     * the parent's environment. The server executes the tool call and returns the result.
     */
    $post: Endpoint<
      { json: HostDaemonToolCallRequest },
      HostDaemonToolCallResponse
    >;
  };
};

export type HostDaemonInternalRoutes = Hono<{}, HostDaemonInternalSchema, "/">;

export function createHostDaemonClient(baseUrl: string, authToken: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const internalBaseUrl = normalizedBaseUrl.endsWith("/internal")
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/internal`;
  return hc<HostDaemonInternalRoutes>(internalBaseUrl, {
    headers: {
      authorization: `Bearer ${authToken}`,
    },
  });
}
