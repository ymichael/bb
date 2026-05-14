// @vitest-environment jsdom

import { createStore } from "jotai";
import { cleanup, waitFor } from "@testing-library/react";
import { defaultFeatureFlags, type FeatureFlags } from "@bb/domain";
import { resetFakeReconnectingWebSockets } from "@/test/fake-reconnecting-websocket";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("partysocket/ws", async () => {
  const { FakeReconnectingWebSocket: FakeSocket } =
    await import("@/test/fake-reconnecting-websocket");
  return {
    default: FakeSocket,
  };
});

interface SuccessfulSystemConfigRoute {
  featureFlags?: FeatureFlags;
  hostDaemonPort: number | null;
  voiceTranscriptionEnabled: boolean;
}

interface FailedSystemConfigRoute {
  status: number;
}

type SystemConfigRoute = FailedSystemConfigRoute | SuccessfulSystemConfigRoute;

interface SystemConfigRouteState {
  configs: SystemConfigRoute[];
  daemonStatuses: Array<{
    connected: boolean;
    hostId: string;
    serverUrl: string;
    supportsNativeFolderPicker: boolean;
    platform: "darwin" | "linux" | "wsl";
  } | null>;
}

interface AtomModules {
  FakeReconnectingWebSocket: typeof import("@/test/fake-reconnecting-websocket").FakeReconnectingWebSocket;
  localHostIdAtom: typeof import("./system-config-atoms").localHostIdAtom;
  systemConfigAtom: typeof import("./system-config-atoms").systemConfigAtom;
  wsManager: typeof import("./ws").wsManager;
}

function installAtomFetchRoutes(state: SystemConfigRouteState) {
  installFetchRoutes([
    {
      pathname: "/api/v1/system/config",
      handler: async () => {
        const nextConfig = state.configs.shift();
        if (!nextConfig) {
          throw new Error("Unexpected system config fetch");
        }

        if ("status" in nextConfig) {
          return jsonResponse(
            { error: "system config unavailable" },
            { status: nextConfig.status },
          );
        }

        return jsonResponse({
          featureFlags: nextConfig.featureFlags ?? defaultFeatureFlags,
          githubConnected: false,
          hostDaemonPort: nextConfig.hostDaemonPort,
          sandboxHostSupported: false,
          voiceTranscriptionEnabled: nextConfig.voiceTranscriptionEnabled,
        });
      },
    },
    {
      pathname: "/status",
      port: 4123,
      handler: async () => {
        const nextStatus = state.daemonStatuses.shift();
        if (nextStatus == null) {
          return new Response(null, { status: 503 });
        }

        return jsonResponse(nextStatus);
      },
    },
  ]);
}

async function importFreshAtomModules(): Promise<AtomModules> {
  vi.resetModules();

  const [
    { localHostIdAtom, systemConfigAtom },
    { wsManager },
    { FakeReconnectingWebSocket },
  ] = await Promise.all([
    import("./system-config-atoms"),
    import("./ws"),
    import("@/test/fake-reconnecting-websocket"),
  ]);

  return {
    FakeReconnectingWebSocket,
    localHostIdAtom,
    systemConfigAtom,
    wsManager,
  };
}

afterEach(() => {
  cleanup();
  resetFakeReconnectingWebSockets();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("atoms", () => {
  it("does not re-fetch config after the websocket first connects when the initial load succeeds", async () => {
    installAtomFetchRoutes({
      configs: [
        {
          hostDaemonPort: null,
          voiceTranscriptionEnabled: false,
        },
      ],
      daemonStatuses: [],
    });

    const { FakeReconnectingWebSocket, systemConfigAtom, wsManager } =
      await importFreshAtomModules();
    const store = createStore();
    const unsubscribe = store.sub(systemConfigAtom, () => {});

    try {
      expect(await store.get(systemConfigAtom)).toMatchObject({
        hostDaemonPort: null,
      });

      wsManager.connect();
      const socket = FakeReconnectingWebSocket.latest();
      socket.open();

      await waitFor(() => {
        expect(FakeReconnectingWebSocket.latest().readyState).toBe(
          WebSocket.OPEN,
        );
      });
      expect(await store.get(systemConfigAtom)).toMatchObject({
        hostDaemonPort: null,
      });

      wsManager.disconnect();
    } finally {
      unsubscribe();
    }
  });

  it("re-fetches config after the websocket first connects when the initial load fails", async () => {
    installAtomFetchRoutes({
      configs: [
        {
          status: 503,
        },
        {
          hostDaemonPort: 4123,
          voiceTranscriptionEnabled: true,
        },
      ],
      daemonStatuses: [],
    });

    const { FakeReconnectingWebSocket, systemConfigAtom, wsManager } =
      await importFreshAtomModules();
    const store = createStore();
    const unsubscribe = store.sub(systemConfigAtom, () => {});

    try {
      expect(await store.get(systemConfigAtom)).toMatchObject({
        hostDaemonPort: null,
        voiceTranscriptionEnabled: false,
      });

      wsManager.connect();
      const socket = FakeReconnectingWebSocket.latest();
      socket.open();

      await waitFor(async () => {
        expect(await store.get(systemConfigAtom)).toMatchObject({
          hostDaemonPort: 4123,
          voiceTranscriptionEnabled: true,
        });
      });

      wsManager.disconnect();
    } finally {
      unsubscribe();
    }
  });

  it("re-fetches config after the websocket reconnects", async () => {
    installAtomFetchRoutes({
      configs: [
        {
          hostDaemonPort: null,
          voiceTranscriptionEnabled: false,
        },
        {
          hostDaemonPort: 4123,
          voiceTranscriptionEnabled: true,
        },
      ],
      daemonStatuses: [],
    });

    const { FakeReconnectingWebSocket, systemConfigAtom, wsManager } =
      await importFreshAtomModules();
    const store = createStore();
    const unsubscribe = store.sub(systemConfigAtom, () => {});

    try {
      expect(await store.get(systemConfigAtom)).toMatchObject({
        hostDaemonPort: null,
        voiceTranscriptionEnabled: false,
      });

      wsManager.connect();
      const socket = FakeReconnectingWebSocket.latest();
      socket.open();

      socket.close();
      socket.open();

      await waitFor(async () => {
        expect(await store.get(systemConfigAtom)).toMatchObject({
          hostDaemonPort: 4123,
          voiceTranscriptionEnabled: true,
        });
      });

      wsManager.disconnect();
    } finally {
      unsubscribe();
    }
  });

  it("re-probes local host status when the websocket reports a host change", async () => {
    installAtomFetchRoutes({
      configs: [
        {
          hostDaemonPort: 4123,
          voiceTranscriptionEnabled: false,
        },
      ],
      daemonStatuses: [
        {
          connected: true,
          hostId: "host-1",
          serverUrl: "http://localhost:3334",
          supportsNativeFolderPicker: true,
          platform: "darwin",
        },
        null,
      ],
    });

    const { FakeReconnectingWebSocket, localHostIdAtom, wsManager } =
      await importFreshAtomModules();
    const store = createStore();
    const unsubscribe = store.sub(localHostIdAtom, () => {});

    try {
      expect(await store.get(localHostIdAtom)).toBe("host-1");

      wsManager.connect();
      const socket = FakeReconnectingWebSocket.latest();
      socket.open();
      socket.emitJson({
        changes: ["host-disconnected"],
        entity: "host",
        type: "changed",
      });

      await waitFor(async () => {
        expect(await store.get(localHostIdAtom)).toBeNull();
      });

      wsManager.disconnect();
    } finally {
      unsubscribe();
    }
  });

  it("does not re-probe local host status after the websocket first connects", async () => {
    installAtomFetchRoutes({
      configs: [
        {
          hostDaemonPort: 4123,
          voiceTranscriptionEnabled: false,
        },
      ],
      daemonStatuses: [
        null,
      ],
    });

    const { FakeReconnectingWebSocket, localHostIdAtom, wsManager } =
      await importFreshAtomModules();
    const store = createStore();
    const unsubscribe = store.sub(localHostIdAtom, () => {});

    try {
      expect(await store.get(localHostIdAtom)).toBeNull();

      wsManager.connect();
      const socket = FakeReconnectingWebSocket.latest();
      socket.open();

      await waitFor(() => {
        expect(socket.readyState).toBe(WebSocket.OPEN);
      });
      expect(await store.get(localHostIdAtom)).toBeNull();

      wsManager.disconnect();
    } finally {
      unsubscribe();
    }
  });

  it("re-probes local host status after the websocket reconnects", async () => {
    installAtomFetchRoutes({
      configs: [
        {
          hostDaemonPort: 4123,
          voiceTranscriptionEnabled: false,
        },
        {
          hostDaemonPort: 4123,
          voiceTranscriptionEnabled: false,
        },
      ],
      daemonStatuses: [
        null,
        {
          connected: true,
          hostId: "host-2",
          serverUrl: "http://localhost:3334",
          supportsNativeFolderPicker: true,
          platform: "darwin",
        },
        {
          connected: true,
          hostId: "host-2",
          serverUrl: "http://localhost:3334",
          supportsNativeFolderPicker: true,
          platform: "darwin",
        },
      ],
    });

    const { FakeReconnectingWebSocket, localHostIdAtom, wsManager } =
      await importFreshAtomModules();
    const store = createStore();
    const unsubscribe = store.sub(localHostIdAtom, () => {});

    try {
      expect(await store.get(localHostIdAtom)).toBeNull();

      wsManager.connect();
      const socket = FakeReconnectingWebSocket.latest();
      socket.open();

      expect(await store.get(localHostIdAtom)).toBeNull();

      socket.close();
      socket.open();

      await waitFor(async () => {
        expect(await store.get(localHostIdAtom)).toBe("host-2");
      });

      wsManager.disconnect();
    } finally {
      unsubscribe();
    }
  });
});
