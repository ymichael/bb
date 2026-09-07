// @vitest-environment jsdom

import { createStore } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import {
  closePanesForThreadsAtom,
  maximizedPaneIdAtom,
  MAXIMIZED_PANE_STORAGE_KEY,
  splitLayoutAtom,
} from "./atoms";
import { countPanes, findPaneByThread, splitPane } from "./ops";
import { serializeSplitLayout, SPLIT_LAYOUT_STORAGE_KEY } from "./persistence";
import type { SplitLayout } from "./types";

function singlePane(threadId: string): SplitLayout {
  return {
    root: {
      type: "pane",
      paneId: "pane-1",
      content: { kind: "thread", projectId: "project-1", threadId },
    },
    focusedPaneId: "pane-1",
  };
}

function twoPanes(): SplitLayout {
  return splitPane(singlePane("thread-1"), "pane-1", "right", {
    kind: "thread",
    projectId: "project-1",
    threadId: "thread-2",
  });
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function writeFromOtherTab(key: string, value: string): void {
  const previous = window.localStorage.getItem(key);
  window.localStorage.setItem(key, value);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: value,
      oldValue: previous,
      storageArea: window.localStorage,
    }),
  );
}

function hydrateLayoutOnLoad(): SplitLayout | null {
  const store = createStore();
  const unsubscribe = store.sub(splitLayoutAtom, () => {});
  const layout = store.get(splitLayoutAtom);
  unsubscribe();
  return layout;
}

describe("tab-scoped workspace state", () => {
  it("keeps this tab's panes when another tab opens a different thread", () => {
    const store = createStore();
    const unsubscribe = store.sub(splitLayoutAtom, () => {});
    store.set(splitLayoutAtom, singlePane("thread-1"));

    writeFromOtherTab(
      SPLIT_LAYOUT_STORAGE_KEY,
      serializeSplitLayout(singlePane("thread-2")),
    );

    expect(store.get(splitLayoutAtom)).toEqual(singlePane("thread-1"));
    unsubscribe();
  });

  it("keeps this tab's maximized pane when another tab maximizes a different one", () => {
    const store = createStore();
    const unsubscribe = store.sub(maximizedPaneIdAtom, () => {});
    store.set(splitLayoutAtom, twoPanes());
    store.set(maximizedPaneIdAtom, "pane-1");

    writeFromOtherTab(MAXIMIZED_PANE_STORAGE_KEY, "pane-2");

    expect(store.get(maximizedPaneIdAtom)).toBe("pane-1");
    unsubscribe();
  });

  it("seeds a new tab from the last arrangement, then reloads its own", () => {
    window.localStorage.setItem(
      SPLIT_LAYOUT_STORAGE_KEY,
      serializeSplitLayout(twoPanes()),
    );
    expect(countPanes(hydrateLayoutOnLoad()!.root)).toBe(2);

    const store = createStore();
    store.set(splitLayoutAtom, singlePane("thread-3"));
    window.localStorage.setItem(
      SPLIT_LAYOUT_STORAGE_KEY,
      serializeSplitLayout(singlePane("thread-9")),
    );

    expect(hydrateLayoutOnLoad()).toEqual(singlePane("thread-3"));
  });
});

describe("closePanesForThreadsAtom", () => {
  it("persists a maximized pane id and rejects an empty stored id", () => {
    const store = createStore();
    store.set(maximizedPaneIdAtom, "pane-2");

    expect(window.localStorage.getItem(MAXIMIZED_PANE_STORAGE_KEY)).toBe(
      "pane-2",
    );

    window.localStorage.setItem(MAXIMIZED_PANE_STORAGE_KEY, "");
    const rehydrated = createStore();
    expect(rehydrated.get(maximizedPaneIdAtom)).toBeNull();
  });

  it("closes an unfocused pane and reports the unchanged focused survivor", () => {
    const store = createStore();
    store.set(splitLayoutAtom, twoPanes());

    const result = store.set(closePanesForThreadsAtom, ["thread-1"]);

    expect(result.removedAny).toBe(true);
    expect(result.focusedRoute).toEqual({
      projectId: "project-1",
      threadId: "thread-2",
    });
    const layout = store.get(splitLayoutAtom);
    expect(countPanes(layout!.root)).toBe(1);
    expect(findPaneByThread(layout!.root, "project-1", "thread-1")).toBeNull();
  });

  it("closes the focused pane and reports the survivor the URL should follow", () => {
    const store = createStore();
    store.set(splitLayoutAtom, twoPanes());
    store.set(maximizedPaneIdAtom, "pane-2");

    const result = store.set(closePanesForThreadsAtom, ["thread-2"]);

    expect(result.removedAny).toBe(true);
    expect(result.focusedRoute).toEqual({
      projectId: "project-1",
      threadId: "thread-1",
    });
    const layout = store.get(splitLayoutAtom);
    expect(layout!.focusedPaneId).toBe("pane-1");
    expect(store.get(maximizedPaneIdAtom)).toBeNull();
  });

  it("clears the layout when every open pane is archived (no valid survivor)", () => {
    const store = createStore();
    store.set(splitLayoutAtom, twoPanes());

    const result = store.set(closePanesForThreadsAtom, [
      "thread-1",
      "thread-2",
    ]);

    expect(result.removedAny).toBe(true);
    expect(result.focusedRoute).toBeNull();
    expect(store.get(splitLayoutAtom)).toBeNull();
  });

  it("never removes the last pane, so a single pane falls through to navigation", () => {
    const store = createStore();
    const layout = singlePane("thread-1");
    store.set(splitLayoutAtom, layout);

    const result = store.set(closePanesForThreadsAtom, ["thread-1"]);

    expect(result.removedAny).toBe(false);
    expect(result.focusedRoute).toBeNull();
    expect(store.get(splitLayoutAtom)).toEqual(layout);
  });

  it("does nothing when there is no layout or no target threads", () => {
    const store = createStore();
    expect(store.set(closePanesForThreadsAtom, ["thread-1"])).toEqual({
      removedAny: false,
      focusedRoute: null,
    });

    store.set(splitLayoutAtom, twoPanes());
    expect(store.set(closePanesForThreadsAtom, [])).toEqual({
      removedAny: false,
      focusedRoute: null,
    });
    expect(countPanes(store.get(splitLayoutAtom)!.root)).toBe(2);
  });
});
