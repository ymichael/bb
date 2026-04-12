import {
  createHostDaemonLocalClient,
  workspaceOpenTargetsResponseSchema,
  type OpenWorkspaceRequest,
  type StatusResponse,
  type WorkspaceOpenTarget,
} from "@bb/host-daemon-contract";
import { z } from "zod";

let client: ReturnType<typeof createHostDaemonLocalClient> | null = null;
let clientPort: number | null = null;

export interface HostDaemonStatusSnapshot extends StatusResponse {}

const hostDaemonErrorResponseSchema = z.object({
  message: z.string().min(1),
});

/**
 * Get or create the host daemon client.
 * Recreates the client if the port changes.
 */
export function getHostDaemonClient(port: number) {
  if (!client || clientPort !== port) {
    client = createHostDaemonLocalClient(`http://localhost:${port}`);
    clientPort = port;
  }
  return client;
}

/**
 * Fetch the local host ID from the daemon.
 * Returns null if the daemon is unreachable.
 */
export async function fetchHostStatus(
  port: number,
): Promise<HostDaemonStatusSnapshot | null> {
  try {
    const daemon = getHostDaemonClient(port);
    const res = await daemon.status.$get();
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchHostId(port: number): Promise<string | null> {
  const status = await fetchHostStatus(port);
  if (!status?.connected) {
    return null;
  }
  return status.hostId;
}

/**
 * Open a path in the user's default editor via the host daemon.
 */
export async function openPath(port: number, path: string): Promise<void> {
  const daemon = getHostDaemonClient(port);
  await daemon["open-path"].$post({ json: { path } });
}

export async function fetchWorkspaceOpenTargets(
  port: number,
): Promise<WorkspaceOpenTarget[]> {
  const daemon = getHostDaemonClient(port);
  const res = await daemon["workspace-open-targets"].$get();
  const status = Number(res.status);
  if (status === 404) {
    return [];
  }
  if (!res.ok) {
    throw new Error(`Workspace open target discovery failed: HTTP ${status}`);
  }
  const body = workspaceOpenTargetsResponseSchema.parse(await res.json());
  return body.targets;
}

export async function openWorkspace(
  port: number,
  request: OpenWorkspaceRequest,
): Promise<void> {
  const daemon = getHostDaemonClient(port);
  const res = await daemon["open-workspace"].$post({ json: request });
  if (!res.ok) {
    const status = Number(res.status);
    throw new Error(
      await readHostDaemonErrorMessage(
        res,
        `Failed to open workspace: HTTP ${status}`,
      ),
    );
  }
}

async function readHostDaemonErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const text = await response.text().catch(() => "");
  const trimmedText = text.trim();
  if (trimmedText === "") {
    return fallbackMessage;
  }

  try {
    const parsed = hostDaemonErrorResponseSchema.safeParse(JSON.parse(trimmedText));
    if (parsed.success) {
      return parsed.data.message;
    }
  } catch {
    return trimmedText;
  }

  return trimmedText;
}

/**
 * Open a native folder picker dialog via the host daemon.
 * Returns the selected path, or null if cancelled.
 * Returns null if the daemon rejects the request (e.g. the host has no
 * native picker support).
 */
export async function pickFolder(port: number): Promise<string | null> {
  const daemon = getHostDaemonClient(port);
  const res = await daemon["pick-folder"].$post({});
  if (!res.ok) return null;
  const body = await res.json();
  return body.path;
}

/**
 * Probe the daemon for the existence of each path. Throws if the daemon is
 * unreachable or returns an error so React Query callers can surface
 * `isError` instead of silently treating "unknown" as "exists".
 */
export async function checkPathsExist(
  port: number,
  paths: string[],
): Promise<Record<string, boolean>> {
  if (paths.length === 0) return {};
  const daemon = getHostDaemonClient(port);
  const res = await daemon.paths.exist.$post({ json: { paths } });
  if (!res.ok) {
    throw new Error(`Path existence check failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  return body.existence;
}
