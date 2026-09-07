import type { BbDesktopBrowserApi } from "@bb/desktop-contract";

export interface BrowserViewVisibilityCoordinator {
  show(
    tabId: string,
    syncBounds: () => void,
    options?: { focus?: boolean },
  ): void;
  hide(tabId: string): void;
  release(tabId: string): void;
}

interface BrowserViewRecord {
  environmentId: string | null;
  tabId: string;
  threadId: string;
}

interface RegisterBrowserViewArgs {
  environmentId: string | null;
  tabId: string;
  threadId: string;
}

interface DestroyPersistedBrowserViewArgs {
  desktopBrowser: BbDesktopBrowserApi;
  tabId: string;
}

interface DestroyPersistedBrowserViewsForThreadArgs {
  desktopBrowser: BbDesktopBrowserApi | null;
  threadId: string;
}

interface DestroyPersistedBrowserViewsForEnvironmentArgs {
  desktopBrowser: BbDesktopBrowserApi | null;
  environmentId: string;
}

const browserViewRecords = new Map<string, BrowserViewRecord>();

export function createBrowserViewVisibilityCoordinator(
  desktopBrowser: BbDesktopBrowserApi,
): BrowserViewVisibilityCoordinator {
  let visibleTabId: string | null = null;
  return {
    show(tabId, syncBounds, options) {
      if (visibleTabId !== null && visibleTabId !== tabId) {
        desktopBrowser.setVisible({ tabId: visibleTabId, visible: false });
      }
      visibleTabId = tabId;
      syncBounds();
      const request = { tabId, visible: true };
      if (
        options?.focus === false &&
        desktopBrowser.setVisibleWithoutFocus !== undefined
      ) {
        desktopBrowser.setVisibleWithoutFocus(request);
      } else {
        desktopBrowser.setVisible(request);
      }
    },
    hide(tabId) {
      if (visibleTabId === tabId) {
        visibleTabId = null;
      }
      desktopBrowser.setVisible({ tabId, visible: false });
    },
    release(tabId) {
      if (visibleTabId === tabId) {
        visibleTabId = null;
      }
    },
  };
}

export function registerBrowserView({
  environmentId,
  tabId,
  threadId,
}: RegisterBrowserViewArgs): void {
  browserViewRecords.set(tabId, { environmentId, tabId, threadId });
}

export function destroyPersistedBrowserView({
  desktopBrowser,
  tabId,
}: DestroyPersistedBrowserViewArgs): void {
  desktopBrowser.setVisible({ tabId, visible: false });
  desktopBrowser.detach(tabId);
  browserViewRecords.delete(tabId);
}

export function destroyPersistedBrowserViewsForThread({
  desktopBrowser,
  threadId,
}: DestroyPersistedBrowserViewsForThreadArgs): void {
  if (desktopBrowser === null) {
    return;
  }
  const records = [...browserViewRecords.values()];
  for (const record of records) {
    if (record.threadId === threadId) {
      destroyPersistedBrowserView({ desktopBrowser, tabId: record.tabId });
    }
  }
}

export function destroyPersistedBrowserViewsForEnvironment({
  desktopBrowser,
  environmentId,
}: DestroyPersistedBrowserViewsForEnvironmentArgs): void {
  if (desktopBrowser === null) {
    return;
  }
  const records = [...browserViewRecords.values()];
  for (const record of records) {
    if (record.environmentId === environmentId) {
      destroyPersistedBrowserView({ desktopBrowser, tabId: record.tabId });
    }
  }
}

export function resetBrowserViewPersistence(): void {
  browserViewRecords.clear();
}
