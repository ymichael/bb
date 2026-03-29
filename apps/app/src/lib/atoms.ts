import { atom, getDefaultStore } from "jotai";
import type { SystemConfigResponse } from "@bb/server-contract";
import { apiClient } from "./api-server";
import { fetchHostId } from "./api-host-daemon";
import { wsManager } from "./ws";

// ---------------------------------------------------------------------------
// System config — fetched once from the server on app startup
// ---------------------------------------------------------------------------

async function loadSystemConfig(): Promise<SystemConfigResponse> {
  try {
    const res = await apiClient.system.config.$get();
    if (!res.ok) {
      return { hostDaemonPort: null, voiceTranscriptionEnabled: false };
    }
    return (await res.json()) as SystemConfigResponse;
  } catch {
    return { hostDaemonPort: null, voiceTranscriptionEnabled: false };
  }
}

/** System config from the server. Resolves once on first read. */
export const systemConfigAtom = atom<Promise<SystemConfigResponse>>(loadSystemConfig());

// ---------------------------------------------------------------------------
// Local host ID — probed from the host daemon on startup.
// Re-probes when a host-connected WS event arrives (daemon may have started
// after the app). No-daemon is a normal state (e.g., mobile browser).
// ---------------------------------------------------------------------------

const localHostIdRefreshAtom = atom(0);

/** The local machine's host ID, or null if no daemon is reachable. */
export const localHostIdAtom = atom<Promise<string | null>>(async (get) => {
  get(localHostIdRefreshAtom);
  const config = await get(systemConfigAtom);
  if (!config.hostDaemonPort) return null;
  return fetchHostId(config.hostDaemonPort);
});

// Re-probe the local daemon when a host connects to the server.
wsManager.onChanged((message) => {
  if (
    message.entity === "host" &&
    message.changes.includes("host-connected")
  ) {
    getDefaultStore().set(localHostIdRefreshAtom, (c) => c + 1);
  }
});

// ---------------------------------------------------------------------------
// Derived: host daemon port (sync access after config resolves)
// ---------------------------------------------------------------------------

/** The host daemon port, or null if not configured. */
export const hostDaemonPortAtom = atom<Promise<number | null>>(async (get) => {
  const config = await get(systemConfigAtom);
  return config.hostDaemonPort;
});
