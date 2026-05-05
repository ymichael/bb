import { useCallback } from "react";
import type { ManagerTimelineView, TimelineRow } from "@bb/server-contract";
import { useThreadTimelineTurnSummaryDetails } from "@/hooks/queries/thread-queries";
import {
  useTurnSummaryRowLoader,
  type LoadTurnSummaryRows,
} from "./useTurnSummaryRowLoader";

interface UseThreadDetailTurnSummaryRowsArgs {
  managerTimelineView: ManagerTimelineView | undefined;
  timelineRows: readonly TimelineRow[];
  threadId: string | undefined;
}

export function useThreadDetailTurnSummaryRows({
  managerTimelineView,
  timelineRows,
  threadId,
}: UseThreadDetailTurnSummaryRowsArgs) {
  const { mutateAsync: loadTimelineTurnSummaryDetails } =
    useThreadTimelineTurnSummaryDetails();
  const loadTurnSummaryRows = useCallback<LoadTurnSummaryRows>(
    (args) =>
      loadTimelineTurnSummaryDetails({
        ...args,
        managerTimelineView,
      }),
    [loadTimelineTurnSummaryDetails, managerTimelineView],
  );

  return useTurnSummaryRowLoader({
    managerTimelineView,
    timelineRows,
    threadId,
    loadTurnSummaryRows,
  });
}
