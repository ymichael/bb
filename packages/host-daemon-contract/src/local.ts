import type { Hono } from "hono";
import { hc } from "hono/client";
import { z } from "zod";
import type { EmptyInput, Endpoint } from "./common.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const openRequestSchema = z.object({
  path: z.string().min(1),
});
export type OpenRequest = z.infer<typeof openRequestSchema>;

export const pickFolderResponseSchema = z.object({
  path: z.string().nullable(),
});
export type PickFolderResponse = z.infer<typeof pickFolderResponseSchema>;

export const statusResponseSchema = z.object({
  hostId: z.string().min(1),
  connected: z.boolean(),
  serverUrl: z.string(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

// ---------------------------------------------------------------------------
// Route type definition for Hono typed client
// ---------------------------------------------------------------------------

export type HostDaemonLocalSchema = {
  "/open": {
    $post: Endpoint<{ json: OpenRequest }, Record<string, never>>;
  };
  "/pick-folder": {
    $post: Endpoint<EmptyInput, PickFolderResponse>;
  };
  "/status": {
    $get: Endpoint<EmptyInput, StatusResponse>;
  };
  "/restart": {
    $post: Endpoint<EmptyInput, Record<string, never>>;
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
