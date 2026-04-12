import {
  createHostDaemonLocalClient,
  type StatusResponse,
} from "@bb/host-daemon-contract";

let client: ReturnType<typeof createHostDaemonLocalClient> | null = null;
let clientPort: number | null = null;

export interface HostDaemonStatusSnapshot extends StatusResponse {}

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
