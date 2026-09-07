import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  createBooleanPreferenceAtom,
  createTabScopedStorage,
  type SyncStorage,
} from "@/lib/browser-storage";
import type { ThreadRoutePathArgs } from "@/lib/route-paths";
import { findPane, listPanes, removePane } from "./ops";
import {
  deserializeSplitLayout,
  serializeSplitLayout,
  SPLIT_LAYOUT_STORAGE_KEY,
} from "./persistence";
import type { SplitLayout } from "./types";

function createSplitLayoutStorage(): SyncStorage<SplitLayout | null> {
  return createTabScopedStorage<SplitLayout | null>({
    parse: (storedValue) => deserializeSplitLayout(storedValue),
    serialize: (value) => (value === null ? "" : serializeSplitLayout(value)),
  });
}

export const splitLayoutAtom = atomWithStorage<SplitLayout | null>(
  SPLIT_LAYOUT_STORAGE_KEY,
  null,
  createSplitLayoutStorage(),
  { getOnInit: true },
);

export const MAXIMIZED_PANE_STORAGE_KEY = "bb.splitLayout.maximizedPaneId";

export const maximizedPaneIdAtom = atomWithStorage<string | null>(
  MAXIMIZED_PANE_STORAGE_KEY,
  null,
  createTabScopedStorage<string | null>({
    parse: (storedValue, initialValue) =>
      storedValue !== null && storedValue.length > 0
        ? storedValue
        : initialValue,
    serialize: (value) => value ?? "",
  }),
  { getOnInit: true },
);

export const DIM_INACTIVE_SPLITS_STORAGE_KEY =
  "bb.splitLayout.dimInactiveSplits";

export const dimInactiveSplitsAtom = createBooleanPreferenceAtom(
  DIM_INACTIVE_SPLITS_STORAGE_KEY,
  true,
);

export interface ClosePanesForThreadsResult {
  removedAny: boolean;
  focusedRoute: ThreadRoutePathArgs | null;
}

export const closePanesForThreadsAtom = atom(
  null,
  (get, set, threadIds: readonly string[]): ClosePanesForThreadsResult => {
    const current = get(splitLayoutAtom);
    if (current === null || threadIds.length === 0) {
      return { removedAny: false, focusedRoute: null };
    }
    const targets = new Set(threadIds);
    let layout = current;
    let removedAny = false;
    for (;;) {
      const pane = listPanes(layout.root).find(
        (candidate) =>
          candidate.content.kind === "thread" &&
          targets.has(candidate.content.threadId),
      );
      if (pane === undefined) {
        break;
      }
      const next = removePane(layout, pane.paneId);
      if (next === layout) {
        break;
      }
      layout = next;
      removedAny = true;
    }
    if (!removedAny) {
      return { removedAny: false, focusedRoute: null };
    }
    const maximizedPaneId = get(maximizedPaneIdAtom);
    if (
      maximizedPaneId !== null &&
      (listPanes(layout.root).length < 2 ||
        findPane(layout.root, maximizedPaneId) === null)
    ) {
      set(maximizedPaneIdAtom, null);
    }
    const focused = findPane(layout.root, layout.focusedPaneId);
    const survivorRoute =
      focused !== null &&
      focused.content.kind === "thread" &&
      !targets.has(focused.content.threadId)
        ? {
            projectId: focused.content.projectId,
            threadId: focused.content.threadId,
          }
        : null;
    if (survivorRoute === null) {
      set(splitLayoutAtom, null);
      set(maximizedPaneIdAtom, null);
      return { removedAny: true, focusedRoute: null };
    }
    set(splitLayoutAtom, layout);
    return { removedAny: true, focusedRoute: survivorRoute };
  },
);
