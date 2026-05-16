// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import {
  useManagerUnreadDividerPlacement,
  type UseManagerUnreadDividerPlacementArgs,
} from "./useManagerUnreadDividerPlacement";

type ManagerUnreadThreadState = NonNullable<
  UseManagerUnreadDividerPlacementArgs["thread"]
>;

interface ManagerUnreadTimelineHarnessProps {
  thread: ManagerUnreadThreadState;
  timelineRows: TimelineRow[];
  useStandardManagerTimeline?: boolean;
}

function expectElementBefore(firstElement: Element, secondElement: Element) {
  expect(
    firstElement.compareDocumentPosition(secondElement) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
}

function ManagerUnreadTimelineHarness({
  thread,
  timelineRows,
  useStandardManagerTimeline = false,
}: ManagerUnreadTimelineHarnessProps) {
  const unreadDividerPlacement = useManagerUnreadDividerPlacement({
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
      turnSummaryRowsIdentity="manager-unread-test"
      unreadDividerPlacement={unreadDividerPlacement}
      workspaceRootPath={undefined}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("useManagerUnreadDividerPlacement", () => {
  it("re-arms when a mounted read manager thread gets a new attention epoch", async () => {
    const readThread: ManagerUnreadThreadState = {
      id: "thread-1",
      lastReadAt: 1_000,
      latestAttentionAt: 1_000,
      type: "manager",
    };
    const unreadThread: ManagerUnreadThreadState = {
      ...readThread,
      latestAttentionAt: 2_000,
    };
    const markedReadThread: ManagerUnreadThreadState = {
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
      <ManagerUnreadTimelineHarness
        thread={readThread}
        timelineRows={timelineRows}
      />,
    );
    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();

    view.rerender(
      <ManagerUnreadTimelineHarness
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
      <ManagerUnreadTimelineHarness
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
    const markedUnreadThread: ManagerUnreadThreadState = {
      id: "thread-1",
      lastReadAt: null,
      latestAttentionAt: 2_000,
      type: "manager",
    };
    render(
      <ManagerUnreadTimelineHarness
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
    expectElementBefore(divider, screen.getByText("First manager timeline row"));
  });
});
