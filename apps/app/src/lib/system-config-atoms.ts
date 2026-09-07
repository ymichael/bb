import { atom } from "jotai";
import { DEFAULTS } from "@bb/config/defaults";
import { defaultAppSettings, defaultAppTheme } from "@bb/domain";
import type { WorkspaceOpenTarget } from "@bb/host-daemon-contract";
import type { HostDaemonStatusSnapshot } from "./api-host-daemon";
import type { SystemConfigResponse } from "@bb/server-contract";
import { systemConfigQueryOptions } from "@/hooks/queries/system-queries";
import { markSystemConfigStale } from "@/hooks/cache-owners/system-config-cache-owner";
import { appQueryClient } from "./app-query-client";
import { fetchHostStatus, fetchWorkspaceOpenTargets } from "./api-host-daemon";
import { getBbDesktopInfo } from "./bb-desktop";
import {
  getBrowserLocalNetworkPermissionQuery,
  resolveLocalHostDaemonAccess,
  resolveLocalHostDaemonProbePorts,
  type LocalHostDaemonAccessState,
} from "./local-host-daemon-access";
import { wsManager } from "./ws";

const unavailableSystemConfig: SystemConfigResponse = {
  generalSettings: defaultAppSettings,
  keybindings: [],
  defaultKeybindings: [],
  keybindingOverrides: [],
  experiments: {
    changelogPreview: false,
    editMessages: false,
    mobileApp: false,
    sidebarProgressiveDisclosure: false,
    timelineWindowing: false,
  },
  appearance: defaultAppTheme,
  customThemes: [],
  pluginThemes: [],
  featureFlags: { placeholder: false, timelineWindowEventBudget: 1_500 },
  hostDaemonPort: null,
  localHelperPorts: [],
  serverUrl: "",
  primaryHostId: null,
  primaryHostPlatform: null,
  voiceTranscriptionEnabled: false,
  aiServices: {
    inference: DEFAULTS.inferenceModel,
    inferenceFallback: DEFAULTS.inferenceFallbackModel,
    transcription: DEFAULTS.transcriptionModel,
    services: [],
  },
  dataDir: "",
};

type SystemConfigLoadStatus = "failed" | "succeeded" | null;
type Milliseconds = number;

interface LocalHostDaemonConnection {
  port: number;
  status: HostDaemonStatusSnapshot;
}

interface FetchLocalHostConnectionWithRetryArgs {
  browserOrigin: string | null;
  ports: readonly number[];
  retryDelaysMs: readonly Milliseconds[];
}

const LOCAL_HOST_STATUS_RETRY_DELAYS_MS: readonly Milliseconds[] = [
  1_000, 1_000,
];

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
    const config = await appQueryClient.fetchQuery(systemConfigQueryOptions());
    markSystemConfigLoadSucceeded();
    return config;
  } catch {
    markSystemConfigLoadFailed();
    return unavailableSystemConfig;
  }
}

function sleep(milliseconds: Milliseconds): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parseOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function selectPreferredLocalHostConnection(
  connections: readonly LocalHostDaemonConnection[],
  browserOrigin: string | null,
): LocalHostDaemonConnection | null {
  if (browserOrigin !== null) {
    const currentServerConnection = connections.find(
      ({ status }) => parseOrigin(status.serverUrl) === browserOrigin,
    );
    if (currentServerConnection !== undefined) {
      return currentServerConnection;
    }
  }
  return connections[0] ?? null;
}

async function fetchLocalHostConnection(
  ports: readonly number[],
  browserOrigin: string | null,
): Promise<LocalHostDaemonConnection | null> {
  const results = await Promise.all(
    ports.map(async (port): Promise<LocalHostDaemonConnection | null> => {
      const status = await fetchHostStatus(port);
      return status === null ? null : { port, status };
    }),
  );
  const connections = results.filter(
    (connection): connection is LocalHostDaemonConnection =>
      connection !== null,
  );
  return selectPreferredLocalHostConnection(connections, browserOrigin);
}

async function fetchLocalHostConnectionWithRetry({
  browserOrigin,
  ports,
  retryDelaysMs,
}: FetchLocalHostConnectionWithRetryArgs): Promise<LocalHostDaemonConnection | null> {
  const firstConnection = await fetchLocalHostConnection(ports, browserOrigin);
  if (firstConnection !== null) {
    return firstConnection;
  }

  for (const delayMs of retryDelaysMs) {
    await sleep(delayMs);
    const connection = await fetchLocalHostConnection(ports, browserOrigin);
    if (connection !== null) {
      return connection;
    }
  }

  return null;
}

const systemConfigRefreshTickAtom = atom(0);
systemConfigRefreshTickAtom.onMount = (setRefreshTick) => {
  const queryKey = systemConfigQueryOptions().queryKey;
  let observedConfig =
    appQueryClient.getQueryData<SystemConfigResponse>(queryKey);
  const invalidateSystemConfig = () => {
    markSystemConfigStale(appQueryClient);
  };
  const unsubscribeConnected = wsManager.onConnected(({ reconnected }) => {
    if (!reconnected && !didLastSystemConfigLoadFail()) {
      return;
    }
    invalidateSystemConfig();
    setRefreshTick((count) => count + 1);
  });
  const unsubscribeChanged = wsManager.onChanged((message) => {
    if (
      message.entity === "host" ||
      (message.entity === "system" &&
        message.changes.includes("config-changed"))
    ) {
      if (message.entity === "host") {
        invalidateSystemConfig();
      }
      setRefreshTick((count) => count + 1);
    }
  });
  const unsubscribeConfig = appQueryClient
    .getQueryCache()
    .subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "success" &&
        event.query.queryKey[0] === queryKey[0]
      ) {
        const nextConfig =
          appQueryClient.getQueryData<SystemConfigResponse>(queryKey);
        if (observedConfig === undefined) {
          observedConfig = nextConfig;
          return;
        }
        if (nextConfig === observedConfig) {
          return;
        }
        observedConfig = nextConfig;
        setRefreshTick((count) => count + 1);
      }
    });
  return () => {
    unsubscribeConnected();
    unsubscribeChanged();
    unsubscribeConfig();
  };
};

const systemConfigAtom = atom(async (get) => {
  get(systemConfigRefreshTickAtom);
  return loadSystemConfig();
});

const localHostStatusRefreshTickAtom = atom(0);

const localHostDaemonAccessRefreshTickAtom = atom(0);
const localHostDaemonSessionAccessGrantedAtom = atom(false);

export const localHostDaemonAccessStateAtom = atom<
  Promise<LocalHostDaemonAccessState>
>(async (get) => {
  get(localHostDaemonAccessRefreshTickAtom);
  const sessionAccessGranted = get(localHostDaemonSessionAccessGrantedAtom);
  const config = await get(systemConfigAtom);
  return resolveLocalHostDaemonAccess({
    configuredPorts: config.localHelperPorts,
    hostname: typeof window === "undefined" ? null : window.location.hostname,
    isDesktop: getBbDesktopInfo() !== null,
    permissions: getBrowserLocalNetworkPermissionQuery(),
    sessionAccessGranted,
  });
});

export const requestLocalHostDaemonAccessAtom = atom(
  null,
  async (get, set): Promise<boolean> => {
    const config = await get(systemConfigAtom);
    if (config.localHelperPorts.length === 0) {
      return false;
    }

    const connection = await fetchLocalHostConnection(
      config.localHelperPorts,
      typeof window === "undefined" ? null : window.location.origin,
    );
    if (connection !== null) {
      set(localHostDaemonSessionAccessGrantedAtom, true);
    }
    set(localHostDaemonAccessRefreshTickAtom, (count) => count + 1);
    set(localHostStatusRefreshTickAtom, (count) => count + 1);
    return connection !== null;
  },
);

const localHostConnectionAtom = atom<Promise<LocalHostDaemonConnection | null>>(
  async (get) => {
    get(localHostStatusRefreshTickAtom);
    const ports = await get(localHostDaemonProbePortsAtom);
    if (ports.length === 0) return null;
    return fetchLocalHostConnectionWithRetry({
      browserOrigin:
        typeof window === "undefined" ? null : window.location.origin,
      ports,
      retryDelaysMs: LOCAL_HOST_STATUS_RETRY_DELAYS_MS,
    });
  },
);

export const localHostStatusAtom = atom<
  Promise<HostDaemonStatusSnapshot | null>
>(async (get) => (await get(localHostConnectionAtom))?.status ?? null);

export const localHostDaemonReachableAtom = atom<Promise<boolean>>(
  async (get) => {
    const localHostStatus = await get(localHostStatusAtom);
    return localHostStatus !== null;
  },
);

export const localHostDaemonHostIdAtom = atom<Promise<string | null>>(
  async (get) => {
    const localHostStatus = await get(localHostStatusAtom);
    return localHostStatus?.hostId ?? null;
  },
);

export const localHostIdAtom = atom<Promise<string | null>>(async (get) => {
  const localHostStatus = await get(localHostStatusAtom);
  if (!localHostStatus?.connected) {
    return null;
  }
  return localHostStatus.hostId;
});

export const localWorkspaceOpenTargetsAtom = atom<
  Promise<WorkspaceOpenTarget[]>
>(async (get) => {
  const connection = await get(localHostConnectionAtom);
  if (connection === null) {
    return [];
  }

  return fetchWorkspaceOpenTargets(connection.port);
});

const localHostDaemonProbePortsAtom = atom<Promise<readonly number[]>>(
  async (get) => {
    const config = await get(systemConfigAtom);
    const accessState = await get(localHostDaemonAccessStateAtom);
    return resolveLocalHostDaemonProbePorts(
      config.localHelperPorts,
      accessState,
    );
  },
);

export const hostDaemonPortAtom = atom<Promise<number | null>>(async (get) => {
  return (await get(localHostConnectionAtom))?.port ?? null;
});
