import { createContext, useContext } from "react";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";

const SIDEBAR_THREAD_SHORTCUT_TARGET_SELECTOR =
  "[data-sidebar-thread-shortcut-target]";

export const SIDEBAR_WINDOWED_NAV_ATTRIBUTE = "data-sidebar-windowed-nav";

export interface SidebarWindowedNavigationEntry {
  threadId: string;
  projectId: string;
}

export function encodeSidebarWindowedNavigationEntries(
  entries: readonly SidebarWindowedNavigationEntry[],
): string {
  return entries
    .map((entry) => `${entry.threadId}:${entry.projectId}`)
    .join(" ");
}

const MAX_SIDEBAR_THREAD_SHORTCUTS = 9;

export interface SidebarThreadShortcutTarget {
  element: HTMLAnchorElement | null;
  key: string;
  threadId: string;
  projectId: string | null;
}

export type SidebarThreadShortcutPresentation = AppShortcutPresentation;

export const EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS: ReadonlyMap<
  string,
  SidebarThreadShortcutPresentation
> = new Map();

export const SidebarThreadShortcutKeysContext = createContext<
  ReadonlyMap<string, SidebarThreadShortcutPresentation>
>(EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS);

function collectSidebarThreadTargets(
  root: HTMLElement | null,
  limit: number,
  includeWindowedPlaceholders: boolean,
): SidebarThreadShortcutTarget[] {
  if (!root) {
    return [];
  }

  const selector = includeWindowedPlaceholders
    ? `${SIDEBAR_THREAD_SHORTCUT_TARGET_SELECTOR}, [${SIDEBAR_WINDOWED_NAV_ATTRIBUTE}]`
    : SIDEBAR_THREAD_SHORTCUT_TARGET_SELECTOR;
  const elements = root.querySelectorAll<HTMLElement>(selector);
  const targets: SidebarThreadShortcutTarget[] = [];

  for (const element of elements) {
    if (element instanceof HTMLAnchorElement) {
      const threadId = element.dataset.sidebarThreadId;
      if (!threadId) {
        continue;
      }
      targets.push({
        element,
        key: String(targets.length + 1),
        threadId,
        projectId: null,
      });
    } else {
      const encoded = element.getAttribute(SIDEBAR_WINDOWED_NAV_ATTRIBUTE);
      if (!encoded) {
        continue;
      }
      for (const pair of encoded.split(" ")) {
        const separator = pair.indexOf(":");
        if (separator <= 0 || separator === pair.length - 1) {
          continue;
        }
        targets.push({
          element: null,
          key: String(targets.length + 1),
          threadId: pair.slice(0, separator),
          projectId: pair.slice(separator + 1),
        });
        if (targets.length === limit) {
          break;
        }
      }
    }
    if (targets.length === limit) {
      break;
    }
  }

  return targets;
}

export function getSidebarThreadShortcutTargets(
  root: HTMLElement | null,
): SidebarThreadShortcutTarget[] {
  return collectSidebarThreadTargets(root, MAX_SIDEBAR_THREAD_SHORTCUTS, false);
}

export function getSidebarThreadNavigationTargets(
  root: HTMLElement | null,
): SidebarThreadShortcutTarget[] {
  return collectSidebarThreadTargets(root, Number.POSITIVE_INFINITY, true);
}

export function useSidebarThreadShortcut(
  threadId: string,
): SidebarThreadShortcutPresentation | undefined {
  return useContext(SidebarThreadShortcutKeysContext).get(threadId);
}
