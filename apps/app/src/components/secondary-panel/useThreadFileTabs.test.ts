// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserFixedPanelTab,
  createEmptyFixedPanelTabsState,
  createHostFilePreviewFixedPanelTab,
  createTerminalFixedPanelTab,
  createThreadStorageFilePreviewFixedPanelTab,
  getFixedPanelTabsStateStorageKey,
  serializeFixedPanelTabsState,
  FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
} from "@/lib/fixed-panel-tabs-state";
import { buildFileOpenerPanelTab } from "@/components/plugin/file-opener-tabs";
import {
  resetRecentlyClosedPanelTabsForTest,
  useThreadFileTabs,
} from "./useThreadFileTabs";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makeTerminalSession as terminalSession } from "@/test/fixtures/terminal-sessions";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const syncMocks = vi.hoisted(() => ({
  scheduleLocalThreadTabsMigration: vi.fn(),
  scheduleThreadTabsPersistence: vi.fn(),
  useThreadTabs: vi.fn(() => ({ data: undefined })),
}));

vi.mock("@/hooks/queries/thread-tabs-query", () => ({
  useThreadTabs: syncMocks.useThreadTabs,
}));

vi.mock("@/lib/thread-tabs-sync", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/thread-tabs-sync")>();
  return {
    ...actual,
    hasPendingThreadTabsWrite: () => false,
    scheduleLocalThreadTabsMigration:
      syncMocks.scheduleLocalThreadTabsMigration,
    scheduleThreadTabsPersistence: syncMocks.scheduleThreadTabsPersistence,
  };
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function QueryWrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function renderThreadHook<Result>(hook: () => Result) {
  return renderHook(hook, { wrapper: QueryWrapper });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
  resetRecentlyClosedPanelTabsForTest();
  resetPluginSlotStoreForTest();
  syncMocks.scheduleLocalThreadTabsMigration.mockClear();
  syncMocks.scheduleThreadTabsPersistence.mockClear();
  syncMocks.useThreadTabs.mockClear();
});

describe("useThreadFileTabs recently closed tabs", () => {
  it("reopens closed tabs in reverse close order and restores their positions", () => {
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "recently-closed",
        syncThreadId: null,
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    let firstTabId = "";
    let secondTabId = "";
    act(() => {
      firstTabId =
        result.current.openTab({
          kind: "browser",
          url: "https://first.example",
        })?.id ?? "";
      secondTabId =
        result.current.openTab({
          kind: "browser",
          url: "https://second.example",
        })?.id ?? "";
    });
    act(() => {
      result.current.closeTab(firstTabId);
      result.current.closeTab(secondTabId);
    });

    expect(result.current.orderedSecondaryFileTabs).toHaveLength(0);
    let didReopen = false;
    act(() => {
      didReopen = result.current.reopenClosedTab();
    });
    expect(didReopen).toBe(true);
    expect(result.current.activeBrowserTab?.id).toBe(secondTabId);

    act(() => {
      didReopen = result.current.reopenClosedTab();
    });
    expect(didReopen).toBe(true);
    expect(result.current.activeBrowserTab?.id).toBe(firstTabId);
    expect(
      result.current.orderedSecondaryFileTabs.map((tab) => tab.id),
    ).toEqual([firstTabId, secondTabId]);

    act(() => {
      didReopen = result.current.reopenClosedTab();
    });
    expect(didReopen).toBe(false);
  });

  it("does not reopen a launcher tab or a file reopened another way", () => {
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "recently-closed-launcher",
        syncThreadId: null,
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );
    const fileRequest = {
      kind: "workspace-file-preview" as const,
      tab: {
        lineRange: null,
        path: "src/index.ts",
        source: { kind: "working-tree" as const },
        statusLabel: null,
      },
    };

    act(() => {
      const launcher = result.current.openTab({ kind: "new-tab" });
      result.current.closeTab(launcher?.id ?? "");
    });
    expect(result.current.reopenClosedTab()).toBe(false);

    let fileTabId = "";
    act(() => {
      fileTabId = result.current.openTab(fileRequest)?.id ?? "";
    });
    act(() => result.current.closeTab(fileTabId));
    act(() => {
      result.current.openTab(fileRequest);
    });
    expect(result.current.reopenClosedTab()).toBe(false);
  });

  it("skips storage history with a deleted path or different owner", () => {
    let storageFiles = {
      files: [
        { name: "available.md", path: "available.md" },
        { name: "deleted.md", path: "deleted.md" },
      ],
      truncated: false,
    };
    const { result, rerender } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "recently-closed-storage",
        syncThreadId: "thr_current",
        environmentId: "env_1",
        storageFiles,
        terminalSessions: undefined,
      }),
    );

    let availableTabId = "";
    let foreignTabId = "";
    let deletedTabId = "";
    act(() => {
      availableTabId =
        result.current.openTab({
          kind: "thread-storage-file-preview",
          tab: { lineRange: null, path: "available.md" },
        })?.id ?? "";
      foreignTabId =
        result.current.openTab({
          kind: "thread-storage-file-preview",
          tab: { lineRange: null, path: "foreign.md" },
          threadId: "thr_foreign",
        })?.id ?? "";
      deletedTabId =
        result.current.openTab({
          kind: "thread-storage-file-preview",
          tab: { lineRange: null, path: "deleted.md" },
        })?.id ?? "";
    });
    act(() => {
      result.current.closeTab(availableTabId);
      result.current.closeTab(foreignTabId);
      result.current.closeTab(deletedTabId);
    });
    act(() => {
      storageFiles = {
        files: [{ name: "available.md", path: "available.md" }],
        truncated: false,
      };
      rerender();
    });

    let didReopen = false;
    act(() => {
      didReopen = result.current.reopenClosedTab();
    });
    expect(didReopen).toBe(true);
    expect(result.current.activeStorageFilePath).toBe("available.md");
    expect(result.current.activeStorageFileThreadId).toBe("thr_current");

    act(() => {
      didReopen = result.current.reopenClosedTab();
    });
    expect(didReopen).toBe(false);
  });

  it("does not consume or transiently restore storage history before exact validation", async () => {
    const validation = createDeferred<boolean>();
    const storageFileExists = vi.fn(() => validation.promise);
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "recently-closed-storage-loading",
        syncThreadId: "thr_current",
        environmentId: "env_1",
        storageFileExists,
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    let storageTabId = "";
    act(() => {
      storageTabId =
        result.current.openTab({
          kind: "thread-storage-file-preview",
          tab: { lineRange: null, path: "still-here.md" },
        })?.id ?? "";
    });
    act(() => result.current.closeTab(storageTabId));

    let didHandle = false;
    act(() => {
      didHandle = result.current.reopenClosedTab();
    });
    expect(didHandle).toBe(true);
    expect(result.current.orderedSecondaryFileTabs).toHaveLength(0);
    expect(storageFileExists).toHaveBeenCalledWith("still-here.md");

    await act(async () => {
      validation.resolve(true);
      await validation.promise;
      await Promise.resolve();
    });
    expect(result.current.activeStorageFilePath).toBe("still-here.md");
  });

  it("checks a path omitted from a truncated inventory and skips it when deleted", async () => {
    const storageFileExists = vi.fn(async () => false);
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "recently-closed-storage-truncated",
        syncThreadId: "thr_current",
        environmentId: "env_1",
        storageFileExists,
        storageFiles: { files: [], truncated: true },
        terminalSessions: undefined,
      }),
    );

    let browserTabId = "";
    let storageTabId = "";
    act(() => {
      browserTabId =
        result.current.openTab({
          kind: "browser",
          url: "https://fallback.example",
        })?.id ?? "";
      storageTabId =
        result.current.openTab({
          kind: "thread-storage-file-preview",
          tab: { lineRange: null, path: "deleted-after-close.md" },
        })?.id ?? "";
    });
    act(() => {
      result.current.closeTab(browserTabId);
      result.current.closeTab(storageTabId);
    });
    act(() => {
      result.current.reopenClosedTab();
    });

    await waitFor(() => {
      expect(result.current.activeBrowserTab?.id).toBe(browserTabId);
    });
    expect(storageFileExists).toHaveBeenCalledWith("deleted-after-close.md");
    expect(result.current.activeStorageFilePath).toBeNull();
  });

  it("restores a valid path omitted from a truncated inventory", async () => {
    const storageFileExists = vi.fn(async () => true);
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "recently-closed-storage-truncated-valid",
        syncThreadId: "thr_current",
        environmentId: "env_1",
        storageFileExists,
        storageFiles: { files: [], truncated: true },
        terminalSessions: undefined,
      }),
    );

    let storageTabId = "";
    act(() => {
      storageTabId =
        result.current.openTab({
          kind: "thread-storage-file-preview",
          tab: { lineRange: null, path: "after-page-one.md" },
        })?.id ?? "";
    });
    act(() => result.current.closeTab(storageTabId));
    act(() => {
      result.current.reopenClosedTab();
    });

    await waitFor(() => {
      expect(result.current.activeStorageFilePath).toBe("after-page-one.md");
    });
    expect(storageFileExists).toHaveBeenCalledWith("after-page-one.md");
  });

  it("keeps an open storage tab when the inventory is truncated", () => {
    const threadId = "storage-truncated-open-tab";
    const storageTab = createThreadStorageFilePreviewFixedPanelTab({
      environmentId: "env_1",
      isPinned: false,
      tab: { lineRange: null, path: "after-page-one.md" },
      threadId,
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: storageTab.id,
        isOpen: true,
        tabs: [storageTab],
      },
      lastUsedAt: Date.now(),
    });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      serializeFixedPanelTabsState({ state }),
    );

    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: threadId,
        syncThreadId: threadId,
        environmentId: "env_1",
        storageFiles: { files: [], truncated: true },
        terminalSessions: undefined,
      }),
    );

    expect(result.current.activeStorageFilePath).toBe("after-page-one.md");
  });

  it.each([
    {
      changedContext: {
        environmentId: "env_2",
        fileOwnerThreadId: "thr_1",
        projectHostId: "host_1",
        projectId: "proj_1",
      },
      dimension: "environment",
    },
    {
      changedContext: {
        environmentId: "env_1",
        fileOwnerThreadId: "thr_1",
        projectHostId: "host_1",
        projectId: "proj_2",
      },
      dimension: "project",
    },
    {
      changedContext: {
        environmentId: "env_1",
        fileOwnerThreadId: "thr_2",
        projectHostId: "host_1",
        projectId: "proj_1",
      },
      dimension: "file owner",
    },
    {
      changedContext: {
        environmentId: "env_1",
        fileOwnerThreadId: "thr_1",
        projectHostId: "host_2",
        projectId: "proj_1",
      },
      dimension: "project host",
    },
  ])(
    "skips workspace history from a different $dimension",
    ({ changedContext, dimension }) => {
      let context = {
        environmentId: "env_1",
        fileOwnerThreadId: "thr_1",
        projectHostId: "host_1",
        projectId: "proj_1",
      };
      const { result, rerender } = renderThreadHook(() =>
        useThreadFileTabs({
          panelStateId: `recently-closed-${dimension}`,
          syncThreadId: null,
          environmentId: context.environmentId,
          fileOwnerThreadId: context.fileOwnerThreadId,
          projectHostId: context.projectHostId,
          projectId: context.projectId,
          storageFiles: undefined,
          terminalSessions: undefined,
        }),
      );

      let workspaceTabId = "";
      act(() => {
        workspaceTabId =
          result.current.openTab({
            kind: "workspace-file-preview",
            tab: {
              lineRange: null,
              path: "src/index.ts",
              source: { kind: "working-tree" },
              statusLabel: null,
            },
          })?.id ?? "";
      });
      act(() => result.current.closeTab(workspaceTabId));
      act(() => {
        context = changedContext;
        rerender();
      });

      let didReopen = false;
      act(() => {
        didReopen = result.current.reopenClosedTab();
      });
      expect(didReopen).toBe(false);
      expect(result.current.activeWorkspaceFilePath).toBeNull();
    },
  );

  it("restores the nearest history entry owned by the current context", () => {
    let environmentId = "env_1";
    const { result, rerender } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "recently-closed-context-order",
        syncThreadId: null,
        environmentId,
        fileOwnerThreadId: "thr_1",
        projectHostId: "host_1",
        projectId: "proj_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    const openAndCloseWorkspaceFile = (path: string) => {
      let tabId = "";
      act(() => {
        tabId =
          result.current.openTab({
            kind: "workspace-file-preview",
            tab: {
              lineRange: null,
              path,
              source: { kind: "working-tree" },
              statusLabel: null,
            },
          })?.id ?? "";
      });
      act(() => result.current.closeTab(tabId));
    };

    openAndCloseWorkspaceFile("src/env-one.ts");
    act(() => {
      environmentId = "env_2";
      rerender();
    });
    openAndCloseWorkspaceFile("src/env-two.ts");
    act(() => {
      environmentId = "env_1";
      rerender();
    });

    let didReopen = false;
    act(() => {
      didReopen = result.current.reopenClosedTab();
    });
    expect(didReopen).toBe(true);
    expect(result.current.activeWorkspaceFilePath).toBe("src/env-one.ts");

    act(() => {
      didReopen = result.current.reopenClosedTab();
    });
    expect(didReopen).toBe(false);

    act(() => {
      environmentId = "env_2";
      rerender();
    });
    act(() => {
      didReopen = result.current.reopenClosedTab();
    });
    expect(didReopen).toBe(true);
    expect(result.current.activeWorkspaceFilePath).toBe("src/env-two.ts");
  });
});

describe("useThreadFileTabs terminal pruning", () => {
  it("keeps root-compose file tabs local", () => {
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "root-compose",
        syncThreadId: null,
        environmentId: "env_root",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() => {
      result.current.openTab({ kind: "new-tab" });
    });

    expect(syncMocks.useThreadTabs).toHaveBeenCalledWith("", {
      enabled: false,
    });
    expect(syncMocks.scheduleLocalThreadTabsMigration).not.toHaveBeenCalled();
    expect(syncMocks.scheduleThreadTabsPersistence).not.toHaveBeenCalled();
  });

  it("drops disconnected terminal tabs when not retained", async () => {
    const threadId = "terminal-prune-unretained";
    const disconnectedTab = createTerminalFixedPanelTab({
      terminalId: "term_disconnected",
    });
    const runningTab = createTerminalFixedPanelTab({
      terminalId: "term_running",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: runningTab.id,
        isOpen: true,
        tabs: [disconnectedTab, runningTab],
      },
      lastUsedAt: Date.now(),
    });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      serializeFixedPanelTabsState({ state }),
    );

    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: threadId,
        syncThreadId: threadId,
        environmentId: "env_current",
        storageFiles: undefined,
        terminalSessions: [
          terminalSession({
            id: "term_disconnected",
            status: "disconnected",
          }),
          terminalSession({ id: "term_running" }),
        ],
      }),
    );

    await waitFor(() => {
      expect(
        result.current.orderedSecondaryFileTabs.map((tab) => tab.id),
      ).toEqual([runningTab.id]);
    });
  });

  it("keeps a retained disconnected terminal tab", async () => {
    const threadId = "terminal-prune-retained";
    const disconnectedTab = createTerminalFixedPanelTab({
      terminalId: "term_disconnected",
    });
    const runningTab = createTerminalFixedPanelTab({
      terminalId: "term_running",
    });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          secondary: {
            activeTabId: disconnectedTab.id,
            isOpen: true,
            tabs: [disconnectedTab, runningTab],
          },
          lastUsedAt: Date.now(),
        }),
      }),
    );

    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: threadId,
        syncThreadId: threadId,
        environmentId: "env_current",
        retainedTerminalId: "term_disconnected",
        storageFiles: undefined,
        terminalSessions: [
          terminalSession({
            id: "term_disconnected",
            status: "disconnected",
          }),
          terminalSession({ id: "term_running" }),
        ],
      }),
    );

    await waitFor(() => {
      expect(
        result.current.orderedSecondaryFileTabs.map((tab) => tab.id),
      ).toEqual([disconnectedTab.id, runningTab.id]);
    });
  });
});

describe("useThreadFileTabs active owners", () => {
  it("restores a project opener from its persisted file source", () => {
    const panelStateId = "restored-project-file-opener";
    const openerTab = buildFileOpenerPanelTab(
      { id: "pdf", pluginId: "pdf-preview" },
      {
        path: "reports/quarterly.pdf",
        source: {
          kind: "workspace",
          threadId: null,
          environmentId: null,
          projectId: "proj_opened",
          experimental_hostId: "host_opened",
        },
      },
      {
        environmentId: null,
        kind: "workspace-file-preview",
        projectId: "proj_opened",
        tab: {
          lineRange: null,
          path: "reports/quarterly.pdf",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
        threadId: null,
      },
    );
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId: panelStateId }),
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          secondary: {
            activeTabId: openerTab.id,
            isOpen: true,
            tabs: [openerTab],
          },
          lastUsedAt: Date.now(),
        }),
      }),
    );

    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId,
        syncThreadId: null,
        environmentId: "env_selected",
        preserveWorkspaceTabsAcrossContexts: true,
        projectHostId: "host_selected",
        projectId: "proj_selected",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    expect(result.current.activeFileOpenerFile).toEqual({
      path: "reports/quarterly.pdf",
      source: {
        kind: "workspace",
        threadId: null,
        environmentId: null,
        projectId: "proj_opened",
        experimental_hostId: "host_opened",
      },
    });
    expect(result.current.activeWorkspaceFileEnvironmentId).toBeNull();
    expect(result.current.activeWorkspaceFileProjectId).toBe("proj_opened");
    expect(result.current.activeWorkspaceFilePath).toBe(
      "reports/quarterly.pdf",
    );
  });

  it("returns owner ids for an active restored host file tab", () => {
    const threadId = "root-compose-ownerful";
    const hostTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_file",
      tab: {
        lineRange: null,
        path: "/tmp/log.txt",
      },
      threadId: "thr_file",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: hostTab.id,
        isOpen: true,
        tabs: [hostTab],
      },
      lastUsedAt: Date.now(),
    });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      serializeFixedPanelTabsState({ state }),
    );

    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: threadId,
        syncThreadId: threadId,
        environmentId: "env_current",
        fileOwnerThreadId: "thr_current",
        preserveWorkspaceTabsAcrossContexts: true,
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    expect(result.current.activeHostFilePath).toBe("/tmp/log.txt");
    expect(result.current.activeHostFileThreadId).toBe("thr_file");
    expect(result.current.activeHostFileEnvironmentId).toBe("env_file");
  });

  it("backfills owner ids for an active legacy storage file tab", async () => {
    const threadId = "root-compose-legacy-storage";
    const legacyStorageTab = {
      id: "thread-storage-file-preview:artifact.txt:none",
      isPinned: false,
      kind: "thread-storage-file-preview",
      lineRange: null,
      path: "artifact.txt",
    };
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      JSON.stringify({
        version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
        secondary: {
          activeTabId: legacyStorageTab.id,
          isOpen: true,
          tabs: [legacyStorageTab],
        },
        lastUsedAt: Date.now(),
      }),
    );

    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: threadId,
        syncThreadId: threadId,
        environmentId: "env_root",
        fileOwnerThreadId: "thr_root",
        preserveWorkspaceTabsAcrossContexts: true,
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    await waitFor(() => {
      expect(result.current.activeStorageFilePath).toBe("artifact.txt");
      expect(result.current.activeStorageFileThreadId).toBe("thr_root");
      expect(result.current.activeStorageFileEnvironmentId).toBe("env_root");
    });
  });

  it("returns owner ids for an active restored storage file tab", () => {
    const threadId = "root-compose-ownerful-storage";
    const storageTab = createThreadStorageFilePreviewFixedPanelTab({
      environmentId: "env_file",
      isPinned: false,
      tab: {
        lineRange: null,
        path: "artifact.txt",
      },
      threadId: "thr_file",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: storageTab.id,
        isOpen: true,
        tabs: [storageTab],
      },
      lastUsedAt: Date.now(),
    });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      serializeFixedPanelTabsState({ state }),
    );

    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: threadId,
        syncThreadId: threadId,
        environmentId: "env_current",
        fileOwnerThreadId: "thr_current",
        preserveWorkspaceTabsAcrossContexts: true,
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    expect(result.current.activeStorageFilePath).toBe("artifact.txt");
    expect(result.current.activeStorageFileThreadId).toBe("thr_file");
    expect(result.current.activeStorageFileEnvironmentId).toBe("env_file");
  });
});

describe("useThreadFileTabs plugin panel tabs", () => {
  it("opens, focuses identical re-opens (title refreshed), and opens siblings for new params", () => {
    const threadId = "plugin-panel-open";
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: threadId,
        syncThreadId: threadId,
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() =>
      result.current.openPluginPanel({
        pluginId: "demo",
        actionId: "issue",
        title: "Issue #1",
        paramsJson: '{"n":1}',
      }),
    );
    expect(result.current.orderedSecondaryFileTabs).toHaveLength(1);
    const firstTab = result.current.activePluginPanelTab;
    expect(firstTab).toMatchObject({
      kind: "plugin-panel",
      pluginId: "demo",
      actionId: "issue",
      title: "Issue #1",
      paramsJson: '{"n":1}',
    });

    act(() =>
      result.current.openPluginPanel({
        pluginId: "demo",
        actionId: "issue",
        title: "Issue #1 (renamed)",
        paramsJson: '{"n":1}',
      }),
    );
    expect(result.current.orderedSecondaryFileTabs).toHaveLength(1);
    expect(result.current.activePluginPanelTab?.id).toBe(firstTab?.id);
    expect(result.current.activePluginPanelTab?.title).toBe(
      "Issue #1 (renamed)",
    );

    act(() =>
      result.current.openPluginPanel({
        pluginId: "demo",
        actionId: "issue",
        title: "Issue #2",
        paramsJson: '{"n":2}',
      }),
    );
    expect(result.current.orderedSecondaryFileTabs).toHaveLength(2);
    expect(result.current.activePluginPanelTab?.paramsJson).toBe('{"n":2}');
  });

  it("replaces a transient new-tab like the other launchers", () => {
    const threadId = "plugin-panel-replace-new-tab";
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: threadId,
        syncThreadId: threadId,
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );
    act(() => result.current.openTab({ kind: "new-tab" }));
    expect(result.current.isNewTabActive).toBe(true);
    act(() =>
      result.current.openPluginPanel({
        pluginId: "demo",
        actionId: "issue",
        title: "Issue",
        paramsJson: null,
      }),
    );
    expect(result.current.isNewTabActive).toBe(false);
    expect(
      result.current.orderedSecondaryFileTabs.map((tab) => tab.kind),
    ).toEqual(["plugin-panel"]);
  });
});

describe("useThreadFileTabs file opener diversion", () => {
  function NotesEditor() {
    return null;
  }

  function registerNotesOpener() {
    setPluginSlotRegistrations(
      "notes",
      makePluginRegistrationSet({
        fileOpeners: [
          {
            id: "editor",
            title: "Notes editor",
            extensions: ["md"],
            component: NotesEditor,
          },
        ],
      }),
    );
  }

  it("automatically diverts matching working-tree files to the opener tab", () => {
    registerNotesOpener();
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "opener-divert",
        syncThreadId: "opener-divert",
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() =>
      result.current.openTab({
        kind: "workspace-file-preview",
        tab: {
          lineRange: { startLineNumber: 7, endLineNumber: 9 },
          path: "notes/todo.md",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      }),
    );

    expect(result.current.activePluginPanelTab).toMatchObject({
      kind: "plugin-panel",
      pluginId: "notes",
      actionId: "file-opener:editor",
      title: "todo.md",
    });
    const params = JSON.parse(
      result.current.activePluginPanelTab?.paramsJson ?? "null",
    ) as {
      path: string;
      source: { kind: string; environmentId: string | null };
    };
    expect(params.path).toBe("notes/todo.md");
    expect(params.source).toMatchObject({
      kind: "workspace",
      environmentId: "env_1",
    });
    expect(result.current.activePluginPanelTab?.fileOpenerOwner).toMatchObject({
      kind: "workspace-file-preview",
      tab: {
        lineRange: { startLineNumber: 7, endLineNumber: 9 },
      },
    });
    expect(result.current.activeFileOpenerOwner).toBe(
      result.current.activePluginPanelTab?.fileOpenerOwner,
    );
    expect(result.current.activeWorkspaceFilePath).toBe("notes/todo.md");
    expect(result.current.activeWorkspaceFileLineRange).toEqual({
      startLineNumber: 7,
      endLineNumber: 9,
    });

    const firstTabId = result.current.activePluginPanelTab?.id;
    act(() =>
      result.current.openTab({
        kind: "workspace-file-preview",
        tab: {
          lineRange: { startLineNumber: 15, endLineNumber: 15 },
          path: "notes/todo.md",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      }),
    );
    expect(result.current.activePluginPanelTab?.id).toBe(firstTabId);
    expect(result.current.activeWorkspaceFileLineRange).toEqual({
      startLineNumber: 15,
      endLineNumber: 15,
    });
  });

  it("preserves native host and thread-storage preview state", () => {
    registerNotesOpener();
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "opener-owner-context",
        syncThreadId: "thr_owner",
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() =>
      result.current.openTab({
        kind: "host-file-preview",
        tab: {
          lineRange: { startLineNumber: 11, endLineNumber: 12 },
          path: "/tmp/readme.md",
        },
      }),
    );
    expect(result.current.activeFileOpenerOwner).toEqual({
      kind: "host-file-preview",
      environmentId: "env_1",
      hostId: null,
      tab: {
        lineRange: { startLineNumber: 11, endLineNumber: 12 },
        path: "/tmp/readme.md",
      },
      threadId: "thr_owner",
    });
    expect(result.current.activeHostFilePath).toBe("/tmp/readme.md");
    expect(result.current.activeHostFileLineRange).toEqual({
      startLineNumber: 11,
      endLineNumber: 12,
    });

    act(() =>
      result.current.openTab({
        kind: "thread-storage-file-preview",
        tab: {
          lineRange: { startLineNumber: 2, endLineNumber: 5 },
          path: "artifacts/report.md",
        },
      }),
    );
    expect(result.current.activeFileOpenerOwner).toEqual({
      kind: "thread-storage-file-preview",
      environmentId: "env_1",
      tab: {
        lineRange: { startLineNumber: 2, endLineNumber: 5 },
        path: "artifacts/report.md",
      },
      threadId: "thr_owner",
    });
    expect(result.current.activeStorageFilePath).toBe("artifacts/report.md");
    expect(result.current.activeStorageFileLineRange).toEqual({
      startLineNumber: 2,
      endLineNumber: 5,
    });
  });

  it("keeps the built-in preview for ref snapshots and unmatched extensions", () => {
    registerNotesOpener();
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "opener-skip",
        syncThreadId: "opener-skip",
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() =>
      result.current.openTab({
        kind: "workspace-file-preview",
        tab: {
          lineRange: null,
          path: "notes/todo.md",
          source: { kind: "head" },
          statusLabel: null,
        },
      }),
    );
    expect(result.current.activePluginPanelTab).toBeNull();
    expect(result.current.activeWorkspaceFilePath).toBe("notes/todo.md");

    act(() =>
      result.current.openTab({
        kind: "workspace-file-preview",
        tab: {
          lineRange: null,
          path: "src/index.ts",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      }),
    );
    expect(result.current.activePluginPanelTab).toBeNull();
    expect(result.current.activeWorkspaceFilePath).toBe("src/index.ts");
  });

  it("diverts a workspace file picked from the file search", () => {
    registerNotesOpener();
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "opener-search",
        syncThreadId: "opener-search",
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() => result.current.openTab({ kind: "new-tab" }));
    act(() =>
      result.current.selectFileSearchResult({
        source: "workspace",
        path: "notes/todo.md",
      }),
    );

    expect(result.current.activePluginPanelTab).toMatchObject({
      kind: "plugin-panel",
      pluginId: "notes",
      actionId: "file-opener:editor",
      title: "todo.md",
    });
    const params = JSON.parse(
      result.current.activePluginPanelTab?.paramsJson ?? "null",
    ) as {
      path: string;
      source: { kind: string; environmentId: string | null };
    };
    expect(params.path).toBe("notes/todo.md");
    expect(params.source).toMatchObject({
      kind: "workspace",
      environmentId: "env_1",
    });
    expect(result.current.isNewTabActive).toBe(false);
    expect(
      result.current.orderedSecondaryFileTabs.map((tab) => tab.kind),
    ).toEqual(["plugin-panel"]);
  });

  it("diverts a thread-storage file picked from the file search", () => {
    registerNotesOpener();
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "opener-storage-search",
        syncThreadId: "thr_storage_search",
        environmentId: "env_1",
        storageFiles: {
          files: [{ name: "notes.md", path: "artifacts/notes.md" }],
          truncated: false,
        },
        terminalSessions: undefined,
      }),
    );

    act(() => result.current.openTab({ kind: "new-tab" }));
    act(() =>
      result.current.selectFileSearchResult({
        source: "thread-storage",
        path: "artifacts/notes.md",
      }),
    );

    expect(result.current.activePluginPanelTab).toMatchObject({
      kind: "plugin-panel",
      pluginId: "notes",
      actionId: "file-opener:editor",
      title: "notes.md",
      fileOpenerOwner: {
        kind: "thread-storage-file-preview",
        environmentId: "env_1",
        threadId: "thr_storage_search",
        tab: { path: "artifacts/notes.md" },
      },
    });
    expect(result.current.isNewTabActive).toBe(false);
    expect(
      result.current.orderedSecondaryFileTabs.map((tab) => tab.kind),
    ).toEqual(["plugin-panel"]);
  });

  it("keeps the built-in preview for an unmatched file search extension", () => {
    registerNotesOpener();
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "opener-search-unmatched",
        syncThreadId: "opener-search-unmatched",
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() => result.current.openTab({ kind: "new-tab" }));
    act(() =>
      result.current.selectFileSearchResult({
        source: "workspace",
        path: "src/main.rs",
      }),
    );

    expect(result.current.activePluginPanelTab).toBeNull();
    expect(result.current.activeWorkspaceFilePath).toBe("src/main.rs");
  });

  it("honors a pinned built-in preference from the file search", () => {
    window.localStorage.setItem(
      "bb.fileOpenerByExtension",
      JSON.stringify({ md: "__builtin__" }),
    );
    registerNotesOpener();
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "opener-search-pinned",
        syncThreadId: "opener-search-pinned",
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() => result.current.openTab({ kind: "new-tab" }));
    act(() =>
      result.current.selectFileSearchResult({
        source: "workspace",
        path: "notes/todo.md",
      }),
    );

    expect(result.current.activePluginPanelTab).toBeNull();
    expect(result.current.activeWorkspaceFilePath).toBe("notes/todo.md");
  });

  it("falls back to the built-in preview when no opener is registered", () => {
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "opener-gone",
        syncThreadId: "opener-gone",
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() =>
      result.current.openTab({
        kind: "workspace-file-preview",
        tab: {
          lineRange: null,
          path: "notes/todo.md",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      }),
    );
    expect(result.current.activePluginPanelTab).toBeNull();
    expect(result.current.activeWorkspaceFilePath).toBe("notes/todo.md");
  });

  it("keeps the built-in preview when Settings pins it", () => {
    window.localStorage.setItem(
      "bb.fileOpenerByExtension",
      JSON.stringify({ md: "__builtin__" }),
    );
    registerNotesOpener();
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "opener-built-in",
        syncThreadId: "opener-built-in",
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() =>
      result.current.openTab({
        kind: "workspace-file-preview",
        tab: {
          lineRange: null,
          path: "notes/todo.md",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      }),
    );

    expect(result.current.activePluginPanelTab).toBeNull();
    expect(result.current.activeWorkspaceFilePath).toBe("notes/todo.md");
  });

  it("honors per-open viewer overrides in both directions", () => {
    registerNotesOpener();
    const { result } = renderThreadHook(() =>
      useThreadFileTabs({
        panelStateId: "opener-override",
        syncThreadId: "opener-override",
        environmentId: "env_1",
        storageFiles: undefined,
        terminalSessions: undefined,
      }),
    );

    act(() =>
      result.current.openTab(
        {
          kind: "workspace-file-preview",
          tab: {
            lineRange: null,
            path: "notes/todo.md",
            source: { kind: "working-tree" },
            statusLabel: null,
          },
        },
        { viewer: "builtin" },
      ),
    );
    expect(result.current.activePluginPanelTab).toBeNull();
    expect(result.current.activeWorkspaceFilePath).toBe("notes/todo.md");

    act(() =>
      result.current.openTab(
        {
          kind: "workspace-file-preview",
          tab: {
            lineRange: null,
            path: "notes/other.md",
            source: { kind: "working-tree" },
            statusLabel: null,
          },
        },
        { viewer: { pluginId: "notes", openerId: "editor" } },
      ),
    );
    expect(result.current.activePluginPanelTab).toMatchObject({
      pluginId: "notes",
      actionId: "file-opener:editor",
      title: "other.md",
    });
  });
});

describe("useThreadFileTabs legacy side-chat tabs", () => {
  it("drops tabs persisted before the native side chat was removed", () => {
    const threadId = "legacy-side-chat";
    const browserTab = createBrowserFixedPanelTab({
      environmentId: "env_current",
      url: "https://example.com",
    });
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId }),
      JSON.stringify({
        version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
        lastUsedAt: Date.now(),
        secondary: {
          activeTabId: "side-chat:legacy",
          isOpen: true,
          tabs: [
            browserTab,
            {
              id: "side-chat:legacy",
              kind: "side-chat",
              sourceMessageText: "anchor message",
              sourceSeqEnd: null,
              threadId: "thr_child",
              title: "Side chat",
            },
          ],
        },
      }),
    );

    const { result } = renderHook(
      () =>
        useThreadFileTabs({
          panelStateId: threadId,
          syncThreadId: threadId,
          environmentId: "env_current",
          storageFiles: undefined,
          terminalSessions: undefined,
        }),
      { wrapper: QueryWrapper },
    );

    expect(
      result.current.orderedSecondaryFileTabs.map((tab) => tab.id),
    ).toEqual([browserTab.id]);
  });
});
