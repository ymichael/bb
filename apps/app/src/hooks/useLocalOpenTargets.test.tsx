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
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  openInTargetRequestSchema,
  type WorkspaceOpenTarget,
} from "@bb/host-daemon-contract";
import type { HostDaemonStatusSnapshot } from "@/lib/api-host-daemon";
import { WORKSPACE_OPEN_TARGET_STORAGE_KEY } from "@/lib/workspace-open-target-preference";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { resetFakeReconnectingWebSockets } from "@/test/fake-reconnecting-websocket";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toastError } = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock("partysocket/ws", async () => {
  const { FakeReconnectingWebSocket: FakeSocket } =
    await import("@/test/fake-reconnecting-websocket");
  return {
    default: FakeSocket,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
  },
}));

interface LocalOpenTargetsFetchState {
  daemonStatus: HostDaemonStatusSnapshot | null;
  hostDaemonPort: number | null;
  workspaceOpenTargets: WorkspaceOpenTarget[];
  workspaceOpenTargetsStatus: number;
}

interface LocalOpenTargetsSnapshot {
  hasDaemon: boolean;
  preferredTargetLabel: string | null;
  workspaceOpenTargets: WorkspaceOpenTarget[];
}

interface LocalOpenTargetsModules {
  useHostDaemon: typeof import("./useHostDaemon").useHostDaemon;
  useLocalOpenTargets: typeof import("./useLocalOpenTargets").useLocalOpenTargets;
}

interface LocalOpenTargetsProbeProps {
  enabled: boolean;
  onSnapshot: (snapshot: LocalOpenTargetsSnapshot) => void;
}

interface SuspenseWrapperProps {
  children: ReactNode;
}

function createSuspenseWrapper() {
  const { wrapper: baseWrapper } = createQueryClientTestHarness();

  return ({ children }: SuspenseWrapperProps) =>
    baseWrapper({
      children: <Suspense fallback={null}>{children}</Suspense>,
    });
}

function createLocalOpenTargetsProbe(
  useLocalOpenTargets: LocalOpenTargetsModules["useLocalOpenTargets"],
  useHostDaemon: LocalOpenTargetsModules["useHostDaemon"],
) {
  return function LocalOpenTargetsProbe({
    enabled,
    onSnapshot,
  }: LocalOpenTargetsProbeProps) {
    const value = useLocalOpenTargets({ enabled });
    const hostDaemon = useHostDaemon();

    useEffect(() => {
      onSnapshot({
        hasDaemon: hostDaemon.hasDaemon,
        preferredTargetLabel: value.preferredTarget?.label ?? null,
        workspaceOpenTargets: value.workspaceOpenTargets,
      });
    }, [
      hostDaemon.hasDaemon,
      onSnapshot,
      value.preferredTarget?.label,
      value.workspaceOpenTargets,
    ]);

    return (
      <div>
        <div data-testid="preferred-target">
          {value.preferredTarget?.label ?? "none"}
        </div>
        <button
          onClick={() => {
            void value.openPathInPreferredTarget({
              lineNumber: 27,
              path: "/tmp/workspace/file.ts",
            });
          }}
        >
          open preferred
        </button>
        <button
          onClick={() => {
            void value.openPathInTarget({
              lineNumber: null,
              path: "/tmp/workspace/file.ts",
              rememberTarget: true,
              targetId: "finder",
            });
          }}
        >
          open finder
        </button>
      </div>
    );
  };
}

function installLocalOpenTargetsFetchRoutes(
  state: LocalOpenTargetsFetchState,
  openTargetRequests: Array<ReturnType<typeof openInTargetRequestSchema.parse>>,
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
      pathname: "/workspace-open-targets",
      port: 4123,
      handler: async () =>
        state.workspaceOpenTargetsStatus === 200
          ? jsonResponse({ targets: state.workspaceOpenTargets })
          : new Response(null, { status: state.workspaceOpenTargetsStatus }),
    },
    {
      method: "POST",
      pathname: "/open-in-target",
      port: 4123,
      handler: async (request) => {
        openTargetRequests.push(
          openInTargetRequestSchema.parse(await request.json()),
        );
        return jsonResponse({});
      },
    },
  ]);
}

async function importFreshLocalOpenTargetsModules(): Promise<LocalOpenTargetsModules> {
  vi.resetModules();

  const [{ useLocalOpenTargets }, { useHostDaemon }] = await Promise.all([
    import("./useLocalOpenTargets"),
    import("./useHostDaemon"),
  ]);

  return {
    useLocalOpenTargets,
    useHostDaemon,
  };
}

afterEach(() => {
  cleanup();
  resetFakeReconnectingWebSockets();
  toastError.mockReset();
  window.localStorage.clear();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useLocalOpenTargets", () => {
  it("opens in the stored preferred target", async () => {
    window.localStorage.setItem(WORKSPACE_OPEN_TARGET_STORAGE_KEY, "finder");
    const state: LocalOpenTargetsFetchState = {
      daemonStatus: {
        connected: true,
        hostId: "host-1",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: false,
        platform: "darwin",
      },
      hostDaemonPort: 4123,
      workspaceOpenTargets: [
        { id: "vscode", kind: "editor", label: "VS Code" },
        { id: "finder", kind: "file-browser", label: "Finder" },
      ],
      workspaceOpenTargetsStatus: 200,
    };
    const openTargetRequests: Array<
      ReturnType<typeof openInTargetRequestSchema.parse>
    > = [];
    installLocalOpenTargetsFetchRoutes(state, openTargetRequests);
    const latestSnapshot: { current: LocalOpenTargetsSnapshot | null } = {
      current: null,
    };
    const { useHostDaemon, useLocalOpenTargets } =
      await importFreshLocalOpenTargetsModules();
    const LocalOpenTargetsProbe = createLocalOpenTargetsProbe(
      useLocalOpenTargets,
      useHostDaemon,
    );

    await act(async () => {
      render(
        <LocalOpenTargetsProbe
          enabled={true}
          onSnapshot={(snapshot) => {
            latestSnapshot.current = snapshot;
          }}
        />,
        { wrapper: createSuspenseWrapper() },
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("preferred-target").textContent).toBe("Finder");
    });

    fireEvent.click(screen.getByRole("button", { name: "open preferred" }));

    await waitFor(() => {
      expect(openTargetRequests).toEqual([
        {
          lineNumber: 27,
          path: "/tmp/workspace/file.ts",
          targetId: "finder",
        },
      ]);
    });
    expect(latestSnapshot.current?.preferredTargetLabel).toBe("Finder");
  });

  it("stores an explicitly selected target for future opens", async () => {
    const state: LocalOpenTargetsFetchState = {
      daemonStatus: {
        connected: true,
        hostId: "host-1",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: false,
        platform: "darwin",
      },
      hostDaemonPort: 4123,
      workspaceOpenTargets: [
        { id: "vscode", kind: "editor", label: "VS Code" },
        { id: "finder", kind: "file-browser", label: "Finder" },
      ],
      workspaceOpenTargetsStatus: 200,
    };
    const openTargetRequests: Array<
      ReturnType<typeof openInTargetRequestSchema.parse>
    > = [];
    installLocalOpenTargetsFetchRoutes(state, openTargetRequests);
    const { useHostDaemon, useLocalOpenTargets } =
      await importFreshLocalOpenTargetsModules();
    const LocalOpenTargetsProbe = createLocalOpenTargetsProbe(
      useLocalOpenTargets,
      useHostDaemon,
    );

    await act(async () => {
      render(<LocalOpenTargetsProbe enabled={true} onSnapshot={() => {}} />, {
        wrapper: createSuspenseWrapper(),
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "open finder" }));

    await waitFor(() => {
      expect(openTargetRequests).toEqual([
        {
          lineNumber: null,
          path: "/tmp/workspace/file.ts",
          targetId: "finder",
        },
      ]);
    });
    expect(window.localStorage.getItem(WORKSPACE_OPEN_TARGET_STORAGE_KEY)).toBe(
      "finder",
    );
  });

  it("shows a localhost connectivity error when preferred opens are unavailable", async () => {
    const state: LocalOpenTargetsFetchState = {
      daemonStatus: {
        connected: false,
        hostId: "host-1",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: false,
        platform: "darwin",
      },
      hostDaemonPort: 4123,
      workspaceOpenTargets: [],
      workspaceOpenTargetsStatus: 200,
    };
    const openTargetRequests: Array<
      ReturnType<typeof openInTargetRequestSchema.parse>
    > = [];
    installLocalOpenTargetsFetchRoutes(state, openTargetRequests);
    const latestSnapshot: { current: LocalOpenTargetsSnapshot | null } = {
      current: null,
    };
    const { useHostDaemon, useLocalOpenTargets } =
      await importFreshLocalOpenTargetsModules();
    const LocalOpenTargetsProbe = createLocalOpenTargetsProbe(
      useLocalOpenTargets,
      useHostDaemon,
    );

    await act(async () => {
      render(
        <LocalOpenTargetsProbe
          enabled={true}
          onSnapshot={(snapshot) => {
            latestSnapshot.current = snapshot;
          }}
        />,
        { wrapper: createSuspenseWrapper() },
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "open preferred" }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Failed to open file locally", {
        description: "Localhost is disconnected.",
      });
    });
    expect(openTargetRequests).toEqual([]);
  });

  it("shows a no-targets error when localhost is connected but no open targets are available", async () => {
    const state: LocalOpenTargetsFetchState = {
      daemonStatus: {
        connected: true,
        hostId: "host-1",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: false,
        platform: "darwin",
      },
      hostDaemonPort: 4123,
      workspaceOpenTargets: [],
      workspaceOpenTargetsStatus: 200,
    };
    const openTargetRequests: Array<
      ReturnType<typeof openInTargetRequestSchema.parse>
    > = [];
    installLocalOpenTargetsFetchRoutes(state, openTargetRequests);
    const latestSnapshot: { current: LocalOpenTargetsSnapshot | null } = {
      current: null,
    };
    const { useHostDaemon, useLocalOpenTargets } =
      await importFreshLocalOpenTargetsModules();
    const LocalOpenTargetsProbe = createLocalOpenTargetsProbe(
      useLocalOpenTargets,
      useHostDaemon,
    );

    await act(async () => {
      render(
        <LocalOpenTargetsProbe
          enabled={true}
          onSnapshot={(snapshot) => {
            latestSnapshot.current = snapshot;
          }}
        />,
        { wrapper: createSuspenseWrapper() },
      );
    });

    await waitFor(() => {
      expect(latestSnapshot.current?.hasDaemon).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "open preferred" }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Failed to open file locally", {
        description: "No local editor is available.",
      });
    });
    expect(openTargetRequests).toEqual([]);
  });
});
