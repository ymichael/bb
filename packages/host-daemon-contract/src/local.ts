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

export const workspaceOpenTargetIdValues = [
  "vscode",
  "cursor",
  "sublime-text",
  "zed",
  "windsurf",
  "antigravity",
  "finder",
  "terminal",
  "iterm2",
  "ghostty",
  "xcode",
] as const;
export const workspaceOpenTargetIdSchema = z.enum(workspaceOpenTargetIdValues);
export type WorkspaceOpenTargetId = z.infer<typeof workspaceOpenTargetIdSchema>;

export const workspaceOpenTargetKindValues = [
  "editor",
  "file-browser",
  "terminal",
] as const;
export const workspaceOpenTargetKindSchema = z.enum(
  workspaceOpenTargetKindValues,
);
export type WorkspaceOpenTargetKind = z.infer<
  typeof workspaceOpenTargetKindSchema
>;

export const workspaceOpenTargetSchema = z.object({
  id: workspaceOpenTargetIdSchema,
  kind: workspaceOpenTargetKindSchema,
  label: z.string().min(1),
});
export type WorkspaceOpenTarget = z.infer<typeof workspaceOpenTargetSchema>;

export const workspaceOpenTargetsResponseSchema = z.object({
  targets: z.array(workspaceOpenTargetSchema),
});
export type WorkspaceOpenTargetsResponse = z.infer<
  typeof workspaceOpenTargetsResponseSchema
>;

const openTargetPathSchema = z.string().min(1);
const openTargetLineNumberSchema = z.number().int().positive().nullable();

export const openInTargetRequestSchema = z.object({
  lineNumber: openTargetLineNumberSchema,
  path: openTargetPathSchema,
  targetId: workspaceOpenTargetIdSchema,
});
export type OpenInTargetRequest = z.infer<typeof openInTargetRequestSchema>;

export const pickFolderResponseSchema = z.object({
  path: z.string().nullable(),
});
export type PickFolderResponse = z.infer<typeof pickFolderResponseSchema>;

export const PATHS_EXIST_MAX_PATHS = 200;

export const pathsExistRequestSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(PATHS_EXIST_MAX_PATHS)
    .transform((paths) => Array.from(new Set(paths))),
});
export type PathsExistRequest = z.infer<typeof pathsExistRequestSchema>;

export const pathsExistResponseSchema = z.object({
  existence: z.record(z.string(), z.boolean()),
});
export type PathsExistResponse = z.infer<typeof pathsExistResponseSchema>;

export const hostPlatformSchema = z.enum(["darwin", "linux", "wsl", "unknown"]);
export type HostPlatform = z.infer<typeof hostPlatformSchema>;

export const statusResponseSchema = z.object({
  hostId: z.string().min(1),
  connected: z.boolean(),
  // Informational local-daemon protocol marker. Dev restart tooling uses it
  // to detect stale host-daemons; product UI must not gate behavior on it.
  protocolVersion: z.number().int().positive(),
  serverUrl: z.string(),
  supportsNativeFolderPicker: z.boolean(),
  platform: hostPlatformSchema,
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
  "/workspace-open-targets": {
    $get: Endpoint<EmptyInput, WorkspaceOpenTargetsResponse>;
  };
  "/open-in-target": {
    $post: Endpoint<{ json: OpenInTargetRequest }, Record<string, never>>;
  };
  "/pick-folder": {
    $post: Endpoint<EmptyInput, PickFolderResponse>;
  };
  "/paths/exist": {
    $post: Endpoint<{ json: PathsExistRequest }, PathsExistResponse>;
  };
  "/status": {
    $get: Endpoint<EmptyInput, StatusResponse>;
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
