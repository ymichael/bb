import { atom } from "jotai";
import type { HostDaemonStatusSnapshot } from "./api-host-daemon";
import type { SystemConfigResponse } from "@bb/server-contract";
import { apiClient } from "./api-server";
import { fetchHostStatus } from "./api-host-daemon";
import { wsManager } from "./ws";

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

// ---------------------------------------------------------------------------
// System config — fetched from the server on startup and re-fetched on
// websocket reconnects (the initial load may fail if the server isn't ready).
// ---------------------------------------------------------------------------

const systemConfigRefreshTickAtom = atom(0);
systemConfigRefreshTickAtom.onMount = (setRefreshTick) => {
  const unsubscribe = wsManager.onConnected(({ reconnected }) => {
    if (reconnected) {
      setRefreshTick((count) => count + 1);
    }
  });
  return unsubscribe;
};

export const systemConfigAtom = atom(async (get) => {
  get(systemConfigRefreshTickAtom);
  return loadSystemConfig();
});

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
export const localHostStatusAtom = atom<Promise<HostDaemonStatusSnapshot | null>>(async (get) => {
  get(localHostIdRefreshTickAtom);
  const config = await get(systemConfigAtom);
  if (!config.hostDaemonPort) return null;
  return fetchHostStatus(config.hostDaemonPort);
});

/** The local machine's host ID, or null if no daemon is reachable. */
export const localHostIdAtom = atom<Promise<string | null>>(async (get) => {
  const localHostStatus = await get(localHostStatusAtom);
  if (!localHostStatus?.connected) {
    return null;
  }
  return localHostStatus.hostId;
});

// ---------------------------------------------------------------------------
// Derived: host daemon port (sync access after config resolves)
// ---------------------------------------------------------------------------

/** The host daemon port, or null if not configured. */
export const hostDaemonPortAtom = atom<Promise<number | null>>(async (get) => {
  const config = await get(systemConfigAtom);
  return config.hostDaemonPort;
});

/** Whether the server has a GitHub PAT configured. */
export const githubConnectedAtom = atom<Promise<boolean>>(async (get) => {
  const config = await get(systemConfigAtom);
  return config.githubConnected;
});

/** Whether the server supports sandbox host provisioning. */
export const sandboxHostSupportedAtom = atom<Promise<boolean>>(async (get) => {
  const config = await get(systemConfigAtom);
  return config.sandboxHostSupported;
});
