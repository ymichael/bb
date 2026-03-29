import { createHostDaemonLocalClient } from "@bb/host-daemon-contract";
import { resolveHostDaemonUrl } from "./context-env.js";

let cachedHostId: string | null | undefined;

/**
 * Fetch the local host ID from the host daemon.
 * Returns null if the daemon is unreachable.
 * Caches the result for the lifetime of the process.
 */
export async function fetchLocalHostId(): Promise<string | null> {
  if (cachedHostId !== undefined) return cachedHostId;
  try {
    const client = createHostDaemonLocalClient(resolveHostDaemonUrl());
    const res = await client.status.$get();
    if (!res.ok) {
      cachedHostId = null;
      return null;
    }
    const body = (await res.json()) as { hostId: string };
    cachedHostId = body.hostId;
    return cachedHostId;
  } catch {
    cachedHostId = null;
    return null;
  }
}
