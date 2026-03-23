import type { Hono } from "hono";
import { hc } from "hono/client";
import type {
  HostDaemonCommandBatch,
  HostDaemonCommandResultReport,
  HostDaemonEventBatchRequest,
  HostDaemonEventBatchResponse,
  HostDaemonHeartbeatRequest,
  HostDaemonHeartbeatResponse,
  HostDaemonSessionOpenRequest,
  HostDaemonSessionOpenResponse,
} from "@bb/host-daemon-contract";
import type {
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type { EmptyInput, Endpoint } from "./common.js";

type InternalSessionCommandsQuery = {
  sessionId: string;
  afterCursor?: string;
  limit?: string;
  waitMs?: string;
};

export type InternalApiSchema = {
  "/session/open": {
    $post: Endpoint<
      { json: HostDaemonSessionOpenRequest },
      HostDaemonSessionOpenResponse,
      201
    >;
  };
  "/session/heartbeat": {
    $post: Endpoint<
      { json: HostDaemonHeartbeatRequest },
      HostDaemonHeartbeatResponse
    >;
  };
  "/session/commands": {
    $get:
      | Endpoint<{ query: InternalSessionCommandsQuery }, HostDaemonCommandBatch, 200>
      | Endpoint<{ query: InternalSessionCommandsQuery }, undefined, 204>;
  };
  "/session/command-result": {
    $post: Endpoint<{ json: HostDaemonCommandResultReport }, { ok: true }>;
  };
  "/session/events": {
    $post: Endpoint<
      { json: HostDaemonEventBatchRequest },
      HostDaemonEventBatchResponse
    >;
  };
  "/session/tool-call": {
    $post: Endpoint<{ json: ToolCallRequest }, ToolCallResponse>;
  };
  "/session/close": {
    $post: Endpoint<{ json: { sessionId: string } }, { ok: true }>;
  };
  "/session/status": {
    $get: Endpoint<EmptyInput, { ok: true }>;
  };
};

export type InternalApiRoutes = Hono<{}, InternalApiSchema, "/">;

export function createInternalApiClient(baseUrl: string, authToken: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const internalBaseUrl = normalizedBaseUrl.endsWith("/internal")
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/internal`;

  return hc<InternalApiRoutes>(internalBaseUrl, {
    headers: { authorization: `Bearer ${authToken}` },
  });
}
