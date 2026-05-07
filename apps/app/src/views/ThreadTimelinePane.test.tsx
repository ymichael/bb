// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineCommandWorkRow, TimelineRow } from "@bb/server-contract";
import {
  LOADING_INDICATOR_REVEAL_DELAY_MS,
  ThreadTimelinePane,
} from "./ThreadTimelinePane";

function commandRow(): TimelineCommandWorkRow {
  return {
    id: "command-1",
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
    kind: "work",
    workKind: "command",
    status: "pending",
    callId: "command-1",
    command: "pnpm test",
    cwd: null,
    source: null,
    output: "still running",
    exitCode: null,
    completedAt: null,
    approvalStatus: null,
    activityIntents: [],
  };
}

function renderTimelinePane(rows: TimelineRow[]): HTMLElement {
  const view = render(
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
      showOngoingIndicator={true}
      timelineRows={rows}
      threadId="thread-1"
      threadRuntimeDisplayStatus="active"
      turnSummaryRowsIdentity="thread-1:default"
      turnSummaryRowsById={{}}
    />,
  );
  return view.container;
}

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
  it("keeps the working indicator attached to the rendered timeline rows", () => {
    const container = renderTimelinePane([commandRow()]);

    const timelineRowList = container.querySelector(
      '[data-timeline-row-list="top-level"]',
    );
    const timelineContainer = timelineRowList?.parentElement;

    expect(timelineContainer).toBeTruthy();
    expect(timelineContainer?.contains(screen.getByText("Working..."))).toBe(
      true,
    );
  });

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
});
