// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import type { ManagerTimelineView, TimelineRow } from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useThreadDetailTurnSummaryRows } from "./useThreadDetailTurnSummaryRows";

interface ThreadDetailTurnSummaryRowsHookProps {
  managerTimelineView: ManagerTimelineView | undefined;
  timelineRows: readonly TimelineRow[];
  unrelatedValue: string;
}

function renderThreadDetailTurnSummaryRows({
  managerTimelineView,
  timelineRows,
}: ThreadDetailTurnSummaryRowsHookProps) {
  return useThreadDetailTurnSummaryRows({
    managerTimelineView,
    timelineRows,
    threadId: "thr-1",
  });
}

afterEach(() => {
  cleanup();
});

describe("useThreadDetailTurnSummaryRows", () => {
  it("keeps the loader callback stable across unrelated rerenders", () => {
    const { wrapper } = createQueryClientTestHarness();
    const initialProps: ThreadDetailTurnSummaryRowsHookProps = {
      managerTimelineView: undefined,
      timelineRows: [],
      unrelatedValue: "initial",
    };
    const { result, rerender } = renderHook(renderThreadDetailTurnSummaryRows, {
      initialProps,
      wrapper,
    });
    const originalLoadTurnSummaryRows = result.current.handleLoadTurnSummaryRows;

    rerender({
      managerTimelineView: undefined,
      timelineRows: [],
      unrelatedValue: "updated",
    });

    expect(result.current.handleLoadTurnSummaryRows).toBe(
      originalLoadTurnSummaryRows,
    );
  });

  it("keeps the loader callback stable when timeline mode changes", () => {
    const { wrapper } = createQueryClientTestHarness();
    const initialProps: ThreadDetailTurnSummaryRowsHookProps = {
      managerTimelineView: undefined,
      timelineRows: [],
      unrelatedValue: "initial",
    };
    const { result, rerender } = renderHook(renderThreadDetailTurnSummaryRows, {
      initialProps,
      wrapper,
    });
    const originalLoadTurnSummaryRows = result.current.handleLoadTurnSummaryRows;

    rerender({
      managerTimelineView: "standard",
      timelineRows: [],
      unrelatedValue: "initial",
    });

    expect(result.current.handleLoadTurnSummaryRows).toBe(
      originalLoadTurnSummaryRows,
    );
  });
});
