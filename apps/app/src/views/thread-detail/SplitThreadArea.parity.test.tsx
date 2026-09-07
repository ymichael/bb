// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import type { LayoutNode, PaneContent, SplitLayout } from "@/lib/split-layout";
import { SplitThreadArea } from "./SplitThreadArea";

vi.mock("./ThreadDetailView", () => ({
  ThreadDetailView: (props: { threadId?: string }) => (
    <div data-testid="thread-view" data-thread={props.threadId ?? "page"} />
  ),
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandContext: () => undefined,
  useAppCommandHandler: () => undefined,
  useAppCommandShortcut: () => null,
  useIndexedAppCommandHandlers: () => undefined,
  useIsAppCommandModifierHeld: () => false,
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({
    data: undefined,
    isSuccess: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/useRouteState", () => ({
  useRouteState: () => ({ projectId: "p1", threadId: "t1" }),
}));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => false,
}));

function content(threadId: string): PaneContent {
  return { kind: "thread", projectId: "p1", threadId };
}

function pane(paneId: string, threadId: string): LayoutNode {
  return { type: "pane", paneId, content: content(threadId) };
}

function renderArea(layout: SplitLayout) {
  const store = createStore();
  store.set(splitLayoutAtom, layout);
  const storedLayout = store.get(splitLayoutAtom);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = render(
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/p1/threads/t1"]}>
          <SplitThreadArea />
        </MemoryRouter>
      </QueryClientProvider>
    </Provider>,
  );
  return { ...rendered, store, storedLayout };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("SplitThreadArea single-pane parity", () => {
  it("renders the single pane with no wrapper element around the thread view", () => {
    const { container, getAllByTestId } = renderArea({
      root: pane("pane-1", "t1"),
      focusedPaneId: "pane-1",
    });
    expect(container.querySelectorAll("[data-split-pane-id]")).toHaveLength(0);
    expect(getAllByTestId("thread-view")).toHaveLength(1);
    expect(container.firstElementChild?.getAttribute("data-testid")).toBe(
      "thread-view",
    );
  });

  it("wraps each pane once the layout actually splits", () => {
    const { container } = renderArea({
      root: {
        type: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [pane("pane-1", "t1"), pane("pane-2", "t2")],
      },
      focusedPaneId: "pane-1",
    });
    expect(container.querySelectorAll("[data-split-pane-id]")).toHaveLength(2);
  });
});
