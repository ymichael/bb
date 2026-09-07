// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserFixedPanelTab,
  createEmptyFixedPanelTabsState,
  createThreadInfoFixedPanelTab,
  FIXED_PANEL_TABS_IDLE_EXPIRY_MS,
  getFixedPanelTabsStateStorageKey,
  pruneFixedPanelTabsStorage,
  serializeFixedPanelTabsState,
} from "./fixed-panel-tabs-state";
import {
  resetFixedPanelTabsStateForTest,
  resetFixedPanelTabsStorageMaintenanceForTest,
  useFixedPanelTabsState,
  useFixedPanelTabsStorageMaintenance,
  useSetFixedSecondaryPanelTab,
  useUpdateFixedPanelTabsState,
} from "./fixed-panel-tabs";
import { BbHttpError } from "./sdk";

const apiMocks = vi.hoisted(() => ({
  getThreadTabs: vi.fn(),
  updateThreadTabs: vi.fn(),
}));

vi.mock("./sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sdk")>();
  return {
    ...actual,
    sdk: {
      threads: {
        tabs: {
          get: apiMocks.getThreadTabs,
          update: apiMocks.updateThreadTabs,
        },
      },
    },
  };
});

function createQueryWrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

afterEach(() => {
  cleanup();
  apiMocks.getThreadTabs.mockReset();
  apiMocks.updateThreadTabs.mockReset();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("fixed panel tab server sync", () => {
  it("keeps non-thread panel tabs local", () => {
    const panelStateId = "root-compose";
    const localTab = createThreadInfoFixedPanelTab();
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => ({
        state: useFixedPanelTabsState(panelStateId, null),
        update: useUpdateFixedPanelTabsState(panelStateId, null),
      }),
      { wrapper: createQueryWrapper(queryClient) },
    );

    act(() => {
      result.current.update((current) => ({
        ...current,
        secondary: {
          activeTabId: localTab.id,
          isOpen: true,
          tabs: [localTab],
        },
      }));
    });

    expect(result.current.state.secondary.tabs).toEqual([localTab]);
    expect(apiMocks.getThreadTabs).not.toHaveBeenCalled();
    expect(apiMocks.updateThreadTabs).not.toHaveBeenCalled();
  });

  it("adopts server tabs while keeping presentation state local", async () => {
    const threadId = "sync-remote-tabs";
    const localTab = createThreadInfoFixedPanelTab();
    const lastUsedAt = Date.now();
    const remoteTab = createBrowserFixedPanelTab({
      environmentId: null,
      url: "https://remote.example.com",
    });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          lastUsedAt,
          secondary: {
            activeTabId: localTab.id,
            isOpen: true,
            tabs: [localTab],
          },
        }),
      }),
    );
    apiMocks.getThreadTabs.mockResolvedValue({
      revision: 4,
      tabs: [remoteTab],
    });
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => useFixedPanelTabsState(threadId, threadId),
      {
        wrapper: createQueryWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(result.current.secondary.tabs).toEqual([remoteTab]);
    });
    expect(result.current).toMatchObject({
      lastUsedAt,
      secondary: { activeTabId: remoteTab.id, isOpen: true },
    });
  });

  it("closes an open thread panel when hydration leaves no tabs", async () => {
    const threadId = "sync-open-empty-panel";
    const lastUsedAt = Date.now();
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          lastUsedAt,
          secondary: {
            activeTabId: null,
            isOpen: true,
            tabs: [],
          },
        }),
      }),
    );
    apiMocks.getThreadTabs.mockResolvedValue({ revision: 2, tabs: [] });
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => useFixedPanelTabsState(threadId, threadId),
      { wrapper: createQueryWrapper(queryClient) },
    );

    await waitFor(() => expect(apiMocks.getThreadTabs).toHaveBeenCalled());

    expect(result.current.secondary).toEqual({
      activeTabId: null,
      isOpen: false,
      tabs: [],
    });
  });

  it("migrates existing local tabs when the server has no tab row", async () => {
    const threadId = "sync-local-migration";
    const localTab = createBrowserFixedPanelTab({
      environmentId: null,
      url: "https://example.com",
    });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          lastUsedAt: Date.now(),
          secondary: {
            activeTabId: localTab.id,
            isOpen: true,
            tabs: [localTab],
          },
        }),
      }),
    );
    apiMocks.getThreadTabs.mockResolvedValue({ revision: 0, tabs: [] });
    apiMocks.updateThreadTabs.mockResolvedValue({
      revision: 1,
      tabs: [localTab],
    });
    const queryClient = createTestQueryClient();
    renderHook(() => useFixedPanelTabsState(threadId, threadId), {
      wrapper: createQueryWrapper(queryClient),
    });

    await waitFor(() => {
      expect(apiMocks.updateThreadTabs).toHaveBeenCalledWith({
        expectedRevision: 0,
        tabs: [localTab],
        threadId,
      });
    });
  });

  it("uses server tabs when local migration is stale", async () => {
    const threadId = "sync-stale-migration";
    const localTab = createBrowserFixedPanelTab({
      environmentId: null,
      url: "https://local.example.com",
    });
    const serverTab = createBrowserFixedPanelTab({
      environmentId: null,
      url: "https://server.example.com",
    });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          lastUsedAt: Date.now(),
          secondary: {
            activeTabId: localTab.id,
            isOpen: true,
            tabs: [localTab],
          },
        }),
      }),
    );
    apiMocks.getThreadTabs
      .mockResolvedValueOnce({ revision: 0, tabs: [] })
      .mockResolvedValueOnce({ revision: 1, tabs: [serverTab] });
    apiMocks.updateThreadTabs.mockRejectedValueOnce(
      new BbHttpError({
        body: null,
        code: "thread_tabs_conflict",
        message: "changed",
        status: 409,
      }),
    );
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => useFixedPanelTabsState(threadId, threadId),
      { wrapper: createQueryWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(apiMocks.updateThreadTabs).toHaveBeenCalledWith({
        expectedRevision: 0,
        tabs: [localTab],
        threadId,
      });
    });
    await waitFor(() => {
      expect(apiMocks.getThreadTabs).toHaveBeenCalledTimes(2);
      expect(result.current.secondary.tabs).toEqual([serverTab]);
    });
  });

  it("persists tab-list changes but not presentation-only changes", async () => {
    const threadId = "sync-local-updates";
    apiMocks.getThreadTabs.mockResolvedValue({ revision: 2, tabs: [] });
    const savedTab = createThreadInfoFixedPanelTab();
    apiMocks.updateThreadTabs.mockResolvedValue({
      revision: 3,
      tabs: [savedTab],
    });
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => ({
        state: useFixedPanelTabsState(threadId, threadId),
        update: useUpdateFixedPanelTabsState(threadId, threadId),
      }),
      { wrapper: createQueryWrapper(queryClient) },
    );
    await waitFor(() => expect(apiMocks.getThreadTabs).toHaveBeenCalled());

    act(() => {
      result.current.update((current) => ({
        ...current,
        secondary: {
          activeTabId: savedTab.id,
          isOpen: true,
          tabs: [savedTab],
        },
      }));
    });
    await waitFor(() => {
      expect(apiMocks.updateThreadTabs).toHaveBeenCalledWith({
        expectedRevision: 2,
        tabs: [savedTab],
        threadId,
      });
    });

    apiMocks.updateThreadTabs.mockClear();
    act(() => {
      result.current.update((current) => ({
        ...current,
        secondary: { ...current.secondary, isOpen: false },
      }));
    });
    expect(apiMocks.updateThreadTabs).not.toHaveBeenCalled();
  });

  it("refreshes from the server after a stale local write", async () => {
    const threadId = "sync-stale-write";
    const originalTab = createThreadInfoFixedPanelTab();
    const localTab = createBrowserFixedPanelTab({
      environmentId: null,
      url: "https://local.example.com",
    });
    const concurrentTab = createBrowserFixedPanelTab({
      environmentId: null,
      url: "https://concurrent.example.com",
    });
    apiMocks.getThreadTabs
      .mockResolvedValueOnce({ revision: 1, tabs: [originalTab] })
      .mockResolvedValueOnce({
        revision: 2,
        tabs: [originalTab, concurrentTab],
      });
    apiMocks.updateThreadTabs.mockRejectedValueOnce(
      new BbHttpError({
        body: null,
        code: "thread_tabs_conflict",
        message: "changed",
        status: 409,
      }),
    );
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => ({
        state: useFixedPanelTabsState(threadId, threadId),
        update: useUpdateFixedPanelTabsState(threadId, threadId),
      }),
      { wrapper: createQueryWrapper(queryClient) },
    );
    await waitFor(() => {
      expect(result.current.state.secondary.tabs).toEqual([originalTab]);
    });

    act(() => {
      result.current.update((current) => ({
        ...current,
        secondary: {
          ...current.secondary,
          tabs: [...current.secondary.tabs, localTab],
        },
      }));
    });

    await waitFor(() => {
      expect(apiMocks.updateThreadTabs).toHaveBeenCalledWith({
        expectedRevision: 1,
        tabs: [originalTab, localTab],
        threadId,
      });
    });
    await waitFor(() => {
      expect(apiMocks.getThreadTabs).toHaveBeenCalledTimes(2);
      expect(result.current.state.secondary.tabs).toEqual([
        originalTab,
        concurrentTab,
      ]);
    });
    expect(apiMocks.updateThreadTabs).toHaveBeenCalledTimes(1);
  });
});

describe("fixed panel tab storage churn", () => {
  it("keeps panel selection in memory when localStorage rejects the write", () => {
    const threadId = "storage-write-failure";
    const storageKey = getFixedPanelTabsStateStorageKey({ threadId });
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => ({
        selectPanel: useSetFixedSecondaryPanelTab(threadId, null),
        state: useFixedPanelTabsState(threadId, null),
      }),
      { wrapper: createQueryWrapper(queryClient) },
    );
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((key) => {
        if (key === storageKey) {
          throw new DOMException("quota", "QuotaExceededError");
        }
      });

    act(() => result.current.selectPanel("thread-info"));

    expect(result.current.state.secondary).toMatchObject({
      activeTabId: createThreadInfoFixedPanelTab().id,
      isOpen: true,
    });
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(setItem).toHaveBeenCalledWith(storageKey, expect.any(String));
  });

  it("does not rewrite localStorage when hydration and reconciliation leave the state unchanged", async () => {
    resetFixedPanelTabsStateForTest();
    const threadId = "sync-no-rewrite";
    const remoteTab = createBrowserFixedPanelTab({
      environmentId: null,
      url: "https://remote.example.com",
    });
    const storageKey = getFixedPanelTabsStateStorageKey({ threadId });
    window.localStorage.setItem(
      storageKey,
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          lastUsedAt: Date.now(),
          secondary: {
            activeTabId: remoteTab.id,
            isOpen: true,
            tabs: [remoteTab],
          },
        }),
      }),
    );
    apiMocks.getThreadTabs.mockResolvedValue({
      revision: 4,
      tabs: [remoteTab],
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      const queryClient = createTestQueryClient();
      const { result } = renderHook(
        () => ({
          state: useFixedPanelTabsState(threadId, threadId),
          update: useUpdateFixedPanelTabsState(threadId, threadId),
        }),
        { wrapper: createQueryWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(apiMocks.getThreadTabs).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(result.current.state.secondary.tabs).toEqual([remoteTab]);
      });
      expect(setItem).not.toHaveBeenCalledWith(storageKey, expect.anything());

      act(() => {
        result.current.update((current) => current);
      });
      expect(setItem).not.toHaveBeenCalledWith(storageKey, expect.anything());
    } finally {
      setItem.mockRestore();
    }
  });

  it("schedules the storage prune once per page load, off the mount task", () => {
    vi.useFakeTimers();
    resetFixedPanelTabsStorageMaintenanceForTest();
    try {
      const now = Date.now();
      const expiredBlob = serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          lastUsedAt: now - FIXED_PANEL_TABS_IDLE_EXPIRY_MS - 1,
        }),
      });
      const firstKey = getFixedPanelTabsStateStorageKey({ threadId: "one" });
      window.localStorage.setItem(firstKey, expiredBlob);

      const first = renderHook(() => useFixedPanelTabsStorageMaintenance());
      expect(window.localStorage.getItem(firstKey)).not.toBeNull();
      act(() => {
        vi.runAllTimers();
      });
      expect(window.localStorage.getItem(firstKey)).toBeNull();
      first.unmount();

      const secondKey = getFixedPanelTabsStateStorageKey({ threadId: "two" });
      window.localStorage.setItem(secondKey, expiredBlob);
      renderHook(() => useFixedPanelTabsStorageMaintenance());
      act(() => {
        vi.runAllTimers();
      });
      expect(window.localStorage.getItem(secondKey)).not.toBeNull();
    } finally {
      vi.useRealTimers();
      resetFixedPanelTabsStorageMaintenanceForTest();
    }
  });

  it("prunes expired and malformed blobs and keeps fresh ones", () => {
    const now = Date.now();
    const freshKey = getFixedPanelTabsStateStorageKey({ threadId: "fresh" });
    const expiredKey = getFixedPanelTabsStateStorageKey({
      threadId: "expired",
    });
    const garbageKey = getFixedPanelTabsStateStorageKey({
      threadId: "garbage",
    });
    const staleShapeKey = getFixedPanelTabsStateStorageKey({
      threadId: "stale-shape",
    });
    window.localStorage.setItem(
      freshKey,
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({ lastUsedAt: now }),
      }),
    );
    window.localStorage.setItem(
      expiredKey,
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          lastUsedAt: now - FIXED_PANEL_TABS_IDLE_EXPIRY_MS - 1,
        }),
      }),
    );
    window.localStorage.setItem(garbageKey, "{not json");
    window.localStorage.setItem(
      staleShapeKey,
      JSON.stringify({ lastUsedAt: now, secondary: "nope" }),
    );
    window.localStorage.setItem("unrelated", "keep");

    pruneFixedPanelTabsStorage({ now });

    expect(window.localStorage.getItem(freshKey)).not.toBeNull();
    expect(window.localStorage.getItem(expiredKey)).toBeNull();
    expect(window.localStorage.getItem(garbageKey)).toBeNull();
    expect(window.localStorage.getItem(staleShapeKey)).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });
});
