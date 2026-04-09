// @vitest-environment jsdom

import { getDefaultStore } from "jotai";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  changedCallbacks,
  connectedCallbacks,
  fetchHostStatus,
  getSystemConfig,
} = vi.hoisted(() => {
  interface ConnectedEvent {
    reconnected: boolean;
  }

  interface HostChangedMessage {
    changes: string[];
    entity: "host";
    type: "changed";
  }

  type ConnectedCallback = (event: ConnectedEvent) => void;
  type ChangedCallback = (message: HostChangedMessage) => void;

  const changedCallbacks: ChangedCallback[] = [];
  const connectedCallbacks: ConnectedCallback[] = [];

  return {
    changedCallbacks,
    connectedCallbacks,
    fetchHostStatus: vi.fn(),
    getSystemConfig: vi.fn(),
  };
});

vi.mock("@/lib/api-server", () => ({
  apiClient: {
    system: {
      config: {
        $get: getSystemConfig,
      },
    },
  },
}));

vi.mock("@/lib/api-host-daemon", () => ({
  fetchHostStatus,
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    onChanged(callback: (message: { changes: string[]; entity: "host"; type: "changed" }) => void) {
      changedCallbacks.push(callback);
      return () => {
        const index = changedCallbacks.indexOf(callback);
        if (index >= 0) {
          changedCallbacks.splice(index, 1);
        }
      };
    },
    onConnected(callback: (event: { reconnected: boolean }) => void) {
      connectedCallbacks.push(callback);
      return () => {
        const index = connectedCallbacks.indexOf(callback);
        if (index >= 0) {
          connectedCallbacks.splice(index, 1);
        }
      };
    },
  },
}));

afterEach(() => {
  cleanup();
  changedCallbacks.length = 0;
  connectedCallbacks.length = 0;
  vi.clearAllMocks();
  vi.resetModules();
});

function mockSystemConfig(): void {
  getSystemConfig.mockResolvedValue({
    json: async () => ({
      hostDaemonPort: 4123,
      voiceTranscriptionEnabled: false,
    }),
    ok: true,
  });
}

describe("systemConfigAtom", () => {
  it("re-fetches config after websocket reconnects", async () => {
    // First call: server unavailable, returns fallback with no daemon port
    getSystemConfig.mockResolvedValueOnce({
      json: async () => ({
        hostDaemonPort: null,
        voiceTranscriptionEnabled: false,
      }),
      ok: true,
    });
    // Second call: server recovered, returns real config
    getSystemConfig.mockResolvedValueOnce({
      json: async () => ({
        hostDaemonPort: 4123,
        voiceTranscriptionEnabled: false,
      }),
      ok: true,
    });

    const { systemConfigAtom } = await import("./atoms");
    const store = getDefaultStore();
    const unsubscribe = store.sub(systemConfigAtom, () => {});

    try {
      expect(await store.get(systemConfigAtom)).toMatchObject({
        hostDaemonPort: null,
      });

      for (const cb of connectedCallbacks) {
        cb({ reconnected: true });
      }

      expect(await store.get(systemConfigAtom)).toMatchObject({
        hostDaemonPort: 4123,
      });
      expect(getSystemConfig).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });
});

describe("localHostIdAtom", () => {
  it("re-probes when host status changes", async () => {
    mockSystemConfig();
    fetchHostStatus
      .mockResolvedValueOnce({
        hostId: "host-1",
        connected: true,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: true,
      })
      .mockResolvedValueOnce(null);

    const { localHostIdAtom } = await import("./atoms");
    const store = getDefaultStore();
    const unsubscribe = store.sub(localHostIdAtom, () => {});

    try {
      expect(await store.get(localHostIdAtom)).toBe("host-1");

      changedCallbacks[0]?.({
        changes: ["host-disconnected"],
        entity: "host",
        type: "changed",
      });

      expect(await store.get(localHostIdAtom)).toBeNull();
      expect(fetchHostStatus).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("re-probes after websocket reconnects", async () => {
    mockSystemConfig();
    fetchHostStatus
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        hostId: "host-1",
        connected: true,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: true,
      });

    const { localHostIdAtom } = await import("./atoms");
    const store = getDefaultStore();
    const unsubscribe = store.sub(localHostIdAtom, () => {});

    try {
      expect(await store.get(localHostIdAtom)).toBeNull();

      for (const cb of connectedCallbacks) {
        cb({ reconnected: true });
      }

      expect(await store.get(localHostIdAtom)).toBe("host-1");
    } finally {
      unsubscribe();
    }
  });
});
