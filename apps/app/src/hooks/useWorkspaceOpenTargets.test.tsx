// @vitest-environment jsdom

import { Suspense, useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  openWorkspaceRequestSchema,
  type OpenWorkspaceRequest,
  type WorkspaceOpenTarget,
} from "@bb/host-daemon-contract";
import type { HostDaemonStatusSnapshot } from "@/lib/api-host-daemon";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { resetFakeReconnectingWebSockets } from "@/test/fake-reconnecting-websocket";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("partysocket/ws", async () => {
  const { FakeReconnectingWebSocket: FakeSocket } = await import("@/test/fake-reconnecting-websocket");
  return {
    default: FakeSocket,
  };
});

interface WorkspaceOpenTargetFetchState {
  daemonStatus: HostDaemonStatusSnapshot | null;
  hostDaemonPort: number | null;
  workspaceOpenTargets: WorkspaceOpenTarget[];
  workspaceOpenTargetsStatus: number;
}

interface WorkspaceOpenTargetsSnapshot {
  openWorkspace: ((request: OpenWorkspaceRequest) => Promise<void>) | null;
  workspaceOpenTargets: WorkspaceOpenTarget[];
}

interface WorkspaceOpenTargetsModules {
  FakeReconnectingWebSocket: typeof import("@/test/fake-reconnecting-websocket").FakeReconnectingWebSocket;
  useWorkspaceOpenTargets: typeof import("./useWorkspaceOpenTargets").useWorkspaceOpenTargets;
  wsManager: {
    connect(): void;
    disconnect(): void;
  };
}

interface SuspenseWrapperProps {
  children: ReactNode;
}

interface WorkspaceOpenTargetsProbeProps {
  enabled: boolean;
  onSnapshot: (snapshot: WorkspaceOpenTargetsSnapshot) => void;
}

function createSuspenseWrapper() {
  const { wrapper: baseWrapper } = createQueryClientTestHarness();

  return ({ children }: SuspenseWrapperProps) =>
    baseWrapper({
      children: (
        <Suspense fallback={null}>
          {children}
        </Suspense>
      ),
    });
}

function createWorkspaceOpenTargetsProbe(
  useWorkspaceOpenTargets: WorkspaceOpenTargetsModules["useWorkspaceOpenTargets"],
) {
  return function WorkspaceOpenTargetsProbe({
    enabled,
    onSnapshot,
  }: WorkspaceOpenTargetsProbeProps) {
    const value = useWorkspaceOpenTargets({ enabled });

    useEffect(() => {
      onSnapshot(value);
    }, [onSnapshot, value]);

    return (
      <div>
        <div data-testid="workspace-open-targets">{String(value.workspaceOpenTargets.length)}</div>
        <button
          disabled={value.openWorkspace == null}
          onClick={() => {
            void value.openWorkspace?.({
              path: "/tmp/workspace",
              targetId: "vscode",
            });
          }}
        >
          open workspace
        </button>
      </div>
    );
  };
}

function installWorkspaceOpenTargetFetchRoutes(
  state: WorkspaceOpenTargetFetchState,
  openWorkspaceRequests: OpenWorkspaceRequest[] = [],
) {
  installFetchRoutes([
    {
      pathname: "/api/v1/system/config",
      handler: async () => jsonResponse({
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
      pathname: "/open-workspace",
      port: 4123,
      handler: async (request) => {
        openWorkspaceRequests.push(openWorkspaceRequestSchema.parse(await request.json()));
        return jsonResponse({});
      },
    },
  ]);
}

async function importFreshWorkspaceOpenTargetsModules(): Promise<WorkspaceOpenTargetsModules> {
  vi.resetModules();

  const [{ useWorkspaceOpenTargets }, { wsManager }, { FakeReconnectingWebSocket }] =
    await Promise.all([
      import("./useWorkspaceOpenTargets"),
      import("@/lib/ws"),
      import("@/test/fake-reconnecting-websocket"),
    ]);

  return {
    FakeReconnectingWebSocket,
    useWorkspaceOpenTargets,
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

describe("useWorkspaceOpenTargets", () => {
  it("does not probe the daemon when disabled", async () => {
    installFetchRoutes([]);
    const latestSnapshot: { current: WorkspaceOpenTargetsSnapshot | null } = { current: null };
    const { useWorkspaceOpenTargets } = await importFreshWorkspaceOpenTargetsModules();
    const WorkspaceOpenTargetsProbe = createWorkspaceOpenTargetsProbe(useWorkspaceOpenTargets);

    await act(async () => {
      render(
        <WorkspaceOpenTargetsProbe
          enabled={false}
          onSnapshot={(snapshot) => { latestSnapshot.current = snapshot; }}
        />,
        { wrapper: createSuspenseWrapper() },
      );
    });

    expect(screen.getByTestId("workspace-open-targets").textContent).toBe("0");
    expect(screen.getByRole("button", { name: "open workspace" }).hasAttribute("disabled")).toBe(true);
    expect(latestSnapshot.current?.workspaceOpenTargets).toEqual([]);
    expect(latestSnapshot.current?.openWorkspace).toBeNull();
  });

  it("lists workspace open targets and opens a workspace when enabled", async () => {
    const state: WorkspaceOpenTargetFetchState = {
      daemonStatus: {
        connected: true,
        hostId: "host-1",
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: false,
        platform: "darwin",
      },
      hostDaemonPort: 4123,
      workspaceOpenTargets: [
        {
          id: "vscode",
          label: "VS Code",
        },
      ],
      workspaceOpenTargetsStatus: 200,
    };
    const openWorkspaceRequests: OpenWorkspaceRequest[] = [];
    installWorkspaceOpenTargetFetchRoutes(state, openWorkspaceRequests);

    const { useWorkspaceOpenTargets } = await importFreshWorkspaceOpenTargetsModules();
    const WorkspaceOpenTargetsProbe = createWorkspaceOpenTargetsProbe(useWorkspaceOpenTargets);

    await act(async () => {
      render(
        <WorkspaceOpenTargetsProbe enabled={true} onSnapshot={() => {}} />,
        { wrapper: createSuspenseWrapper() },
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("workspace-open-targets").textContent).toBe("1");
    });

    fireEvent.click(screen.getByRole("button", { name: "open workspace" }));

    await waitFor(() => {
      expect(openWorkspaceRequests).toEqual([
        {
          path: "/tmp/workspace",
          targetId: "vscode",
        },
      ]);
    });
  });

  it("treats missing workspace open target routes as unsupported", async () => {
    const state: WorkspaceOpenTargetFetchState = {
      daemonStatus: {
        connected: true,
        hostId: "host-1",
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: false,
        platform: "linux",
      },
      hostDaemonPort: 4123,
      workspaceOpenTargets: [],
      workspaceOpenTargetsStatus: 404,
    };
    installWorkspaceOpenTargetFetchRoutes(state);

    const latestSnapshot: { current: WorkspaceOpenTargetsSnapshot | null } = { current: null };
    const { useWorkspaceOpenTargets } = await importFreshWorkspaceOpenTargetsModules();
    const WorkspaceOpenTargetsProbe = createWorkspaceOpenTargetsProbe(useWorkspaceOpenTargets);

    await act(async () => {
      render(
        <WorkspaceOpenTargetsProbe
          enabled={true}
          onSnapshot={(snapshot) => { latestSnapshot.current = snapshot; }}
        />,
        { wrapper: createSuspenseWrapper() },
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("workspace-open-targets").textContent).toBe("0");
    });
    expect(screen.getByRole("button", { name: "open workspace" }).hasAttribute("disabled")).toBe(true);
    expect(latestSnapshot.current?.workspaceOpenTargets).toEqual([]);
    expect(latestSnapshot.current?.openWorkspace).toBeNull();
  });

  it("re-probes targets after websocket reconnects", async () => {
    const state: WorkspaceOpenTargetFetchState = {
      daemonStatus: {
        connected: true,
        hostId: "host-1",
        serverUrl: "http://localhost:3334",
        supportsNativeFolderPicker: false,
        platform: "darwin",
      },
      hostDaemonPort: 4123,
      workspaceOpenTargets: [],
      workspaceOpenTargetsStatus: 200,
    };
    installWorkspaceOpenTargetFetchRoutes(state);

    const { FakeReconnectingWebSocket, useWorkspaceOpenTargets, wsManager } =
      await importFreshWorkspaceOpenTargetsModules();
    const WorkspaceOpenTargetsProbe = createWorkspaceOpenTargetsProbe(useWorkspaceOpenTargets);

    await act(async () => {
      render(
        <WorkspaceOpenTargetsProbe enabled={true} onSnapshot={() => {}} />,
        { wrapper: createSuspenseWrapper() },
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("workspace-open-targets").textContent).toBe("0");
    });

    wsManager.connect();
    const socket = FakeReconnectingWebSocket.latest();
    socket.open();
    socket.close();
    state.workspaceOpenTargets = [
      {
        id: "vscode",
        label: "VS Code",
      },
    ];
    socket.open();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-open-targets").textContent).toBe("1");
    });

    wsManager.disconnect();
  });
});
