import type { Hono } from "hono";
import { hc } from "hono/client";
import { z } from "zod";
import type { EmptyInput, Endpoint } from "./common.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH = "/health";
export const DEFAULT_HOST_DAEMON_LOCAL_HEALTH_VALUE = "ok";
export const DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_BIND_HOST = "127.0.0.1";
export const DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_HEALTH_VALUE =
  "bb-host-daemon";
export const DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_PORT = 9111;

export const openRequestSchema = z.object({
  path: z.string().min(1),
});
export type OpenRequest = z.infer<typeof openRequestSchema>;

export const restartRequestSchema = z.object({
  force: z.boolean().optional(),
});
export type RestartRequest = z.infer<typeof restartRequestSchema>;

export const pickFolderResponseSchema = z.object({
  path: z.string().nullable(),
});
export type PickFolderResponse = z.infer<typeof pickFolderResponseSchema>;

export const statusResponseSchema = z.object({
  hostId: z.string().min(1),
  connected: z.boolean(),
  serverUrl: z.string(),
  supportsNativeFolderPicker: z.boolean(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

export const healthResponseSchema = z.string().min(1);
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ---------------------------------------------------------------------------
// Route type definition for Hono typed client
// ---------------------------------------------------------------------------

export type HostDaemonLocalSchema = {
  [DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH]: {
    $get: Endpoint<EmptyInput, HealthResponse>;
  };
  "/open-path": {
    $post: Endpoint<{ json: OpenRequest }, Record<string, never>>;
  };
  "/pick-folder": {
    $post: Endpoint<EmptyInput, PickFolderResponse>;
  };
  "/status": {
    $get: Endpoint<EmptyInput, StatusResponse>;
  };
  "/restart": {
    $post:
      | Endpoint<{ json: RestartRequest }, Record<string, never>, 200>
      | Endpoint<{ json: RestartRequest }, { message: string }, 409>;
  };
};

export type HostDaemonLocalRoutes = Hono<{}, HostDaemonLocalSchema, "/">;

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a typed Hono client for the daemon's local API.
 *
 * No auth — the local API is bound to 127.0.0.1 only.
 */
export function createHostDaemonLocalClient(baseUrl: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  return hc<HostDaemonLocalRoutes>(normalizedBaseUrl);
}
