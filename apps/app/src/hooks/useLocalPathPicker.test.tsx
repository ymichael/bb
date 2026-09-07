// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Host } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalPathPicker } from "./useLocalPathPicker";

const mocks = vi.hoisted(() => ({
  hosts: undefined as Host[] | undefined,
  isLoadingHosts: false,
  localDaemonHostId: "host_atum" as string | null,
  localHostId: "host_atum" as string | null,
  pickFolder: vi.fn(),
  primaryHost: null as Host | null,
  supportsNativeFolderPicker: true,
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    localDaemonHostId: mocks.localDaemonHostId,
    localHostId: mocks.localHostId,
    hasDaemon: true,
    supportsNativeFolderPicker: mocks.supportsNativeFolderPicker,
    platform: "linux",
    isLocalDaemonHost: (hostId: string | null) =>
      hostId !== null && hostId === mocks.localDaemonHostId,
  }),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: mocks.hosts, isPending: mocks.isLoadingHosts }),
  usePrimaryHost: () => mocks.primaryHost,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { hosts: { pickFolder: mocks.pickFolder } },
}));

const atum = makeHost({
  id: "host_atum",
  name: "atum",
});

function host(
  id: string,
  name: string,
  status: Host["status"] = "connected",
): Host {
  return makeHost({ ...atum, id, name, status });
}

beforeEach(() => {
  mocks.primaryHost = atum;
  mocks.supportsNativeFolderPicker = true;
  mocks.hosts = [atum];
  mocks.isLoadingHosts = false;
  mocks.localDaemonHostId = "host_atum";
  mocks.localHostId = "host_atum";
  mocks.pickFolder.mockResolvedValue({ path: "/home/me/repo" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("usePathPickerHost", () => {
  it("targets this machine when its daemon is enrolled and connected", () => {
    const thoth = host("host_thoth", "Thoth");
    mocks.primaryHost = thoth;
    mocks.hosts = [thoth, atum];

    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit: vi.fn() }),
    );

    expect(result.current.hostId).toBe("host_atum");
    expect(result.current.hostName).toBe("atum");
  });

  it("falls back to the primary host when this machine is enrolled elsewhere", () => {
    const thoth = host("host_thoth", "Thoth");
    mocks.primaryHost = thoth;
    mocks.hosts = [thoth];
    mocks.localDaemonHostId = "host_elsewhere";
    mocks.localHostId = "host_elsewhere";

    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit: vi.fn() }),
    );

    expect(result.current.hostId).toBe("host_thoth");
  });

  it("falls back to the primary host when this machine is offline on the server", () => {
    const thoth = host("host_thoth", "Thoth");
    mocks.primaryHost = thoth;
    mocks.hosts = [thoth, host("host_atum", "atum", "disconnected")];

    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit: vi.fn() }),
    );

    expect(result.current.hostId).toBe("host_thoth");
  });

  it("falls back to the primary host with no local daemon", () => {
    const thoth = host("host_thoth", "Thoth");
    mocks.primaryHost = thoth;
    mocks.hosts = [thoth, atum];
    mocks.localDaemonHostId = null;
    mocks.localHostId = null;

    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit: vi.fn() }),
    );

    expect(result.current.hostId).toBe("host_thoth");
  });
});

describe("useLocalPathPicker", () => {
  it("drops a submit that carries no machine", () => {
    const submit = vi.fn();
    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit }),
    );

    act(() => {
      result.current.submitProjectPath({ kind: "create" }, "/srv/thing", null);
    });

    expect(submit).not.toHaveBeenCalled();
  });

  it("submits on the machine the dialog reports", () => {
    const submit = vi.fn();
    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit }),
    );

    act(() => {
      result.current.submitProjectPath(
        { kind: "create" },
        "/srv/thing",
        "host_kunst",
      );
    });

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host_kunst", path: "/srv/thing" }),
    );
  });

  it("still submits on the primary host after the native folder picker", async () => {
    const submit = vi.fn();
    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit }),
    );

    act(() => {
      result.current.openPicker({ kind: "create" });
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "host_atum", path: "/home/me/repo" }),
      );
    });
  });
});

describe("useLocalPathPicker openPathEntry", () => {
  it("opens the dialog instead of the native picker when several machines exist", () => {
    mocks.hosts = [atum, host("host_thoth", "Thoth")];
    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit: vi.fn() }),
    );

    act(() => result.current.openPathEntry({ kind: "create" }));

    expect(result.current.projectPathDialog.isOpen).toBe(true);
    expect(mocks.pickFolder).not.toHaveBeenCalled();
  });

  it("uses the native picker with one machine", () => {
    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit: vi.fn() }),
    );

    act(() => result.current.openPathEntry({ kind: "create" }));

    expect(mocks.pickFolder).toHaveBeenCalled();
    expect(result.current.projectPathDialog.isOpen).toBe(false);
  });

  it("keeps the native picker when the only other machine is offline", () => {
    mocks.hosts = [atum, host("host_dead", "Old laptop", "disconnected")];
    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit: vi.fn() }),
    );

    act(() => result.current.openPathEntry({ kind: "create" }));

    expect(mocks.pickFolder).toHaveBeenCalled();
    expect(result.current.projectPathDialog.isOpen).toBe(false);
  });

  it("opens the dialog while the machine list is still loading", () => {
    mocks.hosts = undefined;
    mocks.isLoadingHosts = true;
    const { result } = renderHook(() =>
      useLocalPathPicker({ isPending: false, submit: vi.fn() }),
    );

    act(() => result.current.openPathEntry({ kind: "create" }));

    expect(result.current.projectPathDialog.isOpen).toBe(true);
    expect(mocks.pickFolder).not.toHaveBeenCalled();
  });
});
