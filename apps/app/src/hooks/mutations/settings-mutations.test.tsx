// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SystemConfigResponse } from "@bb/server-contract";
import {
  defaultAppSettings,
  type AppKeybindingOverrides,
  type AppKeybindings,
} from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  modelCatalogCacheKey,
  readCachedModelCatalog,
  writeCachedModelCatalog,
} from "@/lib/model-catalog-cache";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import {
  systemConfigQueryKey,
  systemExecutionOptionsQueryKey,
  systemProvidersQueryKey,
  threadTimelineQueryKey,
  threadTimelineTurnSummaryDetailsQueryKey,
} from "../queries/query-keys";
import {
  useUpdateGeneralSettings,
  useUpdateKeyboardSettings,
} from "./settings-mutations";

vi.mock("@/lib/sdk", () => {
  return {
    sdk: {
      system: {
        updateGeneralSettings: vi.fn(),
        updateKeyboardSettings: vi.fn(),
      },
    },
  };
});

const defaultKeybindings: AppKeybindings = [
  {
    command: "thread.new",
    desktopOnly: false,
    shortcut: {
      key: "n",
      mod: true,
      meta: false,
      control: false,
      alt: false,
      shift: false,
    },
    when: { all: ["mainSurface"], none: ["modalOpen"] },
  },
];

function systemConfig(): SystemConfigResponse {
  return makeSystemConfig({
    keybindings: defaultKeybindings,
    defaultKeybindings,
  });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("general settings mutation", () => {
  it("invalidates config and timeline projections and leaves model catalogs alone for a non-streamer write", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const configKey = systemConfigQueryKey();
    const timelineKey = threadTimelineQueryKey("thread-1");
    const summaryKey = threadTimelineTurnSummaryDetailsQueryKey({
      threadId: "thread-1",
      turnId: "turn-1",
      sourceSeqStart: 1,
      sourceSeqEnd: 2,
    });
    const executionOptionsKey = systemExecutionOptionsQueryKey({
      environmentId: null,
      hostId: "host-1",
      providerId: "claude-code",
    });
    const providersKey = systemProvidersQueryKey();
    queryClient.setQueryData(configKey, systemConfig());
    queryClient.setQueryData(timelineKey, {});
    queryClient.setQueryData(summaryKey, {});
    queryClient.setQueryData(executionOptionsKey, { models: ["cached"] });
    queryClient.setQueryData(providersKey, [{ id: "claude-code" }]);
    const nextSettings = {
      ...defaultAppSettings,
      showUnhandledProviderEvents: true,
    };
    vi.mocked(sdk.system.updateGeneralSettings).mockResolvedValue(nextSettings);
    const { result } = renderHook(() => useUpdateGeneralSettings(), {
      wrapper,
    });

    act(() => result.current.mutate(nextSettings));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryState(configKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(summaryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(executionOptionsKey)?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryData(executionOptionsKey)).toEqual({
      models: ["cached"],
    });
    expect(queryClient.getQueryState(providersKey)?.isInvalidated).toBe(false);
  });

  it("refreshes the provider directory after its picker order changes", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const providersKey = systemProvidersQueryKey();
    queryClient.setQueryData(systemConfigQueryKey(), systemConfig());
    queryClient.setQueryData(providersKey, [{ id: "alpha" }, { id: "beta" }]);
    const nextSettings = {
      ...defaultAppSettings,
      providerOrder: ["beta", "alpha"],
    };
    vi.mocked(sdk.system.updateGeneralSettings).mockResolvedValue(nextSettings);
    const { result } = renderHook(() => useUpdateGeneralSettings(), {
      wrapper,
    });

    act(() => result.current.mutate(nextSettings));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryState(providersKey)?.isInvalidated).toBe(true);
  });

  it("drops cached model catalogs when streamer mode flips", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const executionOptionsKey = systemExecutionOptionsQueryKey({
      environmentId: null,
      hostId: "host-1",
      providerId: "claude-code",
    });
    const catalogCacheKey = modelCatalogCacheKey({
      environmentId: null,
      hostId: "host-1",
      providerId: "claude-code",
    });
    queryClient.setQueryData(systemConfigQueryKey(), systemConfig());
    queryClient.setQueryData(executionOptionsKey, { models: ["secret"] });
    writeCachedModelCatalog(catalogCacheKey, {
      models: [],
      selectedOnlyModels: [],
    });
    expect(readCachedModelCatalog(catalogCacheKey)).not.toBeNull();
    const nextSettings = { ...defaultAppSettings, streamerMode: true };
    vi.mocked(sdk.system.updateGeneralSettings).mockResolvedValue(nextSettings);
    const { result } = renderHook(() => useUpdateGeneralSettings(), {
      wrapper,
    });

    act(() => result.current.mutate(nextSettings));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await waitFor(() =>
      expect(queryClient.getQueryData(executionOptionsKey)).toBeUndefined(),
    );
    expect(readCachedModelCatalog(catalogCacheKey)).toBeNull();
  });
});

describe("keyboard settings mutation", () => {
  it("updates resolved system config before the request completes", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(systemConfigQueryKey(), systemConfig());
    let resolveRequest: (overrides: AppKeybindingOverrides) => void = () => {};
    vi.mocked(sdk.system.updateKeyboardSettings).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const overrides: AppKeybindingOverrides = [
      {
        command: "thread.new",
        shortcut: {
          key: "u",
          mod: true,
          meta: false,
          control: false,
          alt: false,
          shift: true,
        },
      },
    ];
    const { result } = renderHook(() => useUpdateKeyboardSettings(), {
      wrapper,
    });

    act(() => result.current.mutate(overrides));
    await waitFor(() => {
      expect(
        queryClient.getQueryData<SystemConfigResponse>(systemConfigQueryKey())
          ?.keybindings[0]?.shortcut,
      ).toMatchObject({ key: "u", shift: true });
    });

    act(() => resolveRequest(overrides));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("restores resolved system config when the request fails", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(systemConfigQueryKey(), systemConfig());
    vi.mocked(sdk.system.updateKeyboardSettings).mockRejectedValue(
      new Error("write failed"),
    );
    const { result } = renderHook(() => useUpdateKeyboardSettings(), {
      wrapper,
    });

    act(() =>
      result.current.mutate([{ command: "thread.new", shortcut: null }]),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));

    const restored = queryClient.getQueryData<SystemConfigResponse>(
      systemConfigQueryKey(),
    );
    expect(restored?.keybindingOverrides).toEqual([]);
    expect(restored?.keybindings).toEqual(defaultKeybindings);
  });
});
