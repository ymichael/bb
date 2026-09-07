// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Host } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalPathPicker } from "./useLocalPathPicker";

const mocks = vi.hoisted(() => ({
  hosts: undefined as Host[] | undefined,
  isLoadingHosts: false,
  pickFolder: vi.fn(),
  primaryHost: null as Host | null,
  supportsNativeFolderPicker: true,
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    localDaemonHostId: "host_atum",
    localHostId: "host_atum",
    hasDaemon: true,
    supportsNativeFolderPicker: mocks.supportsNativeFolderPicker,
    platform: "linux",
    isLocalDaemonHost: (hostId: string | null) => hostId === "host_atum",
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
  mocks.pickFolder.mockResolvedValue({ path: "/home/me/repo" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
