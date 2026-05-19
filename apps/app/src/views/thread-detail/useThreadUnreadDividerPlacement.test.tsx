// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import {
  useThreadUnreadDividerPlacement,
  type UseThreadUnreadDividerPlacementArgs,
} from "./useThreadUnreadDividerPlacement";

type UnreadDividerThreadState = NonNullable<
  UseThreadUnreadDividerPlacementArgs["thread"]
>;

interface ThreadUnreadTimelineHarnessProps {
  thread: UnreadDividerThreadState;
  timelineRows: TimelineRow[];
  useStandardManagerTimeline?: boolean;
}

interface ScrollMetrics {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

interface TestRect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

function expectElementBefore(firstElement: Element, secondElement: Element) {
  expect(
    firstElement.compareDocumentPosition(secondElement) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
}

function buildDomRect(rect: TestRect): DOMRect {
  return new DOMRect(rect.left, rect.top, rect.width, rect.height);
}

function setScrollMetrics(element: HTMLElement, metrics: ScrollMetrics) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  element.scrollTop = metrics.scrollTop;
}

function requireHTMLElement(element: Element | null): HTMLElement {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected HTMLElement.");
  }
  return element;
}

function ThreadUnreadTimelineHarness({
  thread,
  timelineRows,
  useStandardManagerTimeline = false,
}: ThreadUnreadTimelineHarnessProps) {
  const unreadDividerPlacement = useThreadUnreadDividerPlacement({
    routeThreadId: thread?.id,
    thread,
    useStandardManagerTimeline,
  });

  return (
    <ThreadTimelineRows
      erroredTurnSummaryIds={new Set()}
      loadingTurnSummaryIds={new Set()}
      onLoadTurnSummaryRows={() => {}}
      threadRuntimeDisplayStatus="idle"
      timelineRows={timelineRows}
      turnSummaryRowsById={{}}
      turnSummaryRowsIdentity="thread-unread-test"
      unreadDividerPlacement={unreadDividerPlacement}
      workspaceRootPath={undefined}
    />
  );
}

function ThreadUnreadScrollTimelineHarness(
  props: ThreadUnreadTimelineHarnessProps,
) {
  return (
    <BottomAnchoredScrollBody
      footer={<div />}
      maxWidthClassName="max-w-none"
      scrollAreaClassName="scroll-area"
    >
      <ThreadUnreadTimelineHarness {...props} />
    </BottomAnchoredScrollBody>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useThreadUnreadDividerPlacement", () => {
  it("re-arms when a mounted read standard thread gets a new attention epoch", async () => {
    const readThread: UnreadDividerThreadState = {
      id: "thread-1",
      lastReadAt: 1_000,
      latestAttentionAt: 1_000,
      type: "standard",
    };
    const unreadThread: UnreadDividerThreadState = {
      ...readThread,
      latestAttentionAt: 2_000,
    };
    const markedReadThread: UnreadDividerThreadState = {
      ...unreadThread,
      lastReadAt: 2_500,
    };
    const timelineRows = [
      conversationRow({
        id: "already-read-row",
        sourceSeqStart: 1_000,
        text: "Already-read thread context",
      }),
      conversationRow({
        id: "new-attention-row",
        sourceSeqStart: 2_000,
        text: "Thread update requiring attention",
      }),
    ];
    const view = render(
      <ThreadUnreadTimelineHarness
        thread={readThread}
        timelineRows={timelineRows}
      />,
    );
    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();

    view.rerender(
      <ThreadUnreadTimelineHarness
        thread={unreadThread}
        timelineRows={timelineRows}
      />,
    );

    const divider = await screen.findByRole("separator", {
      name: "New messages",
    });
    expectElementBefore(
      screen.getByText("Already-read thread context"),
      divider,
    );
    expectElementBefore(
      divider,
      screen.getByText("Thread update requiring attention"),
    );

    view.rerender(
      <ThreadUnreadTimelineHarness
        thread={markedReadThread}
        timelineRows={timelineRows}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("separator", { name: "New messages" }),
      ).not.toBeNull(),
    );
  });

  it("scrolls to the timeline bottom when the unread divider stays visible there", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.useFakeTimers();

    try {
      const unreadThread: UnreadDividerThreadState = {
        id: "thread-1",
        lastReadAt: 1_000,
        latestAttentionAt: 2_000,
        type: "standard",
      };
      const timelineRows = [
        conversationRow({
          id: "already-read-row",
          sourceSeqStart: 1_000,
          text: "Already-read thread context",
        }),
        conversationRow({
          id: "first-new-row",
          sourceSeqStart: 2_000,
          text: "First update requiring attention",
        }),
      ];

      const view = render(
        <ThreadUnreadScrollTimelineHarness
          thread={unreadThread}
          timelineRows={timelineRows}
        />,
      );
      const scrollArea = requireHTMLElement(
        view.container.querySelector(".scroll-area"),
      );
      const divider = screen.getByRole("separator", {
        name: "New messages",
      });
      setScrollMetrics(scrollArea, {
        clientHeight: 100,
        scrollHeight: 1_000,
        scrollTop: 400,
      });
      vi.spyOn(scrollArea, "getBoundingClientRect").mockReturnValue(
        buildDomRect({
          bottom: 100,
          height: 100,
          left: 0,
          right: 100,
          top: 0,
          width: 100,
        }),
      );
      vi.spyOn(divider, "getBoundingClientRect").mockReturnValue(
        buildDomRect({
          bottom: 540,
          height: 20,
          left: 0,
          right: 100,
          top: 520,
          width: 100,
        }),
      );

      await vi.runOnlyPendingTimersAsync();

      expect(scrollArea.scrollTop).toBe(900);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not remount or rescroll an existing divider during a sequential attention bump", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.useFakeTimers();

    try {
      const unreadThread: UnreadDividerThreadState = {
        id: "thread-1",
        lastReadAt: 1_000,
        latestAttentionAt: 2_000,
        type: "standard",
      };
      const bumpedUnreadThread: UnreadDividerThreadState = {
        ...unreadThread,
        latestAttentionAt: 3_000,
      };
      const timelineRows = [
        conversationRow({
          id: "already-read-row",
          sourceSeqStart: 1_000,
          text: "Already-read thread context",
        }),
        conversationRow({
          id: "first-new-row",
          sourceSeqStart: 2_000,
          text: "First update requiring attention",
        }),
        conversationRow({
          id: "second-new-row",
          sourceSeqStart: 3_000,
          text: "Second update requiring attention",
        }),
      ];

      const view = render(
        <ThreadUnreadScrollTimelineHarness
          thread={unreadThread}
          timelineRows={timelineRows}
        />,
      );
      const scrollArea = requireHTMLElement(
        view.container.querySelector(".scroll-area"),
      );
      const divider = screen.getByRole("separator", {
        name: "New messages",
      });
      setScrollMetrics(scrollArea, {
        clientHeight: 100,
        scrollHeight: 1_000,
        scrollTop: 0,
      });
      vi.spyOn(scrollArea, "getBoundingClientRect").mockReturnValue(
        buildDomRect({
          bottom: 100,
          height: 100,
          left: 0,
          right: 100,
          top: 0,
          width: 100,
        }),
      );
      vi.spyOn(divider, "getBoundingClientRect").mockReturnValue(
        buildDomRect({
          bottom: 320,
          height: 20,
          left: 0,
          right: 100,
          top: 300,
          width: 100,
        }),
      );

      await vi.runOnlyPendingTimersAsync();
      expect(scrollArea.scrollTop).toBe(300);

      view.rerender(
        <ThreadUnreadScrollTimelineHarness
          thread={bumpedUnreadThread}
          timelineRows={timelineRows}
        />,
      );

      expect(screen.getByRole("separator", { name: "New messages" })).toBe(
        divider,
      );

      await vi.runOnlyPendingTimersAsync();
      expect(scrollArea.scrollTop).toBe(300);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms when a mounted read manager thread gets a new attention epoch", async () => {
    const readThread: UnreadDividerThreadState = {
      id: "thread-1",
      lastReadAt: 1_000,
      latestAttentionAt: 1_000,
      type: "manager",
    };
    const unreadThread: UnreadDividerThreadState = {
      ...readThread,
      latestAttentionAt: 2_000,
    };
    const markedReadThread: UnreadDividerThreadState = {
      ...unreadThread,
      lastReadAt: 2_500,
    };
    const timelineRows = [
      conversationRow({
        id: "already-read-row",
        sourceSeqStart: 1_000,
        text: "Already-read manager context",
      }),
      conversationRow({
        id: "new-attention-row",
        sourceSeqStart: 2_000,
        text: "Manager update requiring attention",
      }),
    ];
    const view = render(
      <ThreadUnreadTimelineHarness
        thread={readThread}
        timelineRows={timelineRows}
      />,
    );
    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();

    view.rerender(
      <ThreadUnreadTimelineHarness
        thread={unreadThread}
        timelineRows={timelineRows}
      />,
    );

    const divider = await screen.findByRole("separator", {
      name: "New messages",
    });
    expectElementBefore(
      screen.getByText("Already-read manager context"),
      divider,
    );
    expectElementBefore(
      divider,
      screen.getByText("Manager update requiring attention"),
    );

    view.rerender(
      <ThreadUnreadTimelineHarness
        thread={markedReadThread}
        timelineRows={timelineRows}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("separator", { name: "New messages" }),
      ).not.toBeNull(),
    );
  });

  it("places the divider before the first row when lastReadAt is null", async () => {
    const markedUnreadThread: UnreadDividerThreadState = {
      id: "thread-1",
      lastReadAt: null,
      latestAttentionAt: 2_000,
      type: "manager",
    };
    render(
      <ThreadUnreadTimelineHarness
        thread={markedUnreadThread}
        timelineRows={[
          conversationRow({
            id: "first-row",
            sourceSeqStart: 1_000,
            text: "First manager timeline row",
          }),
        ]}
      />,
    );

    const divider = await screen.findByRole("separator", {
      name: "New messages",
    });
    expectElementBefore(
      divider,
      screen.getByText("First manager timeline row"),
    );
  });

  it("omits the divider for the standard manager timeline view", async () => {
    const unreadManagerThread: UnreadDividerThreadState = {
      id: "thread-1",
      lastReadAt: 1_000,
      latestAttentionAt: 2_000,
      type: "manager",
    };
    render(
      <ThreadUnreadTimelineHarness
        thread={unreadManagerThread}
        timelineRows={[
          conversationRow({
            id: "new-manager-debug-row",
            sourceSeqStart: 2_000,
            text: "Manager debug timeline row",
          }),
        ]}
        useStandardManagerTimeline
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("separator", { name: "New messages" }),
      ).toBeNull(),
    );
  });
});
