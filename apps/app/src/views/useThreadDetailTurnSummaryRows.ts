import { useCallback } from "react";
import type { ManagerTimelineView } from "@bb/server-contract";
import { useThreadTimelineTurnSummaryDetails } from "@/hooks/queries/thread-queries";
import {
  useTurnSummaryRowLoader,
  type LoadTurnSummaryRows,
} from "./useTurnSummaryRowLoader";

interface UseThreadDetailTurnSummaryRowsArgs {
  managerTimelineView: ManagerTimelineView | undefined;
  threadId: string | undefined;
}

export function useThreadDetailTurnSummaryRows({
  managerTimelineView,
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
    threadId,
    loadTurnSummaryRows,
  });
}
