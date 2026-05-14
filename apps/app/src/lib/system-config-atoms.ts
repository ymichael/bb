import { atom, useAtomValue } from "jotai";
import type { WorkspaceOpenTarget } from "@bb/host-daemon-contract";
import type { FeatureFlags } from "@bb/domain";
import type { HostDaemonStatusSnapshot } from "./api-host-daemon";
import type { SystemConfigResponse } from "@bb/server-contract";
import { apiClient } from "./api-server";
import { fetchHostStatus, fetchWorkspaceOpenTargets } from "./api-host-daemon";
import {
  resolvePreferredWorkspaceOpenTarget,
  workspaceOpenTargetPreferenceAtom,
} from "./workspace-open-target-preference";
import { wsManager } from "./ws";

// Offline/unavailable app behavior should fail closed independently of server defaults.
const unavailableFeatureFlags: FeatureFlags = {
  askUserQuestion: false,
};

const unavailableSystemConfig: SystemConfigResponse = {
  featureFlags: unavailableFeatureFlags,
  githubConnected: false,
  hostDaemonPort: null,
  sandboxHostSupported: false,
  voiceTranscriptionEnabled: false,
};

type SystemConfigLoadStatus = "failed" | "succeeded" | null;

let lastSystemConfigLoadStatus: SystemConfigLoadStatus = null;

function markSystemConfigLoadFailed(): void {
  lastSystemConfigLoadStatus = "failed";
}

function markSystemConfigLoadSucceeded(): void {
  lastSystemConfigLoadStatus = "succeeded";
}

function didLastSystemConfigLoadFail(): boolean {
  return lastSystemConfigLoadStatus === "failed";
}

async function loadSystemConfig(): Promise<SystemConfigResponse> {
  try {
    const res = await apiClient.system.config.$get();
    if (!res.ok) {
      markSystemConfigLoadFailed();
      return unavailableSystemConfig;
    }
    markSystemConfigLoadSucceeded();
    return (await res.json()) as SystemConfigResponse;
  } catch {
    markSystemConfigLoadFailed();
    return unavailableSystemConfig;
  }
}

// ---------------------------------------------------------------------------
// System config — fetched from the server on startup and re-fetched on
// reconnects. The first websocket connection only refreshes when the initial
// load failed, so a healthy startup doesn't immediately duplicate the request.
// ---------------------------------------------------------------------------

const systemConfigRefreshTickAtom = atom(0);
systemConfigRefreshTickAtom.onMount = (setRefreshTick) => {
  const unsubscribe = wsManager.onConnected(({ reconnected }) => {
    if (!reconnected && !didLastSystemConfigLoadFail()) {
      return;
    }
    setRefreshTick((count) => count + 1);
  });
  return unsubscribe;
};

export const systemConfigAtom = atom(async (get) => {
  get(systemConfigRefreshTickAtom);
  return loadSystemConfig();
});

// ---------------------------------------------------------------------------
// Local host ID — probed from the host daemon on startup. Re-probes on host
// status changes while some UI is subscribed to it. Server connection events
// refresh systemConfigAtom, which in turn refreshes this atom. No-daemon is a
// normal state (e.g., mobile browser).
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

  return unsubscribeChanged;
};

/** The local machine's host ID, or null if no daemon is reachable. */
export const localHostStatusAtom = atom<
  Promise<HostDaemonStatusSnapshot | null>
>(async (get) => {
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

/** Workspace open targets available through the local host daemon. */
export const localWorkspaceOpenTargetsAtom = atom<
  Promise<WorkspaceOpenTarget[]>
>(async (get) => {
  const localHostStatus = await get(localHostStatusAtom);
  if (!localHostStatus?.connected) {
    return [];
  }

  const config = await get(systemConfigAtom);
  if (!config.hostDaemonPort) {
    return [];
  }

  return fetchWorkspaceOpenTargets(config.hostDaemonPort);
});

/**
 * The active preferred open target: the user's stored preference if it's
 * currently installed, otherwise the first editor-kind target, otherwise the
 * first available target. Single source of truth for "which app does the BB
 * UI default to opening files in." Use `useLocalOpenTargets` instead when you
 * need the gated, hook-scoped variant.
 */
export const preferredWorkspaceOpenTargetAtom = atom<
  Promise<WorkspaceOpenTarget | null>
>(async (get) =>
  resolvePreferredWorkspaceOpenTarget({
    preferredTargetId: get(workspaceOpenTargetPreferenceAtom),
    targets: await get(localWorkspaceOpenTargetsAtom),
  }),
);

export function usePreferredWorkspaceOpenTarget() {
  return useAtomValue(preferredWorkspaceOpenTargetAtom);
}

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
