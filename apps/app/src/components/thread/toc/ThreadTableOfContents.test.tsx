// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadConversationOutlineItem,
  ThreadConversationOutlineResponse,
  SidebarBootstrapResponse,
  TimelineRow,
} from "@bb/server-contract";

vi.mock("@/components/ui/bottom-anchored-scroll-body.js", () => ({
  useBottomAnchoredScroll: vi.fn(),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadConversationOutline: vi.fn(),
}));

import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { useThreadConversationOutline } from "@/hooks/queries/thread-queries";
import {
  sidebarNavigationQueryKey,
  threadListQueryKey,
} from "@/hooks/queries/query-keys";
import {
  findActiveItemIds,
  selectTocRailItems,
  ThreadTableOfContents,
  type TocItem,
} from "./ThreadTableOfContents";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { makeThreadListEntry as makeThreadListEntryFixture } from "@bb/test-helpers/domain-fixtures";
import { makeThreadWithRuntime as makeThreadWithRuntimeFixture } from "@bb/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";

class ResizeObserverMock implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe: ResizeObserver["observe"] = (target) => {
    const element = target as HTMLElement;
    const paddingX =
      (Number.parseFloat(element.style.paddingLeft) || 0) +
      (Number.parseFloat(element.style.paddingRight) || 0);
    const inlineSize = Math.max(0, element.clientWidth - paddingX);
    this.callback(
      [
        {
          target,
          contentBoxSize: [{ inlineSize, blockSize: 0 }],
          contentRect: { width: inlineSize } as DOMRectReadOnly,
        } as unknown as ResizeObserverEntry,
      ],
      this,
    );
  };
  unobserve: ResizeObserver["unobserve"] = vi.fn();
  disconnect: ResizeObserver["disconnect"] = vi.fn();
}

function userConversationRow(index = 1): TimelineRow {
  return {
    id: `row_user_${index}`,
    threadId: "thr_toc_test",
    turnId: `turn_${index}`,
    sourceSeqStart: index,
    sourceSeqEnd: index,
    startedAt: index,
    createdAt: index,
    kind: "conversation",
    role: "user",
    text: `Loaded after client-side navigation ${index}`,
    attachments: null,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: {
      isGrouped: false,
      kind: "message",
      status: "accepted",
    },
    mentions: [],
  };
}

function TocHost({
  contextBoundarySeq = null,
  hasOlderTimelineRows = false,
  hostPaddingX = 0,
  hostWidth = 1_200,
  loadOlderTimelineRows = () => {},
  onNavigateToRow,
  threadId = "thr_toc_test",
  timelineRows,
}: {
  contextBoundarySeq?: number | null;
  hasOlderTimelineRows?: boolean;
  hostPaddingX?: number;
  hostWidth?: number;
  loadOlderTimelineRows?: () => void | Promise<void>;
  onNavigateToRow?: (rowId: string) => void;
  threadId?: string;
  timelineRows: readonly TimelineRow[];
}) {
  return (
    <div
      ref={(node) => {
        if (!node) return;
        Object.defineProperty(node, "clientWidth", {
          configurable: true,
          value: hostWidth,
        });
      }}
      data-scroll-overlay=""
      style={{
        paddingLeft: `${hostPaddingX}px`,
        paddingRight: `${hostPaddingX}px`,
      }}
    >
      <ThreadTableOfContents
        contextBoundarySeq={contextBoundarySeq}
        threadId={threadId}
        timelineRows={timelineRows}
        hasOlderTimelineRows={hasOlderTimelineRows}
        loadOlderTimelineRows={loadOlderTimelineRows}
        onNavigateToRow={onNavigateToRow}
      />
    </div>
  );
}

function rect({ bottom, top }: { bottom: number; top: number }): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left: 0,
    right: 100,
    toJSON: () => ({}),
    top,
    width: 100,
    x: 0,
    y: top,
  };
}

function createScrollElement({
  clientHeight,
  rows,
  scrollHeight,
  scrollTop,
}: {
  clientHeight: number;
  rows: ReadonlyArray<{ id: string; bottom: number; top: number }>;
  scrollHeight: number;
  scrollTop: number;
}): HTMLElement {
  const scrollElement = document.createElement("div");
  Object.defineProperty(scrollElement, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(scrollElement, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(scrollElement, "scrollTop", {
    configurable: true,
    value: scrollTop,
  });
  scrollElement.getBoundingClientRect = () =>
    rect({ bottom: clientHeight, top: 0 });

  for (const row of rows) {
    const rowElement = document.createElement("div");
    rowElement.dataset.timelineRowId = row.id;
    rowElement.getBoundingClientRect = vi.fn(() =>
      rect({ bottom: row.bottom, top: row.top }),
    );
    scrollElement.append(rowElement);
  }

  return scrollElement;
}

function outlineResponse(
  items: ThreadConversationOutlineItem[],
): ThreadConversationOutlineResponse {
  return { items, maxSeq: items.length };
}

function setOutline(
  items: ThreadConversationOutlineItem[] | undefined,
  maxSeq = items?.length ?? 0,
): void {
  vi.mocked(useThreadConversationOutline).mockReturnValue({
    data:
      items === undefined ? undefined : { ...outlineResponse(items), maxSeq },
  } as ReturnType<typeof useThreadConversationOutline>);
}

function timelineRowElement(id: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-timeline-row-id", id);
  return el;
}

function threadWithRuntime(
  thread: Partial<ThreadWithRuntime> = {},
): ThreadWithRuntime {
  return makeThreadWithRuntimeFixture({
    id: "thr_worker",
    projectId: "proj_toc",
    environmentId: "env_toc",
    title: null,
    titleFallback: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    ...thread,
  });
}

function threadListEntry(
  thread: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThreadListEntryFixture({
    ...threadWithRuntime(),
    environmentHostId: "host_toc",
    environmentName: "ToC environment",
    environmentBranchName: "main",
    environmentWorkspaceDisplayKind: "managed-worktree",
    ...thread,
  });
}

function sidebarNavigation(
  threads: ThreadListEntry[],
): SidebarBootstrapResponse {
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "proj_toc",
        name: "ToC project",
        createdAt: 1,
        updatedAt: 1,
        threads,
      }),
    ],
  });
}

const userItems: TocItem[] = [
  { id: "user-1", label: "First prompt", role: "user" },
  { id: "user-2", label: "Second prompt", role: "user" },
];

const agentItems: TocItem[] = [
  { id: "agent-1", label: "First response", role: "assistant" },
  { id: "agent-2", label: "Second response", role: "assistant" },
];

function manyUserItems(count: number): TocItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `user-${index + 1}`,
    label: `Question ${index + 1}`,
    role: "user",
  }));
}

let scrollElement: HTMLElement;
let scrollElementIntoView: ReturnType<typeof vi.fn>;

function openTocPanel(): void {
  const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
  if (!toc) throw new Error("Expected the thread table of contents.");
  fireEvent.mouseEnter(toc);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  scrollElement = document.createElement("div");
  scrollElementIntoView = vi.fn();
  vi.mocked(useBottomAnchoredScroll).mockReturnValue({
    getScrollElement: () => scrollElement,
    isAtBottom: false,
    scrollToBottom: vi.fn(),
    scrollElementIntoView,
    scrollElementIntoViewClampedToMaxScroll: vi.fn(),
    captureScrollAnchor: vi.fn(),
  } as unknown as ReturnType<typeof useBottomAnchoredScroll>);

  setOutline(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("selectTocRailItems", () => {
  it("caps long thread rails to evenly sampled markers", () => {
    const items = manyUserItems(50);

    const railItems = selectTocRailItems({ activeId: null, items });

    expect(railItems).toHaveLength(20);
    expect(railItems.at(0)?.id).toBe("user-1");
    expect(railItems.at(-1)?.id).toBe("user-50");
    expect(railItems.map((item) => item.id)).not.toEqual(
      items.slice(0, 20).map((item) => item.id),
    );
  });

  it("keeps the active marker when the rail is capped", () => {
    const items = manyUserItems(50);

    const railItems = selectTocRailItems({
      activeId: "user-20",
      items,
    });

    expect(railItems).toHaveLength(20);
    expect(railItems.map((item) => item.id)).toContain("user-20");
  });
});

describe("ThreadTableOfContents", () => {
  it("does not restore an outline cached before the current context boundary", async () => {
    setOutline(
      [1, 2, 3].map((index) => ({
        id: `old-${index}`,
        role: "user" as const,
        preview: `Old message ${index}`,
        attachmentSummary: null,
      })),
      5,
    );

    render(
      <TocHost
        contextBoundarySeq={10}
        timelineRows={[
          userConversationRow(10),
          userConversationRow(11),
          userConversationRow(12),
        ]}
      />,
    );
    openTocPanel();

    expect(await screen.findByText("Your messages")).not.toBeNull();
    expect(screen.queryByText("Old message 1")).toBeNull();
    expect(
      screen.getByText("Loaded after client-side navigation 10"),
    ).not.toBeNull();
  });

  it("defers the full outline request until the latest timeline is available", () => {
    const view = render(<TocHost timelineRows={[]} />);

    expect(useThreadConversationOutline).toHaveBeenLastCalledWith(
      "thr_toc_test",
      { enabled: false },
    );

    view.rerender(<TocHost timelineRows={[userConversationRow(1)]} />);

    expect(useThreadConversationOutline).toHaveBeenLastCalledWith(
      "thr_toc_test",
      { enabled: true },
    );
  });

  it("does not request the hidden outline in a compact thread pane", () => {
    render(<TocHost hostWidth={400} timelineRows={[userConversationRow(1)]} />);

    expect(useThreadConversationOutline).toHaveBeenLastCalledWith(
      "thr_toc_test",
      { enabled: false },
    );
  });

  it("does not request the outline when padding hides the TOC", () => {
    render(
      <TocHost
        hostPaddingX={12}
        hostWidth={900}
        timelineRows={[userConversationRow(1)]}
      />,
    );

    expect(useThreadConversationOutline).toHaveBeenLastCalledWith(
      "thr_toc_test",
      { enabled: false },
    );
  });

  it("requests the outline once the padded content box reaches the breakpoint", () => {
    render(
      <TocHost
        hostPaddingX={12}
        hostWidth={920}
        timelineRows={[userConversationRow(1)]}
      />,
    );

    expect(useThreadConversationOutline).toHaveBeenLastCalledWith(
      "thr_toc_test",
      { enabled: true },
    );
  });

  it("shows after timeline rows arrive following an empty initial render", async () => {
    const view = render(<TocHost timelineRows={[]} />);

    expect(screen.queryByText("Your messages")).toBeNull();

    view.rerender(
      <TocHost
        timelineRows={[
          userConversationRow(1),
          userConversationRow(2),
          userConversationRow(3),
        ]}
      />,
    );
    openTocPanel();

    expect(await screen.findByText("Your messages")).not.toBeNull();
    expect(
      screen.getByText("Loaded after client-side navigation 1"),
    ).not.toBeNull();
  });

  it("stays hidden until there are at least three user messages", () => {
    const view = render(
      <TocHost
        timelineRows={[userConversationRow(1), userConversationRow(2)]}
      />,
    );

    expect(screen.queryByText("Your messages")).toBeNull();

    view.rerender(
      <TocHost
        timelineRows={[
          userConversationRow(1),
          userConversationRow(2),
          userConversationRow(3),
        ]}
      />,
    );
    openTocPanel();

    expect(screen.queryByText("Your messages")).not.toBeNull();
  });

  it("measures fresh geometry only after scrolling settles", () => {
    vi.useFakeTimers();
    const rows = [
      userConversationRow(1),
      userConversationRow(2),
      userConversationRow(3),
    ];
    const rowElements = rows.map((row) => {
      const element = timelineRowElement(row.id);
      scrollElement.append(element);
      return element;
    });
    const positions = [
      { top: 0, bottom: 20 },
      { top: 100, bottom: 120 },
      { top: 200, bottom: 220 },
    ];
    rowElements.forEach((element, index) => {
      element.getBoundingClientRect = vi.fn(() => rect(positions[index]!));
    });
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 400 },
    });
    scrollElement.getBoundingClientRect = () => rect({ top: 0, bottom: 100 });

    render(<TocHost timelineRows={rows} />);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });

    const railTicks = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-thread-toc] [aria-hidden] > span",
        ),
      );
    expect(railTicks()[0]?.classList.contains("w-5")).toBe(true);

    act(() => {
      positions[0] = { top: -30, bottom: -10 };
      positions[1] = { top: 0, bottom: 20 };
      fireEvent.scroll(scrollElement);
      vi.advanceTimersByTime(119);
    });
    expect(railTicks()[0]?.classList.contains("w-5")).toBe(true);
    expect(railTicks()[1]?.classList.contains("w-5")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(railTicks()[0]?.classList.contains("w-5")).toBe(false);
    expect(railTicks()[1]?.classList.contains("w-5")).toBe(true);
  });

  it("opens consistently from pointer and keyboard activation and preserves focus", () => {
    render(
      <TocHost
        timelineRows={[
          userConversationRow(1),
          userConversationRow(2),
          userConversationRow(3),
        ]}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Thread table of contents",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Your messages")).toBeNull();

    const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
    if (!toc) throw new Error("Expected the thread table of contents.");
    fireEvent.mouseEnter(toc);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseLeave(toc);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    act(() => trigger.focus());
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Your messages")).not.toBeNull();

    const firstMessage = screen.getByRole("button", {
      name: "Loaded after client-side navigation 1",
    });
    act(() => firstMessage.focus());
    fireEvent.mouseLeave(toc);

    expect(document.activeElement).toBe(firstMessage);
    expect(screen.getByText("Your messages")).not.toBeNull();
  });

  it("tracks overflow when an initially closed panel opens and reopens", () => {
    render(
      <TocHost
        timelineRows={Array.from({ length: 30 }, (_, index) =>
          userConversationRow(index + 1),
        )}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Thread table of contents",
    });
    const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
    if (!toc) throw new Error("Expected the thread table of contents.");
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      }),
    );
    const flushAnimationFrames = () => {
      act(() => {
        for (const callback of animationFrames.splice(0)) callback(0);
      });
    };

    const openAndOverflow = () => {
      fireEvent.click(trigger);
      const scrollRegion = document.querySelector<HTMLElement>(
        '[id^="thread-toc-panel-"] .max-h-64',
      );
      if (!scrollRegion) throw new Error("Expected the TOC scroll region.");
      Object.defineProperties(scrollRegion, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 500 },
        scrollTop: { configurable: true, writable: true, value: 0 },
      });
      flushAnimationFrames();
      expect(
        document.querySelector('[class*="bg-gradient-to-t"]'),
      ).not.toBeNull();

      scrollRegion.scrollTop = 400;
      fireEvent.scroll(scrollRegion);
      flushAnimationFrames();
      expect(
        document.querySelector('[class*="bg-gradient-to-b"]'),
      ).not.toBeNull();
      expect(document.querySelector('[class*="bg-gradient-to-t"]')).toBeNull();
    };

    openAndOverflow();
    fireEvent.mouseLeave(toc);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    openAndOverflow();
  });

  it("renders the full conversation outline, including attachment-only labels", async () => {
    setOutline([
      {
        id: "u1",
        role: "user",
        preview: "First question",
        attachmentSummary: null,
      },
      {
        id: "a1",
        role: "assistant",
        preview: "First answer",
        attachmentSummary: null,
      },
      {
        id: "u2",
        role: "user",
        preview: "Second question",
        attachmentSummary: null,
      },
      {
        id: "u3",
        role: "user",
        preview: "",
        attachmentSummary: { imageCount: 1, fileCount: 0 },
      },
    ]);

    render(<TocHost timelineRows={[]} />);
    openTocPanel();

    expect(await screen.findByText("First question")).not.toBeNull();
    expect(screen.getByText("Second question")).not.toBeNull();
    expect(screen.getByText("Image attachment")).not.toBeNull();
    expect(screen.getByText("Agent messages")).not.toBeNull();
  });

  it("merges live timeline messages into the cached full outline", async () => {
    setOutline([
      {
        id: "row_user_1",
        role: "user",
        preview: "First cached question",
        attachmentSummary: null,
      },
      {
        id: "row_user_2",
        role: "user",
        preview: "Second cached question",
        attachmentSummary: null,
      },
      {
        id: "row_user_3",
        role: "user",
        preview: "Stale third question",
        attachmentSummary: null,
      },
    ]);

    render(
      <TocHost
        timelineRows={[userConversationRow(3), userConversationRow(4)]}
      />,
    );
    openTocPanel();

    expect(await screen.findByText("First cached question")).not.toBeNull();
    expect(
      screen.getByText("Loaded after client-side navigation 3"),
    ).not.toBeNull();
    expect(
      screen.getByText("Loaded after client-side navigation 4"),
    ).not.toBeNull();
    expect(screen.queryByText("Stale third question")).toBeNull();
  });

  it("renders an agent-to-agent message source as a thread mention", async () => {
    setOutline([
      {
        id: "u1",
        role: "user",
        preview: "First question",
        attachmentSummary: null,
      },
      {
        id: "u2",
        role: "user",
        preview:
          "[bb message from thread:thr_worker] Release bug report: the calendar is stale.",
        attachmentSummary: null,
      },
      {
        id: "u3",
        role: "user",
        preview: "Third question",
        attachmentSummary: null,
      },
    ]);

    render(<TocHost timelineRows={[]} />);
    openTocPanel();

    expect(await screen.findByText("Agent")).not.toBeNull();
    expect(
      screen.getByText("Release bug report: the calendar is stale."),
    ).not.toBeNull();
    expect(
      screen.queryByText(/\[bb message from thread:thr_worker\]/),
    ).toBeNull();
  });

  it("uses and refreshes a sender title with a nested thread mention", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const nestedThread = threadListEntry({
      id: "thr_nested",
      title: "Calendar specialist",
    });
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      sidebarNavigation([
        threadListEntry({ title: "Ask @thread:thr_nested" }),
        nestedThread,
      ]),
    );
    queryClient.setQueryData(threadListQueryKey({ archived: false }), [
      threadListEntry({ title: "Ask @thread:thr_nested" }),
      nestedThread,
    ]);
    setOutline([
      {
        id: "u1",
        role: "user",
        preview: "First question",
        attachmentSummary: null,
      },
      {
        id: "u2",
        role: "user",
        preview:
          "[bb message from thread:thr_worker] Release bug report: the calendar is stale.",
        attachmentSummary: null,
      },
      {
        id: "u3",
        role: "user",
        preview: "Third question",
        attachmentSummary: null,
      },
    ]);

    render(
      <QueryClientProvider client={queryClient}>
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map([[nestedThread.id, nestedThread]])}
        >
          <TocHost timelineRows={[]} />
        </ThreadTitleMentionResourcesProvider>
      </QueryClientProvider>,
    );
    openTocPanel();

    expect(await screen.findByText("Ask Calendar specialist")).not.toBeNull();
    expect(screen.queryByText("@thread:thr_nested")).toBeNull();

    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      sidebarNavigation([
        threadListEntry({ title: "Updated @thread:thr_nested" }),
        nestedThread,
      ]),
    );

    expect(
      await screen.findByText("Updated Calendar specialist"),
    ).not.toBeNull();
  });

  it("scrolls straight to a message already loaded in the window", async () => {
    scrollElement.appendChild(timelineRowElement("u2"));
    const loadOlder = vi.fn();
    const onNavigateToRow = vi.fn();
    setOutline([
      {
        id: "u1",
        role: "user",
        preview: "First question",
        attachmentSummary: null,
      },
      {
        id: "u2",
        role: "user",
        preview: "Loaded question",
        attachmentSummary: null,
      },
      {
        id: "u3",
        role: "user",
        preview: "Third question",
        attachmentSummary: null,
      },
    ]);

    render(
      <TocHost
        timelineRows={[]}
        hasOlderTimelineRows
        loadOlderTimelineRows={loadOlder}
        onNavigateToRow={onNavigateToRow}
      />,
    );
    openTocPanel();
    fireEvent.click(await screen.findByText("Loaded question"));

    await waitFor(() => expect(scrollElementIntoView).toHaveBeenCalledTimes(1));
    expect(onNavigateToRow).toHaveBeenCalledWith("u2");
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("auto-paginates older pages to reach an unloaded message, then scrolls to it", async () => {
    const loadOlder = vi.fn(() => {
      scrollElement.appendChild(timelineRowElement("u_old"));
    });
    setOutline([
      {
        id: "u_old",
        role: "user",
        preview: "Ancient question",
        attachmentSummary: null,
      },
      {
        id: "u2",
        role: "user",
        preview: "Second question",
        attachmentSummary: null,
      },
      {
        id: "u3",
        role: "user",
        preview: "Third question",
        attachmentSummary: null,
      },
    ]);

    render(
      <TocHost
        timelineRows={[]}
        hasOlderTimelineRows
        loadOlderTimelineRows={loadOlder}
      />,
    );
    openTocPanel();
    fireEvent.click(await screen.findByText("Ancient question"));

    await waitFor(() => expect(loadOlder).toHaveBeenCalled());
    await waitFor(() => expect(scrollElementIntoView).toHaveBeenCalled());
  });

  it("does not paginate when there are no older pages to load", async () => {
    const loadOlder = vi.fn();
    setOutline([
      {
        id: "missing",
        role: "user",
        preview: "Unreachable",
        attachmentSummary: null,
      },
      {
        id: "u2",
        role: "user",
        preview: "Second question",
        attachmentSummary: null,
      },
      {
        id: "u3",
        role: "user",
        preview: "Third question",
        attachmentSummary: null,
      },
    ]);

    render(
      <TocHost
        timelineRows={[]}
        hasOlderTimelineRows={false}
        loadOlderTimelineRows={loadOlder}
      />,
    );
    openTocPanel();
    fireEvent.click(await screen.findByText("Unreachable"));

    await waitFor(() => expect(loadOlder).not.toHaveBeenCalled());
    expect(scrollElementIntoView).not.toHaveBeenCalled();
  });

  it("tracks the conversation item nearest the viewport top away from bottom", () => {
    const scrollElement = createScrollElement({
      clientHeight: 100,
      scrollHeight: 1_000,
      scrollTop: 400,
      rows: [
        { id: "user-1", top: 10, bottom: 30 },
        { id: "agent-1", top: 35, bottom: 55 },
        { id: "user-2", top: 80, bottom: 100 },
        { id: "agent-2", top: 105, bottom: 125 },
      ],
    });

    expect(findActiveItemIds({ agentItems, scrollElement, userItems })).toEqual(
      {
        agent: "agent-1",
        user: "user-1",
      },
    );
  });

  it("ignores conversation items above the viewport", () => {
    const scrollElement = createScrollElement({
      clientHeight: 100,
      scrollHeight: 1_000,
      scrollTop: 400,
      rows: [
        { id: "user-1", top: -30, bottom: -10 },
        { id: "agent-1", top: -8, bottom: -1 },
        { id: "user-2", top: 30, bottom: 50 },
        { id: "agent-2", top: 60, bottom: 80 },
      ],
    });

    expect(findActiveItemIds({ agentItems, scrollElement, userItems })).toEqual(
      {
        agent: "agent-2",
        user: "user-2",
      },
    );
  });

  it("tracks the latest visible conversation item at the bottom", () => {
    const scrollElement = createScrollElement({
      clientHeight: 100,
      scrollHeight: 1_000,
      scrollTop: 900,
      rows: [
        { id: "user-1", top: 10, bottom: 30 },
        { id: "agent-1", top: 35, bottom: 55 },
        { id: "user-2", top: 80, bottom: 100 },
        { id: "agent-2", top: 90, bottom: 110 },
      ],
    });

    expect(findActiveItemIds({ agentItems, scrollElement, userItems })).toEqual(
      {
        agent: "agent-2",
        user: "user-2",
      },
    );
  });

  it("does not mark a role active at the bottom when that role is offscreen", () => {
    const scrollElement = createScrollElement({
      clientHeight: 100,
      scrollHeight: 1_000,
      scrollTop: 900,
      rows: [
        { id: "user-1", top: -120, bottom: -80 },
        { id: "user-2", top: -60, bottom: -20 },
        { id: "agent-2", top: 20, bottom: 90 },
      ],
    });

    expect(findActiveItemIds({ agentItems, scrollElement, userItems })).toEqual(
      {
        agent: "agent-2",
        user: null,
      },
    );
  });

  it("finds active items with logarithmic row measurements", () => {
    const allItems = Array.from({ length: 256 }, (_, index): TocItem => ({
      id: `item-${index}`,
      label: `Message ${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
    }));
    const manyUserItems = allItems.filter((item) => item.role === "user");
    const manyAgentItems = allItems.filter((item) => item.role === "assistant");
    const visibleIndex = 200;
    const scrollElement = createScrollElement({
      clientHeight: 100,
      scrollHeight: 3_000,
      scrollTop: 400,
      rows: allItems.map((item, index) => {
        const top = (index - visibleIndex) * 10;
        return { id: item.id, top, bottom: top + 10 };
      }),
    });

    expect(
      findActiveItemIds({
        agentItems: manyAgentItems,
        scrollElement,
        userItems: manyUserItems,
      }),
    ).toEqual({
      agent: "item-201",
      user: "item-200",
    });
    const rowMeasurementCount = Array.from(
      scrollElement.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
    ).reduce(
      (count, row) =>
        count + vi.mocked(row.getBoundingClientRect).mock.calls.length,
      0,
    );
    expect(rowMeasurementCount).toBeLessThanOrEqual(16);
  });
});
