// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@bb/server-contract";
import { resetPluginSlotStoreForTest } from "@/lib/plugin-slots";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { pluginListQueryKey } from "@/hooks/queries/query-keys";
import { useSettingsNavState } from "./settings-nav";
import { makeInstalledPlugin } from "@/test/fixtures/plugins";

const mocks = vi.hoisted(() => ({
  accessState: "unavailable",
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: false }),
  useLocalHostDaemonAccess: () => ({ accessState: mocks.accessState }),
}));

function wrapperFor(path: string, plugins: readonly InstalledPlugin[] = []) {
  const { queryClient, wrapper: QueryWrapper } = createQueryClientTestHarness();
  queryClient.setQueryData(pluginListQueryKey(true), plugins);
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryWrapper>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryWrapper>
    );
  };
}

function disabledPlugin(): InstalledPlugin {
  return makeInstalledPlugin({
    id: "linear",
    source: "path:/plugins/linear",
    rootDir: "/plugins/linear",
    enabled: false,
    status: "disabled",
    description: "Linear integration",
    name: "Linear",
    sourceDisplay: "path · /plugins/linear",
  });
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  mocks.accessState = "unavailable";
});

describe("useSettingsNavState", () => {
  it("resolves the Providers bucket from its section route", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/providers"),
    });

    expect(result.current.activeSection).toBe("providers");
    expect(result.current.hasUnknownSection).toBe(false);
  });

  it("shows the Machines section", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/machines"),
    });

    expect(result.current.sections.map((section) => section.id)).toContain(
      "machines",
    );
  });

  it("shows Files when local helper access can be enabled", () => {
    mocks.accessState = "permission-required";
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/files"),
    });

    expect(result.current.sections.map((section) => section.id)).toContain(
      "files",
    );
  });

  it("resolves archived threads as a settings section", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/archived"),
    });

    expect(result.current.activeSection).toBe("archived");
    expect(result.current.sections.map((section) => section.id)).toContain(
      "archived",
    );
  });

  it("resolves installed plugin management in Settings", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/plugins"),
    });

    expect(result.current.activeSection).toBe("plugins");
    expect(result.current.hasUnknownSection).toBe(false);
    expect(result.current.sections.map((section) => section.id)).toContain(
      "plugins",
    );
  });

  it("omits disabled plugins from individual settings entries", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings", [disabledPlugin()]),
    });

    expect(result.current.pluginEntries).toEqual([]);
  });
});
