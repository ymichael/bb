// @vitest-environment jsdom

import { Suspense, useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Host } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostsQueryKey } from "@/hooks/queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useHostDaemon } from "./useHostDaemon";

const {
  fetchHostStatus,
  getSystemConfig,
  openPath,
  pickFolder,
} = vi.hoisted(() => ({
  fetchHostStatus: vi.fn(),
  getSystemConfig: vi.fn(),
  openPath: vi.fn(),
  pickFolder: vi.fn(),
}));

vi.mock("@/lib/api-server", () => ({
  apiClient: {
    system: {
      config: {
        $get: getSystemConfig,
      },
    },
  },
  toRelativeUrl: (url: URL) => `${url.pathname}${url.search}`,
}));

vi.mock("@/lib/api-host-daemon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-host-daemon")>();

  return {
    ...actual,
    fetchHostStatus,
    openPath,
    pickFolder,
  };
});

interface HostOverrides extends Partial<Host> {}

interface HostDaemonWrapperOptions {
  daemonPort: number | null;
  hosts?: Host[];
  localHostId: string | null;
  supportsNativeFolderPicker?: boolean;
}

interface HostDaemonSnapshot {
  localHostId: string | null;
  localHost: Host | null;
  hasConnectedPersistentHost: boolean;
  hasDaemon: boolean;
  supportsNativeFolderPicker: boolean;
  isLocalHost: (hostId: string | null | undefined) => boolean;
  openPath: ((path: string) => Promise<void>) | null;
  pickFolder: (() => Promise<string | null>) | null;
}

function makeHost(overrides: HostOverrides = {}): Host {
  return {
    createdAt: 1,
    id: "host-1",
    lastSeenAt: 1,
    name: "Local Host",
    status: "connected",
    type: "persistent",
    updatedAt: 1,
    ...overrides,
  };
}

function createHostDaemonWrapper({
  daemonPort,
  hosts = [],
  localHostId,
  supportsNativeFolderPicker = localHostId != null,
}: HostDaemonWrapperOptions) {
  getSystemConfig.mockResolvedValue({
    json: async () => ({
      hostDaemonPort: daemonPort,
      voiceTranscriptionEnabled: false,
    }),
    ok: true,
  });
  fetchHostStatus.mockResolvedValue(
    localHostId
      ? {
          hostId: localHostId,
          connected: true,
          serverUrl: "http://localhost:3334",
          supportsNativeFolderPicker,
        }
      : null,
  );

  const { queryClient, wrapper: baseWrapper } = createQueryClientTestHarness();
  queryClient.setQueryData(hostsQueryKey(), hosts);

  const wrapper = ({ children }: { children: ReactNode }) =>
    baseWrapper({
      children: (
        <Suspense fallback={null}>
          {children}
        </Suspense>
      ),
    });

  return {
    wrapper,
  };
}

function createHostDaemonProbe(useHostDaemon: () => HostDaemonSnapshot) {
  return function HostDaemonProbe({
    onSnapshot,
  }: {
    onSnapshot: (snapshot: HostDaemonSnapshot) => void;
  }) {
    const value = useHostDaemon();

    useEffect(() => {
      onSnapshot(value);
    }, [onSnapshot, value]);

    return (
      <div>
        <div data-testid="local-host-id">{value.localHostId ?? "null"}</div>
        <div data-testid="host-name">{value.localHost?.name ?? "none"}</div>
        <div data-testid="has-daemon">{String(value.hasDaemon)}</div>
        <div data-testid="is-connected">{String(value.hasConnectedPersistentHost)}</div>
        <div data-testid="supports-folder-picker">{String(value.supportsNativeFolderPicker)}</div>
        <div data-testid="is-local-host-1">{String(value.isLocalHost("host-1"))}</div>
        <div data-testid="is-local-host-2">{String(value.isLocalHost("host-2"))}</div>
        <button disabled={value.openPath == null} onClick={() => void value.openPath?.("/tmp/file.txt")}>
          open path
        </button>
        <button disabled={value.pickFolder == null} onClick={() => void value.pickFolder?.()}>
          pick folder
        </button>
      </div>
    );
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useHostDaemon", () => {
  it("exposes the local host and bound daemon actions when the daemon is available", async () => {
    const localHost = makeHost();
    const latestSnapshot: { current: HostDaemonSnapshot | null } = { current: null };
    openPath.mockResolvedValue(undefined);
    pickFolder.mockResolvedValue("/picked/path");

    const { wrapper } = createHostDaemonWrapper({
      daemonPort: 4123,
      hosts: [localHost],
      localHostId: localHost.id,
    });
    const HostDaemonProbe = createHostDaemonProbe(useHostDaemon);

    await act(async () => {
      render(<HostDaemonProbe onSnapshot={(snapshot) => { latestSnapshot.current = snapshot; }} />, {
        wrapper,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("local-host-id").textContent).toBe(localHost.id);
    });
    expect(screen.getByTestId("host-name").textContent).toBe(localHost.name);
    expect(screen.getByTestId("has-daemon").textContent).toBe("true");
    expect(screen.getByTestId("is-connected").textContent).toBe("true");
    expect(screen.getByTestId("supports-folder-picker").textContent).toBe("true");
    expect(screen.getByTestId("is-local-host-1").textContent).toBe("true");
    expect(screen.getByTestId("is-local-host-2").textContent).toBe("false");
    expect(latestSnapshot.current?.localHost).toEqual(localHost);

    fireEvent.click(screen.getByRole("button", { name: "open path" }));
    fireEvent.click(screen.getByRole("button", { name: "pick folder" }));

    await waitFor(() => {
      expect(openPath).toHaveBeenCalledWith(4123, "/tmp/file.txt");
    });
    expect(pickFolder).toHaveBeenCalledWith(4123);
  });

  it("returns null actions when the daemon or local host id is unavailable", async () => {
    const latestSnapshot: { current: HostDaemonSnapshot | null } = { current: null };
    const { wrapper } = createHostDaemonWrapper({
      daemonPort: null,
      hosts: [],
      localHostId: null,
    });
    const HostDaemonProbe = createHostDaemonProbe(useHostDaemon);

    await act(async () => {
      render(<HostDaemonProbe onSnapshot={(snapshot) => { latestSnapshot.current = snapshot; }} />, {
        wrapper,
      });
    });

    expect((await screen.findByTestId("local-host-id")).textContent).toBe("null");
    expect(screen.getByTestId("host-name").textContent).toBe("none");
    expect(screen.getByTestId("has-daemon").textContent).toBe("false");
    expect(screen.getByTestId("is-connected").textContent).toBe("false");
    expect(screen.getByTestId("supports-folder-picker").textContent).toBe("false");
    expect(screen.getByTestId("is-local-host-1").textContent).toBe("false");
    expect(screen.getByRole("button", { name: "open path" }).getAttribute("disabled")).not.toBeNull();
    expect(screen.getByRole("button", { name: "pick folder" }).getAttribute("disabled")).not.toBeNull();
    expect(latestSnapshot.current?.localHost).toBeNull();
    expect(latestSnapshot.current?.openPath).toBeNull();
    expect(latestSnapshot.current?.pickFolder).toBeNull();
  });

  it("hides folder picking when the daemon does not advertise that capability", async () => {
    const latestSnapshot: { current: HostDaemonSnapshot | null } = { current: null };
    const { wrapper } = createHostDaemonWrapper({
      daemonPort: 4123,
      hosts: [makeHost()],
      localHostId: "host-1",
      supportsNativeFolderPicker: false,
    });
    const HostDaemonProbe = createHostDaemonProbe(useHostDaemon);

    await act(async () => {
      render(<HostDaemonProbe onSnapshot={(snapshot) => { latestSnapshot.current = snapshot; }} />, {
        wrapper,
      });
    });

    expect((await screen.findByTestId("supports-folder-picker")).textContent).toBe("false");
    expect(screen.getByRole("button", { name: "pick folder" }).getAttribute("disabled")).not.toBeNull();
    expect(latestSnapshot.current?.pickFolder).toBeNull();
  });
});
