const THREAD_SECONDARY_PANEL_QUERY_KEY = "secondaryPanel";
const THREAD_SECONDARY_PANEL_STORAGE_KEY = "beanbag.thread.secondaryPanel";
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

export function getThreadSecondaryPanel(search: string): ThreadSecondaryPanel | null {
  const params = new URLSearchParams(search);
  return decodeThreadSecondaryPanel(params.get(THREAD_SECONDARY_PANEL_QUERY_KEY));
}

export function getStoredThreadSecondaryPanel(): ThreadSecondaryPanel | null {
  if (typeof window === "undefined") {
    return null;
  }

  return decodeThreadSecondaryPanel(
    window.localStorage.getItem(THREAD_SECONDARY_PANEL_STORAGE_KEY),
  );
}

export function setStoredThreadSecondaryPanel(
  panel: ThreadSecondaryPanel | null,
): void {
  if (typeof window === "undefined") {
    return;
  }

  if (panel) {
    window.localStorage.setItem(THREAD_SECONDARY_PANEL_STORAGE_KEY, panel);
    return;
  }

  window.localStorage.removeItem(THREAD_SECONDARY_PANEL_STORAGE_KEY);
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
