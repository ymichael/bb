import {
  areFixedPanelTabsEquivalent,
  type BrowserFixedPanelTab,
  type FixedPanelTab,
  type FixedPanelTabsState,
  type FixedPanelViewTab,
  type NewTabFixedPanelTab,
  type SecondaryFileFixedPanelTab,
  type SecondaryFixedPanelTab,
  type ThreadStorageFilePreviewFixedPanelTab,
  type WorkspaceFilePreviewFixedPanelTab,
} from "./fixed-panel-tabs-state.js";
import { arrayMove } from "./array-move.js";

interface SetSecondaryPanelTabsInStateArgs {
  activeTabId: string | null;
  isOpen: boolean;
  state: FixedPanelTabsState;
  tabs: readonly FixedPanelTab[];
}

interface OpenSecondaryPanelTabInStateArgs {
  state: FixedPanelTabsState;
  tab: FixedPanelTab;
}

interface ReplaceNewTabWithSecondaryPanelTabInStateArgs {
  state: FixedPanelTabsState;
  tab: FixedPanelTab;
}

interface UpdateSecondaryPanelTabInStateArgs {
  state: FixedPanelTabsState;
  tab: FixedPanelTab;
}

interface ReorderSecondaryPanelFileTabInStateArgs {
  activeTabId: string;
  overTabId: string;
  state: FixedPanelTabsState;
}

interface GetActiveTabIdAfterCloseArgs {
  activeTabId: string | null;
  closedTabId: string;
  tabsBeforeClose: readonly FixedPanelTab[];
  tabsAfterClose: readonly FixedPanelTab[];
}

interface BuildOrderedSecondaryPanelFileTabsArgs {
  includeWorkspaceTabsOutsideEnvironment?: boolean;
  tabs: readonly FixedPanelTab[];
  resolvedEnvironmentId: string | null | undefined;
}

interface PruneStorageTabsArgs {
  knownPaths: ReadonlySet<string>;
  tabs: readonly FixedPanelTab[];
  threadId: string | null | undefined;
}

interface ReconcileFixedPanelViewTabsInStateArgs {
  fixedTabs: readonly FixedPanelViewTab[];
  openFirstFixedTabWhenEmpty?: boolean;
  state: FixedPanelTabsState;
}

function isWorkspaceFilePreviewTab(
  tab: FixedPanelTab,
): tab is WorkspaceFilePreviewFixedPanelTab {
  return tab.kind === "workspace-file-preview";
}

function isStorageFilePreviewTab(
  tab: FixedPanelTab,
): tab is ThreadStorageFilePreviewFixedPanelTab {
  return tab.kind === "thread-storage-file-preview";
}

export function isBrowserTab(tab: FixedPanelTab): tab is BrowserFixedPanelTab {
  return tab.kind === "browser";
}

function isNewTab(tab: FixedPanelTab): tab is NewTabFixedPanelTab {
  return tab.kind === "new-tab";
}

export function isSecondaryFileTab(
  tab: FixedPanelTab,
): tab is SecondaryFileFixedPanelTab {
  switch (tab.kind) {
    case "workspace-file-preview":
    case "host-file-preview":
    case "thread-storage-file-preview":
    case "browser":
    case "terminal":
    case "new-tab":
    case "plugin-panel":
      return true;
    case "thread-info":
    case "git-diff":
    case "plugin-page-fixed":
      return false;
  }
}

export function reconcileFixedPanelViewTabsInState({
  fixedTabs,
  openFirstFixedTabWhenEmpty = false,
  state,
}: ReconcileFixedPanelViewTabsInStateArgs): FixedPanelTabsState {
  const contentTabs = state.secondary.tabs.filter(isSecondaryFileTab);
  const tabs: readonly FixedPanelTab[] = [...fixedTabs, ...contentTabs];
  const tabsAreEquivalent =
    tabs.length === state.secondary.tabs.length &&
    tabs.every((tab, index) => {
      const current = state.secondary.tabs[index];
      return current !== undefined && areFixedPanelTabsEquivalent(tab, current);
    });
  const activeTabStillExists = tabs.some(
    (tab) => tab.id === state.secondary.activeTabId,
  );
  const activeTabId = activeTabStillExists
    ? state.secondary.activeTabId
    : (fixedTabs[0]?.id ?? contentTabs[0]?.id ?? null);
  const isFirstInitialization =
    state.secondary.tabs.length === 0 &&
    state.secondary.activeTabId === null &&
    !state.secondary.isOpen;
  const isOpen =
    activeTabId !== null &&
    (state.secondary.isOpen ||
      (openFirstFixedTabWhenEmpty &&
        isFirstInitialization &&
        fixedTabs.length > 0));

  if (
    tabsAreEquivalent &&
    activeTabId === state.secondary.activeTabId &&
    isOpen === state.secondary.isOpen
  ) {
    return state;
  }
  return setSecondaryPanelTabsInState({
    activeTabId,
    isOpen,
    state,
    tabs,
  });
}

export function getActiveSecondaryPanelTab(
  state: FixedPanelTabsState,
): SecondaryFixedPanelTab | null {
  const activeTabId = state.secondary.activeTabId;
  if (activeTabId === null) {
    return null;
  }
  return (
    state.secondary.tabs.find(
      (tab): tab is SecondaryFixedPanelTab => tab.id === activeTabId,
    ) ?? null
  );
}

export function findSecondaryPanelTab(
  tabs: readonly FixedPanelTab[],
  tabId: string,
): FixedPanelTab | null {
  return tabs.find((tab) => tab.id === tabId) ?? null;
}

export function setSecondaryPanelTabsInState({
  activeTabId,
  isOpen,
  state,
  tabs,
}: SetSecondaryPanelTabsInStateArgs): FixedPanelTabsState {
  if (
    tabs === state.secondary.tabs &&
    activeTabId === state.secondary.activeTabId &&
    isOpen === state.secondary.isOpen
  ) {
    return state;
  }

  return {
    ...state,
    secondary: {
      tabs,
      activeTabId,
      isOpen,
    },
  };
}

function upsertSecondaryPanelTab(
  tabs: readonly FixedPanelTab[],
  tab: FixedPanelTab,
): readonly FixedPanelTab[] {
  const existingTabIndex = tabs.findIndex(
    (currentTab) => currentTab.id === tab.id,
  );
  if (existingTabIndex === -1) {
    return [...tabs, tab];
  }

  const existingTab = tabs[existingTabIndex];
  if (existingTab && areFixedPanelTabsEquivalent(existingTab, tab)) {
    return tabs;
  }

  return tabs.map((currentTab) =>
    currentTab.id === tab.id ? tab : currentTab,
  );
}

function removeSecondaryPanelTab(
  tabs: readonly FixedPanelTab[],
  tabId: string,
): readonly FixedPanelTab[] {
  const nextTabs = tabs.filter((tab) => tab.id !== tabId);
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

export function openSecondaryPanelTabInState({
  state,
  tab,
}: OpenSecondaryPanelTabInStateArgs): FixedPanelTabsState {
  const tabs = upsertSecondaryPanelTab(state.secondary.tabs, tab);
  if (
    tabs === state.secondary.tabs &&
    state.secondary.activeTabId === tab.id &&
    state.secondary.isOpen
  ) {
    return state;
  }
  return setSecondaryPanelTabsInState({
    activeTabId: tab.id,
    isOpen: true,
    state,
    tabs,
  });
}

export function replaceNewTabWithSecondaryPanelTabInState({
  state,
  tab,
}: ReplaceNewTabWithSecondaryPanelTabInStateArgs): FixedPanelTabsState {
  const newTab = state.secondary.tabs.find(isNewTab) ?? null;
  const tabsWithoutNewTab =
    newTab === null
      ? state.secondary.tabs
      : removeSecondaryPanelTab(state.secondary.tabs, newTab.id);
  const existingPreviewTab = tabsWithoutNewTab.find(
    (currentTab) => currentTab.id === tab.id,
  );

  if (existingPreviewTab) {
    return setSecondaryPanelTabsInState({
      activeTabId: existingPreviewTab.id,
      isOpen: true,
      state,
      tabs: tabsWithoutNewTab,
    });
  }

  const tabs =
    newTab === null
      ? upsertSecondaryPanelTab(tabsWithoutNewTab, tab)
      : state.secondary.tabs.map((currentTab) =>
          currentTab.id === newTab.id ? tab : currentTab,
        );

  return setSecondaryPanelTabsInState({
    activeTabId: tab.id,
    isOpen: true,
    state,
    tabs,
  });
}

export function updateSecondaryPanelTabInState({
  state,
  tab,
}: UpdateSecondaryPanelTabInStateArgs): FixedPanelTabsState {
  const tabs = upsertSecondaryPanelTab(state.secondary.tabs, tab);
  if (tabs === state.secondary.tabs) {
    return state;
  }
  return setSecondaryPanelTabsInState({
    activeTabId: state.secondary.activeTabId,
    isOpen: state.secondary.isOpen,
    state,
    tabs,
  });
}

export function activateSecondaryPanelTabInState(
  state: FixedPanelTabsState,
  tabId: string,
): FixedPanelTabsState {
  const tab = findSecondaryPanelTab(state.secondary.tabs, tabId);
  if (!tab) {
    return state;
  }
  if (state.secondary.activeTabId === tab.id && state.secondary.isOpen) {
    return state;
  }
  return setSecondaryPanelTabsInState({
    activeTabId: tab.id,
    isOpen: true,
    state,
    tabs: state.secondary.tabs,
  });
}

function getActiveTabIdAfterClose({
  activeTabId,
  closedTabId,
  tabsBeforeClose,
  tabsAfterClose,
}: GetActiveTabIdAfterCloseArgs): string | null {
  if (activeTabId !== closedTabId) {
    return activeTabId;
  }

  const fileTabsBeforeClose = tabsBeforeClose.filter(isSecondaryFileTab);
  const closedFileTabIndex = fileTabsBeforeClose.findIndex(
    (tab) => tab.id === closedTabId,
  );
  if (closedFileTabIndex === -1) {
    return null;
  }

  const fileTabsAfterClose = tabsAfterClose.filter(isSecondaryFileTab);
  const nextActiveTab =
    fileTabsAfterClose[closedFileTabIndex] ??
    fileTabsAfterClose[closedFileTabIndex - 1] ??
    null;
  return nextActiveTab?.id ?? null;
}

export function closeSecondaryPanelTabInState(
  state: FixedPanelTabsState,
  tabId: string,
): FixedPanelTabsState {
  const tab = findSecondaryPanelTab(state.secondary.tabs, tabId);
  if (tab === null) {
    return state;
  }
  const isClosingActiveTab = state.secondary.activeTabId === tabId;

  const tabs = removeSecondaryPanelTab(state.secondary.tabs, tabId);
  if (tabs === state.secondary.tabs) {
    return state;
  }

  if (
    isClosingActiveTab &&
    isSecondaryFileTab(tab) &&
    !tabs.some(isSecondaryFileTab)
  ) {
    const fallbackTab = tabs[0] ?? null;
    return setSecondaryPanelTabsInState({
      activeTabId: fallbackTab?.id ?? null,
      isOpen: fallbackTab !== null,
      state,
      tabs,
    });
  }

  return setSecondaryPanelTabsInState({
    activeTabId: getActiveTabIdAfterClose({
      activeTabId: state.secondary.activeTabId,
      closedTabId: tabId,
      tabsBeforeClose: state.secondary.tabs,
      tabsAfterClose: tabs,
    }),
    isOpen: state.secondary.isOpen,
    state,
    tabs,
  });
}

export function reorderSecondaryPanelFileTabInState({
  activeTabId,
  overTabId,
  state,
}: ReorderSecondaryPanelFileTabInStateArgs): FixedPanelTabsState {
  if (activeTabId === overTabId) {
    return state;
  }
  const activeIndex = state.secondary.tabs.findIndex(
    (tab) => tab.id === activeTabId && isSecondaryFileTab(tab),
  );
  const overIndex = state.secondary.tabs.findIndex(
    (tab) => tab.id === overTabId && isSecondaryFileTab(tab),
  );
  if (activeIndex === -1 || overIndex === -1) {
    return state;
  }
  return setSecondaryPanelTabsInState({
    activeTabId: state.secondary.activeTabId,
    isOpen: state.secondary.isOpen,
    state,
    tabs: arrayMove([...state.secondary.tabs], activeIndex, overIndex),
  });
}

export function clearActiveSecondaryFileTabInState(
  state: FixedPanelTabsState,
): FixedPanelTabsState {
  const activeTab = getActiveSecondaryPanelTab(state);
  if (!activeTab || !isSecondaryFileTab(activeTab)) {
    return state;
  }
  return setSecondaryPanelTabsInState({
    activeTabId: null,
    isOpen: state.secondary.isOpen,
    state,
    tabs: state.secondary.tabs,
  });
}

export function removeWorkspaceTabsForOtherEnvironments(
  tabs: readonly FixedPanelTab[],
  environmentId: string | null,
): readonly FixedPanelTab[] {
  const nextTabs = tabs.filter(
    (tab) =>
      !isWorkspaceFilePreviewTab(tab) || tab.environmentId === environmentId,
  );
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

export function pruneStorageTabs({
  knownPaths,
  tabs,
  threadId,
}: PruneStorageTabsArgs): readonly FixedPanelTab[] {
  const nextTabs = tabs.filter(
    (tab) =>
      !isStorageFilePreviewTab(tab) ||
      (tab.threadId !== null && tab.threadId !== threadId) ||
      knownPaths.has(tab.path),
  );
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

export function getActiveTabIdAfterPrune(
  tabs: readonly FixedPanelTab[],
  activeTabId: string | null,
): string | null {
  return activeTabId !== null && tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : null;
}

export function buildOrderedSecondaryPanelFileTabs({
  includeWorkspaceTabsOutsideEnvironment = false,
  tabs,
  resolvedEnvironmentId,
}: BuildOrderedSecondaryPanelFileTabsArgs): readonly SecondaryFileFixedPanelTab[] {
  const displayable: SecondaryFileFixedPanelTab[] = [];
  for (const tab of tabs) {
    switch (tab.kind) {
      case "workspace-file-preview":
        if (
          includeWorkspaceTabsOutsideEnvironment ||
          (resolvedEnvironmentId !== undefined &&
            tab.environmentId === resolvedEnvironmentId)
        ) {
          displayable.push(tab);
        }
        break;
      case "host-file-preview":
      case "browser":
      case "terminal":
      case "new-tab":
      case "thread-storage-file-preview":
      case "plugin-panel":
        displayable.push(tab);
        break;
      case "thread-info":
      case "git-diff":
      case "plugin-page-fixed":
        break;
    }
  }
  return displayable;
}
