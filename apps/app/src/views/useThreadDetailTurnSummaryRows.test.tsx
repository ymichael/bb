// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import type { ManagerTimelineView } from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useThreadDetailTurnSummaryRows } from "./useThreadDetailTurnSummaryRows";

interface ThreadDetailTurnSummaryRowsHookProps {
  managerTimelineView: ManagerTimelineView | undefined;
  unrelatedValue: string;
}

function renderThreadDetailTurnSummaryRows({
  managerTimelineView,
}: ThreadDetailTurnSummaryRowsHookProps) {
  return useThreadDetailTurnSummaryRows({
    managerTimelineView,
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
      unrelatedValue: "initial",
    };
    const { result, rerender } = renderHook(renderThreadDetailTurnSummaryRows, {
      initialProps,
      wrapper,
    });
    const originalLoadTurnSummaryRows = result.current.handleLoadTurnSummaryRows;

    rerender({
      managerTimelineView: undefined,
      unrelatedValue: "updated",
    });

    expect(result.current.handleLoadTurnSummaryRows).toBe(
      originalLoadTurnSummaryRows,
    );
  });

  it("updates the loader callback when timeline mode changes", () => {
    const { wrapper } = createQueryClientTestHarness();
    const initialProps: ThreadDetailTurnSummaryRowsHookProps = {
      managerTimelineView: undefined,
      unrelatedValue: "initial",
    };
    const { result, rerender } = renderHook(renderThreadDetailTurnSummaryRows, {
      initialProps,
      wrapper,
    });
    const originalLoadTurnSummaryRows = result.current.handleLoadTurnSummaryRows;

    rerender({
      managerTimelineView: "standard",
      unrelatedValue: "initial",
    });

    expect(result.current.handleLoadTurnSummaryRows).not.toBe(
      originalLoadTurnSummaryRows,
    );
  });
});
