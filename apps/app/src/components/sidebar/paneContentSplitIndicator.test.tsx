// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import type { LayoutNode, PaneContent, SplitLayout } from "@/lib/split-layout";
import { usePaneContentSplitIndicator } from "./paneContentSplitIndicator";

const { compactState } = vi.hoisted(() => ({
  compactState: { value: false },
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

function twoPanes(focused: string): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [pane("pane-1", "t1"), pane("pane-2", "t2")],
    },
    focusedPaneId: focused,
  };
}

function renderIndicator(threadId: string) {
  const store = createStore();
  store.set(splitLayoutAtom, twoPanes("pane-1"));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  let renders = 0;
  const target = content(threadId);
  const { result } = renderHook(
    () => {
      renders += 1;
      return usePaneContentSplitIndicator(target, true);
    },
    { wrapper },
  );
  return { store, result, renderCount: () => renders };
}

beforeEach(() => {
  compactState.value = false;
});

describe("usePaneContentSplitIndicator", () => {
  it("does not subscribe to the split layout on compact viewports", () => {
    compactState.value = true;
    const { store, result, renderCount } = renderIndicator("t1");
    expect(result.current.isOpenInSplit).toBe(false);
    const settled = renderCount();

    act(() => {
      store.set(splitLayoutAtom, twoPanes("pane-2"));
    });
    expect(renderCount()).toBe(settled);
    expect(result.current.isOpenInSplit).toBe(false);
  });

  it("follows the split layout on wide viewports", () => {
    const { store, result } = renderIndicator("t1");
    expect(result.current.isOpenInSplit).toBe(true);
    expect(result.current.miniMap?.find((slot) => slot.isMe)?.paneId).toBe(
      "pane-1",
    );
    act(() => {
      store.set(splitLayoutAtom, twoPanes("pane-2"));
    });
    expect(result.current.miniMap?.find((slot) => slot.isFocused)?.paneId).toBe(
      "pane-2",
    );
  });
});
