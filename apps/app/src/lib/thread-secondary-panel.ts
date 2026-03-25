import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createLocalStorageSyncStorage } from "./browser-storage";

const THREAD_SECONDARY_PANEL_QUERY_KEY = "secondaryPanel";
const THREAD_SECONDARY_PANEL_STORAGE_KEY = "bb.thread.secondaryPanel";
const THREAD_DIFF_PANEL_QUERY_VALUE = "git-diff";
const THREAD_INFO_PANEL_QUERY_VALUE = "thread-info";
const THREAD_MANAGER_WORKSPACE_PANEL_QUERY_VALUE = "manager-workspace";

export type ThreadSecondaryPanel = "git-diff" | "thread-info" | "manager-workspace";

function decodeThreadSecondaryPanel(value: string | null): ThreadSecondaryPanel | null {
  switch (value) {
    case THREAD_DIFF_PANEL_QUERY_VALUE:
      return "git-diff";
    case THREAD_INFO_PANEL_QUERY_VALUE:
      return "thread-info";
    case THREAD_MANAGER_WORKSPACE_PANEL_QUERY_VALUE:
      return "manager-workspace";
    default:
      return null;
  }
}

const storedThreadSecondaryPanelBaseStorage =
  createLocalStorageSyncStorage<ThreadSecondaryPanel | null>({
    parse: (storedValue, initialValue) =>
      decodeThreadSecondaryPanel(storedValue) ?? initialValue,
    serialize: (value) => value ?? "",
  });

const storedThreadSecondaryPanelStorage = {
  getItem: storedThreadSecondaryPanelBaseStorage.getItem,
  setItem: (key: string, value: ThreadSecondaryPanel | null) => {
    if (value === null) {
      storedThreadSecondaryPanelBaseStorage.removeItem(key);
      return;
    }

    storedThreadSecondaryPanelBaseStorage.setItem(key, value);
  },
  removeItem: storedThreadSecondaryPanelBaseStorage.removeItem,
  subscribe: storedThreadSecondaryPanelBaseStorage.subscribe,
};

const storedThreadSecondaryPanelAtom = atomWithStorage<ThreadSecondaryPanel | null>(
  THREAD_SECONDARY_PANEL_STORAGE_KEY,
  null,
  storedThreadSecondaryPanelStorage,
  { getOnInit: true },
);

export function getThreadSecondaryPanel(search: string): ThreadSecondaryPanel | null {
  const params = new URLSearchParams(search);
  return decodeThreadSecondaryPanel(params.get(THREAD_SECONDARY_PANEL_QUERY_KEY));
}

export function useStoredThreadSecondaryPanel() {
  return useAtom(storedThreadSecondaryPanelAtom);
}

export function withThreadSecondaryPanel(
  search: string,
  panel: ThreadSecondaryPanel | null,
): string {
  const params = new URLSearchParams(search);
  if (panel) {
    params.set(THREAD_SECONDARY_PANEL_QUERY_KEY, panel);
  } else {
    params.delete(THREAD_SECONDARY_PANEL_QUERY_KEY);
  }
  return params.toString();
}
