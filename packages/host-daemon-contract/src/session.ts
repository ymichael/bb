import type { Hono } from "hono";
import { hc } from "hono/client";
import {
  toolCallRequestSchema,
  toolCallResponseSchema,
} from "@bb/domain";
import { z } from "zod";
import type { EmptyInput, Endpoint } from "./common.js";
import {
  hostDaemonCommandBatchSchema,
  hostDaemonCommandResultReportSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonEventBatchResponseSchema,
  hostDaemonHeartbeatRequestSchema,
  hostDaemonHeartbeatResponseSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonSessionOpenResponseSchema,
} from "./commands.js";

export const hostDaemonCommandsQuerySchema = z.object({
  sessionId: z.string().min(1),
  afterCursor: z.string().optional(),
  limit: z.string().optional(),
  waitMs: z.string().optional(),
});
export type HostDaemonCommandsQuery = z.infer<
  typeof hostDaemonCommandsQuerySchema
>;

export type HostDaemonInternalSchema = {
  "/session/open": {
    $post: Endpoint<
      { json: z.infer<typeof hostDaemonSessionOpenRequestSchema> },
      z.infer<typeof hostDaemonSessionOpenResponseSchema>,
      201
    >;
  };
  "/session/heartbeat": {
    $post: Endpoint<
      { json: z.infer<typeof hostDaemonHeartbeatRequestSchema> },
      z.infer<typeof hostDaemonHeartbeatResponseSchema>
    >;
  };
  "/session/commands": {
    $get:
      | Endpoint<{ query: HostDaemonCommandsQuery }, z.infer<typeof hostDaemonCommandBatchSchema>, 200>
      | Endpoint<{ query: HostDaemonCommandsQuery }, undefined, 204>;
  };
  "/session/command-result": {
    $post: Endpoint<
      { json: z.infer<typeof hostDaemonCommandResultReportSchema> },
      { ok: true }
    >;
  };
  "/session/events": {
    $post: Endpoint<
      { json: z.infer<typeof hostDaemonEventBatchRequestSchema> },
      z.infer<typeof hostDaemonEventBatchResponseSchema>
    >;
  };
  "/session/tool-call": {
    $post: Endpoint<
      { json: z.infer<typeof toolCallRequestSchema> },
      z.infer<typeof toolCallResponseSchema>
    >;
  };
  "/session/close": {
    $post: Endpoint<{ json: { sessionId: string } }, { ok: true }>;
  };
  "/session/status": {
    $get: Endpoint<EmptyInput, { ok: true }>;
  };
};

export type HostDaemonInternalRoutes = Hono<{}, HostDaemonInternalSchema, "/">;

export function createHostDaemonClient(baseUrl: string, authToken: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const internalBaseUrl = normalizedBaseUrl.endsWith("/internal")
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/internal`;

  return hc<HostDaemonInternalRoutes>(internalBaseUrl, {
    headers: { authorization: `Bearer ${authToken}` },
  });
}
