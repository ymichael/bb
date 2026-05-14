// @vitest-environment jsdom

import { Suspense, useEffect, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import type { HostDaemonStatusSnapshot } from "@/lib/api-host-daemon";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
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

interface HostDaemonFetchState {
  daemonStatus: HostDaemonStatusSnapshot | null;
  hostDaemonPort: number | null;
  pickedFolderPath: string | null;
}

interface HostDaemonSnapshot {
  hasDaemon: boolean;
  isLocalHost: (hostId: string | null | undefined) => boolean;
  localHostId: string | null;
  pickFolder: (() => Promise<string | null>) | null;
  supportsNativeFolderPicker: boolean;
  platform: "darwin" | "linux" | "wsl" | "unknown" | null;
}

interface HostDaemonModules {
  FakeReconnectingWebSocket: typeof import("@/test/fake-reconnecting-websocket").FakeReconnectingWebSocket;
  useHostDaemon: () => HostDaemonSnapshot;
  wsManager: {
    connect(): void;
    disconnect(): void;
  };
}

interface SuspenseWrapperProps {
  children: ReactNode;
}

interface HostDaemonProbeProps {
  onSnapshot: (snapshot: HostDaemonSnapshot) => void;
}

function createSuspenseWrapper() {
  const { wrapper: baseWrapper } = createQueryClientTestHarness();

  return ({ children }: SuspenseWrapperProps) =>
    baseWrapper({
      children: <Suspense fallback={null}>{children}</Suspense>,
    });
}

function createHostDaemonProbe(
  useHostDaemon: HostDaemonModules["useHostDaemon"],
) {
  return function HostDaemonProbe({ onSnapshot }: HostDaemonProbeProps) {
    const value = useHostDaemon();

    useEffect(() => {
      onSnapshot(value);
    }, [onSnapshot, value]);

    return (
      <div>
        <div data-testid="local-host-id">{value.localHostId ?? "null"}</div>
        <div data-testid="has-daemon">{String(value.hasDaemon)}</div>
        <div data-testid="supports-folder-picker">
          {String(value.supportsNativeFolderPicker)}
        </div>
        <div data-testid="is-local-host-1">
          {String(value.isLocalHost("host-1"))}
        </div>
        <div data-testid="is-local-host-2">
          {String(value.isLocalHost("host-2"))}
        </div>
        <button
          disabled={value.pickFolder == null}
          onClick={() => {
            void value.pickFolder?.();
          }}
        >
          pick folder
        </button>
      </div>
    );
  };
}

function installHostDaemonFetchRoutes(
  state: HostDaemonFetchState,
  pickFolderRequests: number[],
) {
  installFetchRoutes([
    {
      pathname: "/api/v1/system/config",
      handler: async () =>
        jsonResponse({
          githubConnected: false,
          hostDaemonPort: state.hostDaemonPort,
          sandboxHostSupported: false,
          voiceTranscriptionEnabled: false,
        }),
    },
    {
      pathname: "/status",
      port: 4123,
      handler: async () =>
        state.daemonStatus
          ? jsonResponse(state.daemonStatus)
          : new Response(null, { status: 503 }),
    },
    {
      method: "POST",
      pathname: "/pick-folder",
      port: 4123,
      handler: async () => {
        pickFolderRequests.push(1);
        return jsonResponse({
          path: state.pickedFolderPath,
        });
      },
    },
  ]);
}

async function importFreshHostDaemonModules(): Promise<HostDaemonModules> {
  vi.resetModules();

  const [{ useHostDaemon }, { wsManager }, { FakeReconnectingWebSocket }] =
    await Promise.all([
      import("./useHostDaemon"),
      import("@/lib/ws"),
      import("@/test/fake-reconnecting-websocket"),
    ]);

  return {
    FakeReconnectingWebSocket,
    useHostDaemon,
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

describe("useHostDaemon", () => {
  it("exposes local daemon state and bound daemon actions when available", async () => {
    const state: HostDaemonFetchState = {
      daemonStatus: {
        connected: true,
        hostId: "host-1",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: true,
        platform: "darwin",
      },
      hostDaemonPort: 4123,
      pickedFolderPath: "/picked/path",
    };
    const pickFolderRequests: number[] = [];
    installHostDaemonFetchRoutes(state, pickFolderRequests);

    const latestSnapshot: { current: HostDaemonSnapshot | null } = {
      current: null,
    };
    const { useHostDaemon } = await importFreshHostDaemonModules();
    const HostDaemonProbe = createHostDaemonProbe(useHostDaemon);

    await act(async () => {
      render(
        <HostDaemonProbe
          onSnapshot={(snapshot) => {
            latestSnapshot.current = snapshot;
          }}
        />,
        {
          wrapper: createSuspenseWrapper(),
        },
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("local-host-id").textContent).toBe("host-1");
    });

    expect(screen.getByTestId("has-daemon").textContent).toBe("true");
    expect(screen.getByTestId("supports-folder-picker").textContent).toBe(
      "true",
    );
    expect(screen.getByTestId("is-local-host-1").textContent).toBe("true");
    expect(screen.getByTestId("is-local-host-2").textContent).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "pick folder" }));

    await waitFor(() => {
      expect(pickFolderRequests).toEqual([1]);
    });
  });

  it("returns null actions when the daemon or local host id is unavailable", async () => {
    const state: HostDaemonFetchState = {
      daemonStatus: null,
      hostDaemonPort: null,
      pickedFolderPath: null,
    };
    installHostDaemonFetchRoutes(state, []);

    const latestSnapshot: { current: HostDaemonSnapshot | null } = {
      current: null,
    };
    const { useHostDaemon } = await importFreshHostDaemonModules();
    const HostDaemonProbe = createHostDaemonProbe(useHostDaemon);

    await act(async () => {
      render(
        <HostDaemonProbe
          onSnapshot={(snapshot) => {
            latestSnapshot.current = snapshot;
          }}
        />,
        {
          wrapper: createSuspenseWrapper(),
        },
      );
    });

    expect((await screen.findByTestId("local-host-id")).textContent).toBe(
      "null",
    );
    expect(screen.getByTestId("has-daemon").textContent).toBe("false");
    expect(screen.getByTestId("supports-folder-picker").textContent).toBe(
      "false",
    );
    expect(screen.getByTestId("is-local-host-1").textContent).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "pick folder" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(latestSnapshot.current?.pickFolder).toBeNull();
  });

  it("re-probes daemon capabilities after websocket reconnects", async () => {
    const state: HostDaemonFetchState = {
      daemonStatus: {
        connected: true,
        hostId: "host-1",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: false,
        platform: "linux",
      },
      hostDaemonPort: 4123,
      pickedFolderPath: null,
    };
    installHostDaemonFetchRoutes(state, []);

    const { FakeReconnectingWebSocket, useHostDaemon, wsManager } =
      await importFreshHostDaemonModules();
    const HostDaemonProbe = createHostDaemonProbe(useHostDaemon);

    await act(async () => {
      render(<HostDaemonProbe onSnapshot={() => {}} />, {
        wrapper: createSuspenseWrapper(),
      });
    });

    expect(
      (await screen.findByTestId("supports-folder-picker")).textContent,
    ).toBe("false");

    wsManager.connect();
    const socket = FakeReconnectingWebSocket.latest();
    socket.open();
    socket.close();
    state.daemonStatus = {
      connected: true,
      hostId: "host-1",
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      serverUrl: "http://localhost:3334",
      supportsNativeFolderPicker: true,
      platform: "linux",
    };
    socket.open();

    await waitFor(() => {
      expect(screen.getByTestId("supports-folder-picker").textContent).toBe(
        "true",
      );
    });

    wsManager.disconnect();
  });
});
