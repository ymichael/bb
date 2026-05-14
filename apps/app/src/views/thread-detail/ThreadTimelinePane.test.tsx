// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import {
  LOADING_INDICATOR_REVEAL_DELAY_MS,
  ThreadTimelinePane,
} from "./ThreadTimelinePane";

function renderLoadingTimelinePane(): RenderResult {
  return render(
    <ThreadTimelinePane
      activeThinking={null}
      footer={<div>Composer</div>}
      hasOlderTimelineRows={false}
      header={<div>Header</div>}
      hostConnectionNotice={null}
      isLoadingOlderTimelineRows={false}
      isThreadTimelinePending={true}
      timelineError={false}
      loadingTurnSummaryIds={new Set()}
      erroredTurnSummaryIds={new Set()}
      onLoadOlderRows={() => {}}
      onLoadTurnSummaryRows={() => {}}
      showOngoingIndicator={false}
      stopRequestedAt={null}
      timelineRows={[]}
      threadId="thread-1"
      threadRuntimeDisplayStatus="idle"
      turnSummaryRowsIdentity="thread-1:default"
      turnSummaryRowsById={{}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ThreadTimelinePane", () => {
  it("delays the initial thread loading placeholder", () => {
    vi.useFakeTimers();

    renderLoadingTimelinePane();

    expect(screen.queryByText("Loading thread...")).toBeNull();
    act(() => vi.advanceTimersByTime(LOADING_INDICATOR_REVEAL_DELAY_MS));
    expect(screen.getByText("Loading thread...")).toBeTruthy();
  });

  it("suppresses the initial loading placeholder when loading finishes before the reveal delay", () => {
    vi.useFakeTimers();

    const view = renderLoadingTimelinePane();

    act(() => vi.advanceTimersByTime(LOADING_INDICATOR_REVEAL_DELAY_MS - 1));
    expect(screen.queryByText("Loading thread...")).toBeNull();

    view.rerender(
      <ThreadTimelinePane
        activeThinking={null}
        footer={<div>Composer</div>}
        hasOlderTimelineRows={false}
        header={<div>Header</div>}
        hostConnectionNotice={null}
        isLoadingOlderTimelineRows={false}
        isThreadTimelinePending={false}
        timelineError={false}
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadOlderRows={() => {}}
        onLoadTurnSummaryRows={() => {}}
        showOngoingIndicator={false}
        stopRequestedAt={null}
        timelineRows={[]}
        threadId="thread-1"
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsIdentity="thread-1:default"
        turnSummaryRowsById={{}}
      />,
    );
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Loading thread...")).toBeNull();
  });

  it("shows a pending stop row when a stop has been requested", () => {
    render(
      <ThreadTimelinePane
        activeThinking={null}
        footer={<div>Composer</div>}
        hasOlderTimelineRows={false}
        header={<div>Header</div>}
        hostConnectionNotice={null}
        isLoadingOlderTimelineRows={false}
        isThreadTimelinePending={false}
        timelineError={false}
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadOlderRows={() => {}}
        onLoadTurnSummaryRows={() => {}}
        showOngoingIndicator={false}
        stopRequestedAt={123}
        timelineRows={[]}
        threadId="thread-1"
        threadRuntimeDisplayStatus="active"
        turnSummaryRowsIdentity="thread-1:default"
        turnSummaryRowsById={{}}
      />,
    );

    expect(screen.getByText("Stop requested")).toBeTruthy();
  });

  it("hides the pending stop row once the confirmed stop row is present", () => {
    const confirmedStopRow = {
      id: "thread-1:op:thread-interrupted:456",
      threadId: "thread-1",
      turnId: null,
      sourceSeqStart: 10,
      sourceSeqEnd: 10,
      startedAt: 456,
      createdAt: 456,
      kind: "system",
      systemKind: "operation",
      operationKind: "thread-interrupted",
      title: "Stopped manually",
      detail: null,
      status: "interrupted",
      completedAt: 456,
    } satisfies TimelineRow;

    render(
      <ThreadTimelinePane
        activeThinking={null}
        footer={<div>Composer</div>}
        hasOlderTimelineRows={false}
        header={<div>Header</div>}
        hostConnectionNotice={null}
        isLoadingOlderTimelineRows={false}
        isThreadTimelinePending={false}
        timelineError={false}
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadOlderRows={() => {}}
        onLoadTurnSummaryRows={() => {}}
        showOngoingIndicator={false}
        stopRequestedAt={123}
        timelineRows={[confirmedStopRow]}
        threadId="thread-1"
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsIdentity="thread-1:default"
        turnSummaryRowsById={{}}
      />,
    );

    expect(screen.queryByText("Stop requested")).toBeNull();
    expect(screen.getByText("Stopped manually")).toBeTruthy();
  });
});
