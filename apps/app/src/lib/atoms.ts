import { atom } from "jotai";
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
      return {
        githubConnected: false,
        hostDaemonPort: null,
        sandboxHostSupported: false,
        voiceTranscriptionEnabled: false,
      };
    }
    return (await res.json()) as SystemConfigResponse;
  } catch {
    return {
      githubConnected: false,
      hostDaemonPort: null,
      sandboxHostSupported: false,
      voiceTranscriptionEnabled: false,
    };
  }
}

/** System config from the server. Resolves once on first read. */
export const systemConfigAtom = atom(async () => loadSystemConfig());

// ---------------------------------------------------------------------------
// Local host ID — probed from the host daemon on startup.
// Re-probes on host status changes and websocket reconnects while some UI is
// subscribed to it. No-daemon is a normal state (e.g., mobile browser).
// ---------------------------------------------------------------------------

const localHostIdRefreshTickAtom = atom(0);
localHostIdRefreshTickAtom.onMount = (setRefreshTick) => {
  const refresh = () => {
    setRefreshTick((count) => count + 1);
  };

  const unsubscribeChanged = wsManager.onChanged((message) => {
    if (message.entity === "host") {
      refresh();
    }
  });
  const unsubscribeConnected = wsManager.onConnected(({ reconnected }) => {
    if (reconnected) {
      refresh();
    }
  });

  return () => {
    unsubscribeChanged();
    unsubscribeConnected();
  };
};

/** The local machine's host ID, or null if no daemon is reachable. */
export const localHostIdAtom = atom<Promise<string | null>>(async (get) => {
  get(localHostIdRefreshTickAtom);
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
