import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type {
  TerminalSession,
  ThreadStorageFileListResponse,
} from "@bb/server-contract";
import {
  useFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import {
  createBrowserFixedPanelTab,
  createHostFilePreviewFixedPanelTab,
  createNewTabFixedPanelTab,
  createPluginPanelFixedPanelTab,
  createThreadStorageFilePreviewFixedPanelTab,
  createWorkspaceFilePreviewFixedPanelTab,
  type BrowserFixedPanelTab,
  type FixedPanelTab,
  type FixedPanelTabsState,
  type HostFilePreviewFixedPanelTab,
  type NewTabFixedPanelTab,
  type PluginPanelFixedPanelTab,
  type ThreadStorageFilePreviewFixedPanelTab,
  type WorkspaceFilePreviewFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useFileOpenerPreferenceValue } from "@/lib/file-opener-preference";
import {
  createFileOpenerOriginalTab,
  createFileOpenerTabForRequest,
  fileOpenerIdFromActionId,
  parseFileOpenerParams,
} from "@/components/plugin/file-opener-tabs";
import type { FileOpenerOverride } from "@/lib/plugin-slot-resolvers";
import type { OpenPluginPanelArgs } from "@/components/plugin/PluginPanelActions";
import type {
  HostFileTabState,
  ThreadStorageFileTabState,
  WorkspaceFileTabState,
} from "@bb/client-core";
import { useRecordThreadRecentItem } from "./threadRecentItems";
import type {
  SecondaryPanelTabReorderHandler,
  SecondaryPanelTabReorderRequest,
} from "./secondaryPanelTab";
import {
  activateSecondaryPanelTabInState,
  buildOrderedSecondaryPanelFileTabs,
  clearActiveSecondaryFileTabInState,
  closeSecondaryPanelTabInState,
  findSecondaryPanelTab,
  getActiveSecondaryPanelTab,
  getActiveTabIdAfterPrune,
  isBrowserTab,
  openSecondaryPanelTabInState,
  pruneStorageTabs,
  removeWorkspaceTabsForOtherEnvironments,
  replaceNewTabWithSecondaryPanelTabInState,
  reorderSecondaryPanelFileTabInState,
  setSecondaryPanelTabsInState,
  updateSecondaryPanelTabInState,
} from "@bb/client-core";
import { pruneTerminalTabsForSessions } from "./terminalPanelTabs";

interface UseThreadFileTabsParams {
  panelStateId: string | null | undefined;
  syncThreadId: string | null | undefined;
  environmentId: string | null | undefined;
  fileOwnerThreadId?: string | null;
  onCloseLastTab?: () => void;
  preserveWorkspaceTabsAcrossContexts?: boolean;
  projectHostId?: string | null;
  projectId?: string | null;
  retainedTerminalId?: string | null;
  storageFileExists?: (path: string) => Promise<boolean>;
  storageFiles:
    | Pick<ThreadStorageFileListResponse, "files" | "truncated">
    | undefined;
  terminalSessions: readonly TerminalSession[] | undefined;
}

interface FileSearchWorkspaceSelection {
  source: "workspace";
  path: string;
}

interface FileSearchThreadStorageSelection {
  source: "thread-storage";
  path: string;
}

export type FileSearchSelection =
  | FileSearchWorkspaceSelection
  | FileSearchThreadStorageSelection;

export interface UpdateBrowserTabArgs {
  tabId: string;
  url: string;
  title: string | null;
}

export type OpenSecondaryPanelTabRequest =
  | {
      kind: "workspace-file-preview";
      tab: WorkspaceFileTabState;
      environmentId?: string;
    }
  | {
      kind: "host-file-preview";
      tab: HostFileTabState;
      hostId?: string;
    }
  | {
      kind: "thread-storage-file-preview";
      tab: ThreadStorageFileTabState;
      threadId?: string;
    }
  | { kind: "browser"; url: string }
  | { kind: "new-tab" };

interface CreateTabForOpenRequestArgs {
  projectId: string | null;
  request: OpenSecondaryPanelTabRequest;
  resolvedEnvironmentId: string | null | undefined;
  threadId: string | null | undefined;
}

interface PruneSecondaryTabsArgs {
  activeTabId: string | null;
  tabs: readonly FixedPanelTab[];
}

type SecondaryPanelTab =
  | WorkspaceFilePreviewFixedPanelTab
  | HostFilePreviewFixedPanelTab
  | ThreadStorageFilePreviewFixedPanelTab
  | BrowserFixedPanelTab
  | NewTabFixedPanelTab
  | PluginPanelFixedPanelTab;

type ReopenableSecondaryPanelTab = Exclude<
  SecondaryPanelTab,
  NewTabFixedPanelTab
>;

interface RecentlyClosedPanelTab {
  index: number;
  tab: ReopenableSecondaryPanelTab;
}

interface RecentlyClosedPanelContext {
  environmentId: string | null | undefined;
  fileOwnerThreadId: string | null;
  panelStateId: string;
  projectHostId: string | null;
  projectId: string | null;
}

interface IsReopenablePanelTabOwnedByContextArgs {
  context: RecentlyClosedPanelContext;
  tab: ReopenableSecondaryPanelTab;
}

interface StorageFileInventory {
  knownPaths: ReadonlySet<string>;
  truncated: boolean;
}

type RecentlyClosedPanelTabAvailability =
  | "available"
  | "missing"
  | "unresolved";

type TakeClosedPanelTabResult =
  | { kind: "available"; entry: RecentlyClosedPanelTab }
  | { kind: "unresolved"; entry: RecentlyClosedPanelTab }
  | { kind: "empty" };

type RecentlyClosedPanelContextKey = string;
type OpenResolvedTabBehavior = "open" | "replace-new-tab";

const MAX_RECENTLY_CLOSED_PANEL_TABS = 25;
const recentlyClosedPanelTabs = new Map<
  RecentlyClosedPanelContextKey,
  RecentlyClosedPanelTab[]
>();

function isReopenableSecondaryPanelTab(
  tab: FixedPanelTab,
): tab is ReopenableSecondaryPanelTab {
  switch (tab.kind) {
    case "workspace-file-preview":
    case "host-file-preview":
    case "thread-storage-file-preview":
    case "browser":
    case "plugin-panel":
      return true;
    case "thread-info":
    case "git-diff":
    case "plugin-page-fixed":
    case "new-tab":
    case "terminal":
      return false;
  }
}

function rememberClosedPanelTab(
  contextKey: RecentlyClosedPanelContextKey,
  entry: RecentlyClosedPanelTab,
): void {
  const stack = recentlyClosedPanelTabs.get(contextKey) ?? [];
  stack.push(entry);
  if (stack.length > MAX_RECENTLY_CLOSED_PANEL_TABS) {
    stack.splice(0, stack.length - MAX_RECENTLY_CLOSED_PANEL_TABS);
  }
  recentlyClosedPanelTabs.set(contextKey, stack);
}

function forgetClosedPanelTab(
  contextKey: RecentlyClosedPanelContextKey,
  tabId: string,
): boolean {
  const stack = recentlyClosedPanelTabs.get(contextKey);
  if (stack === undefined) return false;
  const wasTop = stack.at(-1)?.tab.id === tabId;
  const next = stack.filter((entry) => entry.tab.id !== tabId);
  if (next.length === 0) {
    recentlyClosedPanelTabs.delete(contextKey);
    return wasTop;
  }
  recentlyClosedPanelTabs.set(contextKey, next);
  return wasTop;
}

function isReopenablePanelTabOwnedByContext({
  context,
  tab: reopenableTab,
}: IsReopenablePanelTabOwnedByContextArgs): boolean {
  const originalTab =
    reopenableTab.kind === "plugin-panel"
      ? createFileOpenerOriginalTab(reopenableTab)
      : null;
  const tab = originalTab ?? reopenableTab;
  switch (tab.kind) {
    case "workspace-file-preview":
      return (
        tab.environmentId === context.environmentId &&
        tab.projectId ===
          (context.environmentId === null ? context.projectId : null)
      );
    case "host-file-preview":
      return (
        tab.hostId !== null ||
        (tab.environmentId === context.environmentId &&
          tab.threadId === context.fileOwnerThreadId)
      );
    case "thread-storage-file-preview":
      return tab.threadId === context.fileOwnerThreadId;
    case "browser":
      return tab.environmentId === context.environmentId;
    case "plugin-panel":
      return true;
  }
}

function storagePathForRecentlyClosedPanelTab(
  tab: ReopenableSecondaryPanelTab,
): string | null {
  const originalTab =
    tab.kind === "plugin-panel" ? createFileOpenerOriginalTab(tab) : null;
  const resourceTab = originalTab ?? tab;
  return resourceTab.kind === "thread-storage-file-preview"
    ? resourceTab.path
    : null;
}

function recentlyClosedPanelTabAvailability(
  tab: ReopenableSecondaryPanelTab,
  storageInventory: StorageFileInventory | null,
): RecentlyClosedPanelTabAvailability {
  const storagePath = storagePathForRecentlyClosedPanelTab(tab);
  if (storagePath === null) return "available";
  if (storageInventory === null) return "unresolved";
  if (storageInventory.knownPaths.has(storagePath)) return "available";
  return storageInventory.truncated ? "unresolved" : "missing";
}

function takeClosedPanelTab(
  contextKey: RecentlyClosedPanelContextKey,
  openTabIds: ReadonlySet<string>,
  availability: (
    entry: RecentlyClosedPanelTab,
  ) => RecentlyClosedPanelTabAvailability,
): TakeClosedPanelTabResult {
  const stack = recentlyClosedPanelTabs.get(contextKey);
  if (stack === undefined) return { kind: "empty" };
  while (stack.length > 0) {
    const entry = stack.at(-1);
    if (entry === undefined) break;
    if (openTabIds.has(entry.tab.id)) {
      stack.pop();
      continue;
    }
    const entryAvailability = availability(entry);
    if (entryAvailability === "unresolved") {
      return { kind: "unresolved", entry };
    }
    stack.pop();
    if (entryAvailability === "missing") continue;
    if (stack.length === 0) recentlyClosedPanelTabs.delete(contextKey);
    return { kind: "available", entry };
  }
  recentlyClosedPanelTabs.delete(contextKey);
  return { kind: "empty" };
}

export function resetRecentlyClosedPanelTabsForTest(): void {
  recentlyClosedPanelTabs.clear();
}

function createStorageTab(
  environmentId: string | null,
  tab: ThreadStorageFileTabState,
  threadId: string,
): ThreadStorageFilePreviewFixedPanelTab {
  return createThreadStorageFilePreviewFixedPanelTab({
    environmentId,
    isPinned: false,
    tab,
    threadId,
  });
}

function createTabForOpenRequest({
  projectId,
  request,
  resolvedEnvironmentId,
  threadId,
}: CreateTabForOpenRequestArgs): SecondaryPanelTab | null {
  switch (request.kind) {
    case "workspace-file-preview":
      if (
        request.environmentId === undefined &&
        resolvedEnvironmentId === undefined
      ) {
        return null;
      }
      const workspaceEnvironmentId =
        request.environmentId ?? resolvedEnvironmentId ?? null;
      return createWorkspaceFilePreviewFixedPanelTab({
        environmentId: workspaceEnvironmentId,
        projectId: workspaceEnvironmentId === null ? projectId : null,
        tab: request.tab,
      });
    case "host-file-preview":
      if (request.hostId !== undefined) {
        return createHostFilePreviewFixedPanelTab({
          environmentId: null,
          hostId: request.hostId,
          tab: request.tab,
          threadId: null,
        });
      }
      if (!threadId || !resolvedEnvironmentId) return null;
      return createHostFilePreviewFixedPanelTab({
        environmentId: resolvedEnvironmentId,
        tab: request.tab,
        threadId,
      });
    case "thread-storage-file-preview":
      const storageThreadId = request.threadId ?? threadId;
      if (!storageThreadId) return null;
      return createStorageTab(
        resolvedEnvironmentId ?? null,
        request.tab,
        storageThreadId,
      );
    case "browser":
      return createBrowserFixedPanelTab({
        environmentId: resolvedEnvironmentId ?? null,
        url: request.url,
      });
    case "new-tab":
      return createNewTabFixedPanelTab();
  }
}

function openRequestForFileSearchSelection(
  selection: FileSearchSelection,
): OpenSecondaryPanelTabRequest {
  if (selection.source === "workspace") {
    return {
      kind: "workspace-file-preview",
      tab: {
        lineRange: null,
        path: selection.path,
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    };
  }

  return {
    kind: "thread-storage-file-preview",
    tab: {
      lineRange: null,
      path: selection.path,
    },
  };
}

function setPrunedSecondaryTabs({
  activeTabId,
  tabs,
}: PruneSecondaryTabsArgs): {
  activeTabId: string | null;
  tabs: readonly FixedPanelTab[];
} {
  return {
    activeTabId: getActiveTabIdAfterPrune(tabs, activeTabId),
    tabs,
  };
}

export function useThreadFileTabs({
  panelStateId,
  syncThreadId,
  environmentId,
  fileOwnerThreadId,
  onCloseLastTab,
  preserveWorkspaceTabsAcrossContexts = false,
  projectHostId = null,
  projectId = null,
  retainedTerminalId = null,
  storageFileExists,
  storageFiles,
  terminalSessions,
}: UseThreadFileTabsParams) {
  const fixedPanelTabsState = useFixedPanelTabsState(
    panelStateId,
    syncThreadId,
  );
  const updateFixedPanelTabsState = useUpdateFixedPanelTabsState(
    panelStateId,
    syncThreadId,
  );
  const recordRecentItem = useRecordThreadRecentItem(panelStateId);
  const resolvedPanelStateId =
    typeof panelStateId === "string" && panelStateId.length > 0
      ? panelStateId
      : null;
  const isPanelStateResolved = resolvedPanelStateId !== null;
  const resolvedFileOwnerThreadId =
    fileOwnerThreadId !== undefined
      ? fileOwnerThreadId
      : (syncThreadId ?? null);
  const resolvedEnvironmentId = isPanelStateResolved
    ? environmentId
    : undefined;
  const storageInventory = useMemo<StorageFileInventory | null>(
    () =>
      storageFiles === undefined
        ? null
        : {
            knownPaths: new Set(storageFiles.files.map((file) => file.path)),
            truncated: storageFiles.truncated,
          },
    [storageFiles],
  );
  const recentlyClosedPanelContext = useMemo(
    () =>
      resolvedPanelStateId === null
        ? null
        : {
            environmentId: resolvedEnvironmentId,
            fileOwnerThreadId: resolvedFileOwnerThreadId,
            panelStateId: resolvedPanelStateId,
            projectHostId,
            projectId,
          },
    [
      projectHostId,
      projectId,
      resolvedEnvironmentId,
      resolvedFileOwnerThreadId,
      resolvedPanelStateId,
    ],
  );
  const recentlyClosedPanelContextKey = useMemo(
    () =>
      recentlyClosedPanelContext === null
        ? null
        : JSON.stringify(recentlyClosedPanelContext),
    [recentlyClosedPanelContext],
  );
  const recentlyClosedPanelContextKeyRef = useRef(
    recentlyClosedPanelContextKey,
  );
  const pendingStorageValidationRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);

  useLayoutEffect(() => {
    recentlyClosedPanelContextKeyRef.current = recentlyClosedPanelContextKey;
    pendingStorageValidationRef.current = null;
  }, [recentlyClosedPanelContextKey]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!resolvedFileOwnerThreadId) return;
    updateFixedPanelTabsState((state) => {
      let didChange = false;
      const tabIdMap = new Map<string, string>();
      const seenTabIds = new Set<string>();
      const tabs: FixedPanelTab[] = [];
      for (const tab of state.secondary.tabs) {
        let nextTab = tab;
        if (
          tab.kind === "host-file-preview" &&
          tab.threadId === null &&
          resolvedEnvironmentId
        ) {
          nextTab = createHostFilePreviewFixedPanelTab({
            environmentId: resolvedEnvironmentId,
            hostId: tab.hostId,
            tab: {
              lineRange: tab.lineRange,
              path: tab.path,
            },
            threadId: resolvedFileOwnerThreadId,
          });
          didChange = true;
          tabIdMap.set(tab.id, nextTab.id);
        } else if (
          tab.kind === "thread-storage-file-preview" &&
          tab.threadId === null
        ) {
          nextTab = createThreadStorageFilePreviewFixedPanelTab({
            environmentId: tab.environmentId ?? resolvedEnvironmentId ?? null,
            isPinned: tab.isPinned,
            tab: {
              lineRange: tab.lineRange,
              path: tab.path,
            },
            threadId: resolvedFileOwnerThreadId,
          });
          didChange = true;
          tabIdMap.set(tab.id, nextTab.id);
        }
        if (seenTabIds.has(nextTab.id)) {
          didChange = true;
          tabIdMap.set(tab.id, nextTab.id);
          continue;
        }
        seenTabIds.add(nextTab.id);
        tabs.push(nextTab);
      }
      if (!didChange) return state;
      const activeTabId =
        state.secondary.activeTabId === null
          ? null
          : (tabIdMap.get(state.secondary.activeTabId) ??
            state.secondary.activeTabId);
      return setSecondaryPanelTabsInState({
        activeTabId,
        isOpen: state.secondary.isOpen,
        state,
        tabs,
      });
    });
  }, [
    resolvedEnvironmentId,
    resolvedFileOwnerThreadId,
    updateFixedPanelTabsState,
  ]);

  useEffect(() => {
    if (preserveWorkspaceTabsAcrossContexts) return;
    if (resolvedEnvironmentId === undefined) return;
    updateFixedPanelTabsState((state) => {
      const pruned = setPrunedSecondaryTabs({
        activeTabId: state.secondary.activeTabId,
        tabs: removeWorkspaceTabsForOtherEnvironments(
          state.secondary.tabs,
          resolvedEnvironmentId,
        ),
      });
      return setSecondaryPanelTabsInState({
        activeTabId: pruned.activeTabId,
        isOpen: state.secondary.isOpen,
        state,
        tabs: pruned.tabs,
      });
    });
  }, [
    preserveWorkspaceTabsAcrossContexts,
    resolvedEnvironmentId,
    updateFixedPanelTabsState,
  ]);

  useEffect(() => {
    if (
      !isPanelStateResolved ||
      storageInventory === null ||
      storageInventory.truncated
    ) {
      return;
    }
    updateFixedPanelTabsState((state) => {
      const pruned = setPrunedSecondaryTabs({
        activeTabId: state.secondary.activeTabId,
        tabs: pruneStorageTabs({
          knownPaths: storageInventory.knownPaths,
          tabs: state.secondary.tabs,
          threadId: resolvedFileOwnerThreadId,
        }),
      });
      return setSecondaryPanelTabsInState({
        activeTabId: pruned.activeTabId,
        isOpen: state.secondary.isOpen,
        state,
        tabs: pruned.tabs,
      });
    });
  }, [
    isPanelStateResolved,
    resolvedFileOwnerThreadId,
    storageInventory,
    updateFixedPanelTabsState,
  ]);

  useEffect(() => {
    if (!isPanelStateResolved || terminalSessions === undefined) return;
    updateFixedPanelTabsState((state) => {
      const pruned = setPrunedSecondaryTabs({
        activeTabId: state.secondary.activeTabId,
        tabs: pruneTerminalTabsForSessions({
          retainedTerminalId,
          tabs: state.secondary.tabs,
          terminalSessions,
        }),
      });
      return setSecondaryPanelTabsInState({
        activeTabId: pruned.activeTabId,
        isOpen: state.secondary.isOpen,
        state,
        tabs: pruned.tabs,
      });
    });
  }, [
    isPanelStateResolved,
    retainedTerminalId,
    terminalSessions,
    updateFixedPanelTabsState,
  ]);

  const { fileOpeners } = usePluginSlots();
  const fileOpenerPreference = useFileOpenerPreferenceValue();

  const openResolvedTab = useCallback(
    (
      request: OpenSecondaryPanelTabRequest,
      behavior: OpenResolvedTabBehavior,
      viewer?: FileOpenerOverride,
    ): SecondaryPanelTab | null => {
      const openerTab = createFileOpenerTabForRequest({
        fileOpeners,
        preference: fileOpenerPreference,
        projectHostId,
        projectId,
        request,
        resolvedEnvironmentId,
        threadId: resolvedFileOwnerThreadId,
        ...(viewer !== undefined ? { viewer } : {}),
      });
      const tab =
        openerTab ??
        createTabForOpenRequest({
          projectId,
          request,
          resolvedEnvironmentId,
          threadId: resolvedFileOwnerThreadId,
        });
      if (tab === null) return null;

      if (recentlyClosedPanelContextKey !== null) {
        forgetClosedPanelTab(recentlyClosedPanelContextKey, tab.id);
      }

      if (
        request.kind === "workspace-file-preview" &&
        request.tab.source.kind === "working-tree"
      ) {
        recordRecentItem({ source: "workspace", path: request.tab.path });
      }
      if (request.kind === "thread-storage-file-preview") {
        recordRecentItem({ source: "thread-storage", path: request.tab.path });
      }

      updateFixedPanelTabsState((state) => {
        if (behavior === "replace-new-tab") {
          return replaceNewTabWithSecondaryPanelTabInState({ state, tab });
        }
        return openSecondaryPanelTabInState({ state, tab });
      });
      return tab;
    },
    [
      fileOpenerPreference,
      fileOpeners,
      projectHostId,
      recordRecentItem,
      projectId,
      resolvedEnvironmentId,
      resolvedFileOwnerThreadId,
      recentlyClosedPanelContextKey,
      updateFixedPanelTabsState,
    ],
  );

  const openTab = useCallback(
    (
      request: OpenSecondaryPanelTabRequest,
      options?: { viewer?: FileOpenerOverride },
    ): SecondaryPanelTab | null => {
      return openResolvedTab(
        request,
        request.kind === "browser" ? "replace-new-tab" : "open",
        options?.viewer,
      );
    },
    [openResolvedTab],
  );

  const activateTab = useCallback(
    (tabId: string) => {
      updateFixedPanelTabsState((state) =>
        activateSecondaryPanelTabInState(state, tabId),
      );
    },
    [updateFixedPanelTabsState],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      let didCloseLastTab = false;
      updateFixedPanelTabsState((state) => {
        const tabIndex = state.secondary.tabs.findIndex(
          (tab) => tab.id === tabId,
        );
        const tab = state.secondary.tabs[tabIndex];
        const next = closeSecondaryPanelTabInState(state, tabId);
        didCloseLastTab = next !== state && next.secondary.tabs.length === 0;
        if (
          next !== state &&
          recentlyClosedPanelContext !== null &&
          recentlyClosedPanelContextKey !== null &&
          tab !== undefined &&
          isReopenableSecondaryPanelTab(tab) &&
          isReopenablePanelTabOwnedByContext({
            context: recentlyClosedPanelContext,
            tab,
          })
        ) {
          rememberClosedPanelTab(recentlyClosedPanelContextKey, {
            index: tabIndex,
            tab,
          });
        }
        return next;
      });
      if (didCloseLastTab) onCloseLastTab?.();
    },
    [
      onCloseLastTab,
      recentlyClosedPanelContext,
      recentlyClosedPanelContextKey,
      updateFixedPanelTabsState,
    ],
  );

  const reopenClosedTab = useCallback((): boolean => {
    if (recentlyClosedPanelContextKey === null) return false;
    const contextKey = recentlyClosedPanelContextKey;

    const restoreEntry = (
      state: FixedPanelTabsState,
      entry: RecentlyClosedPanelTab,
    ) => {
      const index = Math.max(
        0,
        Math.min(entry.index, state.secondary.tabs.length),
      );
      const tabs = [...state.secondary.tabs];
      tabs.splice(index, 0, entry.tab);
      return setSecondaryPanelTabsInState({
        activeTabId: entry.tab.id,
        isOpen: true,
        state,
        tabs,
      });
    };

    const attemptReopen = (): boolean => {
      let didReopen = false;
      const unresolvedEntries: RecentlyClosedPanelTab[] = [];
      updateFixedPanelTabsState((state) => {
        const result = takeClosedPanelTab(
          contextKey,
          new Set(state.secondary.tabs.map((tab) => tab.id)),
          (entry) =>
            recentlyClosedPanelTabAvailability(entry.tab, storageInventory),
        );
        if (result.kind === "empty") return state;
        if (result.kind === "unresolved") {
          unresolvedEntries.push(result.entry);
          return state;
        }
        didReopen = true;
        return restoreEntry(state, result.entry);
      });
      if (didReopen) return true;
      const entry = unresolvedEntries.at(0);
      if (entry === undefined || storageFileExists === undefined) {
        return false;
      }

      const storagePath = storagePathForRecentlyClosedPanelTab(entry.tab);
      if (storagePath === null) return false;
      const validationKey = `${contextKey}:${entry.tab.id}`;
      if (pendingStorageValidationRef.current === validationKey) return true;
      pendingStorageValidationRef.current = validationKey;
      void storageFileExists(storagePath)
        .then((exists) => {
          if (
            !isMountedRef.current ||
            recentlyClosedPanelContextKeyRef.current !== contextKey ||
            pendingStorageValidationRef.current !== validationKey
          ) {
            return;
          }
          pendingStorageValidationRef.current = null;
          if (!exists) {
            const wasTop = forgetClosedPanelTab(contextKey, entry.tab.id);
            if (wasTop) attemptReopen();
            return;
          }
          updateFixedPanelTabsState((state) => {
            const result = takeClosedPanelTab(
              contextKey,
              new Set(state.secondary.tabs.map((tab) => tab.id)),
              (candidate) =>
                candidate.tab.id === entry.tab.id ? "available" : "unresolved",
            );
            return result.kind === "available"
              ? restoreEntry(state, result.entry)
              : state;
          });
        })
        .catch(() => {
          if (pendingStorageValidationRef.current === validationKey) {
            pendingStorageValidationRef.current = null;
          }
        });
      return true;
    };

    return attemptReopen();
  }, [
    recentlyClosedPanelContextKey,
    storageFileExists,
    storageInventory,
    updateFixedPanelTabsState,
  ]);

  const openPluginPanel = useCallback(
    ({ pluginId, actionId, title, paramsJson }: OpenPluginPanelArgs) => {
      const tab = createPluginPanelFixedPanelTab({
        actionId,
        paramsJson,
        pluginId,
        title,
      });
      if (recentlyClosedPanelContextKey !== null) {
        forgetClosedPanelTab(recentlyClosedPanelContextKey, tab.id);
      }
      updateFixedPanelTabsState((state) => {
        const existing = findSecondaryPanelTab(state.secondary.tabs, tab.id);
        if (existing !== null && existing.kind === "plugin-panel") {
          const withTitle =
            existing.title === title
              ? state
              : updateSecondaryPanelTabInState({
                  state,
                  tab: { ...existing, title },
                });
          return activateSecondaryPanelTabInState(withTitle, tab.id);
        }
        return replaceNewTabWithSecondaryPanelTabInState({ state, tab });
      });
    },
    [recentlyClosedPanelContextKey, updateFixedPanelTabsState],
  );

  const selectFileSearchResult = useCallback(
    (selection: FileSearchSelection) => {
      openResolvedTab(
        openRequestForFileSearchSelection(selection),
        "replace-new-tab",
      );
    },
    [openResolvedTab],
  );

  const updateBrowserTab = useCallback(
    ({ tabId, url, title }: UpdateBrowserTabArgs) => {
      updateFixedPanelTabsState((state) => {
        const tab = findSecondaryPanelTab(state.secondary.tabs, tabId);
        if (!tab || !isBrowserTab(tab)) {
          return state;
        }
        return updateSecondaryPanelTabInState({
          state,
          tab: {
            ...tab,
            title,
            url,
          },
        });
      });
    },
    [updateFixedPanelTabsState],
  );

  const clearActiveFileTabs = useCallback(() => {
    updateFixedPanelTabsState(clearActiveSecondaryFileTabInState);
  }, [updateFixedPanelTabsState]);

  const reorderTab = useCallback<SecondaryPanelTabReorderHandler>(
    (request: SecondaryPanelTabReorderRequest) => {
      updateFixedPanelTabsState((state) =>
        reorderSecondaryPanelFileTabInState({ ...request, state }),
      );
    },
    [updateFixedPanelTabsState],
  );

  const activeTab = getActiveSecondaryPanelTab(fixedPanelTabsState);
  const orderedSecondaryFileTabs = buildOrderedSecondaryPanelFileTabs({
    includeWorkspaceTabsOutsideEnvironment: preserveWorkspaceTabsAcrossContexts,
    tabs: fixedPanelTabsState.secondary.tabs,
    resolvedEnvironmentId,
  });
  const browserTabs = useMemo(
    () => fixedPanelTabsState.secondary.tabs.filter(isBrowserTab),
    [fixedPanelTabsState.secondary.tabs],
  );
  const activeWorkspaceFileTab =
    activeTab?.kind === "workspace-file-preview" &&
    (preserveWorkspaceTabsAcrossContexts ||
      activeTab.environmentId === resolvedEnvironmentId)
      ? activeTab
      : null;
  const activeStorageFileTab =
    activeTab?.kind === "thread-storage-file-preview" ? activeTab : null;
  const activeHostFileTab =
    activeTab?.kind === "host-file-preview" ? activeTab : null;
  const activeBrowserTab = activeTab?.kind === "browser" ? activeTab : null;
  const activeNewTab = activeTab?.kind === "new-tab" ? activeTab : null;
  const activePluginPanelTab =
    activeTab?.kind === "plugin-panel" ? activeTab : null;
  const activeFileOpenerOwner =
    activePluginPanelTab !== null &&
    fileOpenerIdFromActionId(activePluginPanelTab.actionId) !== null
      ? (activePluginPanelTab.fileOpenerOwner ?? null)
      : null;
  const activeFileOpenerFile =
    activeFileOpenerOwner === null || activePluginPanelTab === null
      ? null
      : parseFileOpenerParams(activePluginPanelTab.paramsJson);
  const activeWorkspaceFileOpener =
    activeFileOpenerOwner?.kind === "workspace-file-preview" &&
    activeFileOpenerFile?.source.kind === "workspace"
      ? activeFileOpenerFile
      : null;
  const activeHostFileOpener =
    activeFileOpenerOwner?.kind === "host-file-preview" &&
    activeFileOpenerFile?.source.kind === "host"
      ? activeFileOpenerFile
      : null;
  const activeStorageFileOpener =
    activeFileOpenerOwner?.kind === "thread-storage-file-preview" &&
    activeFileOpenerFile?.source.kind === "thread-storage"
      ? activeFileOpenerFile
      : null;

  return {
    activateTab,
    activeBrowserTab,
    activeFileOpenerFile,
    activeFileOpenerOwner,
    activeHostFileEnvironmentId:
      activeHostFileTab?.environmentId ??
      activeHostFileOpener?.source.environmentId ??
      null,
    activeHostFileLineRange:
      activeHostFileTab?.lineRange ??
      (activeFileOpenerOwner?.kind === "host-file-preview"
        ? activeFileOpenerOwner.tab.lineRange
        : null),
    activeHostFilePath:
      activeHostFileTab?.path ?? activeHostFileOpener?.path ?? null,
    activeHostFileThreadId:
      activeHostFileTab?.threadId ??
      activeHostFileOpener?.source.threadId ??
      null,
    activeStorageFileEnvironmentId:
      activeStorageFileTab?.environmentId ??
      activeStorageFileOpener?.source.environmentId ??
      null,
    activeStorageFileLineRange:
      activeStorageFileTab?.lineRange ??
      (activeFileOpenerOwner?.kind === "thread-storage-file-preview"
        ? activeFileOpenerOwner.tab.lineRange
        : null),
    activeStorageFilePath:
      activeStorageFileTab?.path ?? activeStorageFileOpener?.path ?? null,
    activeStorageFileThreadId:
      activeStorageFileTab?.threadId ??
      activeStorageFileOpener?.source.threadId ??
      null,
    activeWorkspaceFileLineRange:
      activeWorkspaceFileTab?.lineRange ??
      (activeFileOpenerOwner?.kind === "workspace-file-preview"
        ? activeFileOpenerOwner.tab.lineRange
        : null),
    activeWorkspaceFileEnvironmentId:
      activeWorkspaceFileTab?.environmentId ??
      activeWorkspaceFileOpener?.source.environmentId ??
      null,
    activeWorkspaceFilePath:
      activeWorkspaceFileTab?.path ?? activeWorkspaceFileOpener?.path ?? null,
    activeWorkspaceFileProjectId:
      activeWorkspaceFileTab?.projectId ??
      activeWorkspaceFileOpener?.source.projectId ??
      null,
    activePluginPanelTab,
    browserTabs,
    clearActiveFileTabs,
    closeTab,
    isNewTabActive: activeNewTab !== null,
    openPluginPanel,
    openTab,
    orderedSecondaryFileTabs,
    reopenClosedTab,
    reorderTab,
    selectFileSearchResult,
    updateBrowserTab,
  };
}
