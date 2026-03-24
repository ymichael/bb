import { atom } from "jotai";
import type { SystemConfigResponse } from "@bb/server-contract";
import { apiClient } from "./api-server";
import { fetchHostId } from "./api-host-daemon";

// ---------------------------------------------------------------------------
// System config — fetched once from the server on app startup
// ---------------------------------------------------------------------------

async function loadSystemConfig(): Promise<SystemConfigResponse> {
  try {
    const res = await apiClient.system.config.$get();
    if (!res.ok) {
      return { hostDaemonPort: null };
    }
    return (await res.json()) as SystemConfigResponse;
  } catch {
    return { hostDaemonPort: null };
  }
}

/** System config from the server. Resolves once on first read. */
export const systemConfigAtom = atom<Promise<SystemConfigResponse>>(loadSystemConfig());

// ---------------------------------------------------------------------------
// Local host ID — fetched from the host daemon using the port from config
// ---------------------------------------------------------------------------

/** The local machine's host ID, or null if no daemon is reachable. */
export const localHostIdAtom = atom<Promise<string | null>>(async (get) => {
  const config = await get(systemConfigAtom);
  if (!config.hostDaemonPort) return null;
  return fetchHostId(config.hostDaemonPort);
});

// ---------------------------------------------------------------------------
// Derived: host daemon port (sync access after config resolves)
// ---------------------------------------------------------------------------

/** The host daemon port, or null if not configured. */
export const hostDaemonPortAtom = atom<Promise<number | null>>(async (get) => {
  const config = await get(systemConfigAtom);
  return config.hostDaemonPort;
});
