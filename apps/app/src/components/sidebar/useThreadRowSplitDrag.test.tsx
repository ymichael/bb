// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { countPanes, findPaneByThread, listPanes } from "@/lib/split-layout";
import type { LayoutNode, PaneContent, SplitLayout } from "@/lib/split-layout";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { useThreadRowSplitDrag } from "./useThreadRowSplitDrag";

const { navigateSpy, compactState } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  compactState: { value: false },
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => compactState.value,
}));

function content(threadId: string): PaneContent {
  return { kind: "thread", projectId: "p1", threadId };
}

function pane(paneId: string, threadId: string): LayoutNode {
  return { type: "pane", paneId, content: content(threadId) };
}

function singlePane(): SplitLayout {
  return { root: pane("pane-1", "t1"), focusedPaneId: "pane-1" };
}

function twoPanes(): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [pane("pane-1", "t1"), pane("pane-2", "t2")],
    },
    focusedPaneId: "pane-1",
  };
}

function eightPanes(): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: Array.from({ length: 8 }, () => 0.125),
      children: Array.from({ length: 8 }, (_, index) =>
        pane(`pane-${index + 1}`, `t${index + 1}`),
      ),
    },
    focusedPaneId: "pane-1",
  };
}

function renderOpenInSplit(threadId: string, layout: SplitLayout | null) {
  const store = createStore();
  store.set(splitLayoutAtom, layout);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <RouteNavigationProvider>{children}</RouteNavigationProvider>
    </Provider>
  );
  const { result } = renderHook(
    () => useThreadRowSplitDrag({ projectId: "p1", threadId, title: "Thread" }),
    { wrapper },
  );
  return {
    store,
    getOnPointerDown: () => result.current.onPointerDown,
    openInSplit: () => act(() => result.current.openInSplit()),
  };
}

describe("useThreadRowSplitDrag — openInSplit (cmd-click / context-menu entry)", () => {
  beforeEach(() => {
    navigateSpy.mockClear();
    compactState.value = false;
  });

  it("splits the focused pane to the right by default", () => {
    const { store, openInSplit } = renderOpenInSplit("t9", singlePane());
    openInSplit();
    const layout = store.get(splitLayoutAtom);
    expect(layout).not.toBeNull();
    expect(countPanes(layout!.root)).toBe(2);
    const opened = findPaneByThread(layout!.root, "p1", "t9");
    expect(opened).not.toBeNull();
    expect(listPanes(layout!.root).at(-1)?.paneId).toBe(opened?.paneId);
    expect(layout!.focusedPaneId).toBe(opened?.paneId);
    expect(navigateSpy).toHaveBeenCalledWith("/projects/p1/threads/t9");
  });

  it("focuses the existing pane instead of duplicating an already-open thread", () => {
    const { store, openInSplit } = renderOpenInSplit("t2", twoPanes());
    openInSplit();
    const layout = store.get(splitLayoutAtom);
    expect(countPanes(layout!.root)).toBe(2);
    expect(layout!.focusedPaneId).toBe("pane-2");
    expect(navigateSpy).toHaveBeenCalledWith("/projects/p1/threads/t2", {
      replace: true,
    });
  });

  it("coerces to a replace of the focused pane at the eight-pane cap", () => {
    const { store, openInSplit } = renderOpenInSplit("t9", eightPanes());
    openInSplit();
    const layout = store.get(splitLayoutAtom);
    expect(countPanes(layout!.root)).toBe(8);
    const opened = findPaneByThread(layout!.root, "p1", "t9");
    expect(opened?.paneId).toBe("pane-1");
    expect(findPaneByThread(layout!.root, "p1", "t1")).toBeNull();
    expect(navigateSpy).toHaveBeenCalledWith("/projects/p1/threads/t9");
  });

  it("plain-navigates without touching the layout on compact viewports", () => {
    compactState.value = true;
    const seeded = singlePane();
    const { store, openInSplit } = renderOpenInSplit("t9", seeded);
    openInSplit();
    expect(store.get(splitLayoutAtom)).toBe(seeded);
    expect(navigateSpy).toHaveBeenCalledWith("/projects/p1/threads/t9");
  });

  it("plain-navigates when there is no layout yet", () => {
    const { store, openInSplit } = renderOpenInSplit("t9", null);
    openInSplit();
    expect(store.get(splitLayoutAtom)).toBeNull();
    expect(navigateSpy).toHaveBeenCalledWith("/projects/p1/threads/t9");
  });
});
