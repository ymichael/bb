import { useCallback, useEffect, useState } from "react";
import type { TimelineRow, TimelineTurnRow } from "@bb/server-contract";
import { shouldLoadNestedRows } from "./turnSummaryRowLoaderHelpers";

interface LoadTurnSummaryRowsArgs {
  id: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  includeAllEvents?: boolean;
}

interface UseTurnSummaryRowLoaderParams {
  threadId?: string;
  loadTurnSummaryRows: (
    args: LoadTurnSummaryRowsArgs,
  ) => Promise<{ rows: TimelineRow[] }>;
}

export function useTurnSummaryRowLoader({
  threadId,
  loadTurnSummaryRows,
}: UseTurnSummaryRowLoaderParams) {
  const [loadingTurnSummaryIds, setLoadingTurnSummaryIds] = useState<
    Set<string>
  >(new Set());
  const [erroredTurnSummaryIds, setErroredTurnSummaryIds] = useState<
    Set<string>
  >(new Set());
  const [turnSummaryRowsById, setTurnSummaryRowsById] = useState<
    Record<string, TimelineRow[]>
  >({});

  const handleLoadTurnSummaryRows = useCallback(
    (entry: TimelineTurnRow) => {
      const currentThreadId = threadId;

      if (
        !shouldLoadNestedRows({
          cachedRowCount: turnSummaryRowsById[entry.id]?.length ?? 0,
          inlineRowCount: entry.children?.length ?? 0,
          isLoading: loadingTurnSummaryIds.has(entry.id),
          threadId: currentThreadId,
        })
      ) {
        return;
      }
      if (!currentThreadId) {
        return;
      }

      setLoadingTurnSummaryIds((prev) => new Set(prev).add(entry.id));
      setErroredTurnSummaryIds((prev) => {
        if (!prev.has(entry.id)) return prev;
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
      void loadTurnSummaryRows({
        id: currentThreadId,
        sourceSeqStart: entry.sourceSeqStart,
        sourceSeqEnd: entry.sourceSeqEnd,
      })
        .then((response) => {
          setTurnSummaryRowsById((prev) => ({
            ...prev,
            [entry.id]: response.rows,
          }));
        })
        .catch(() => {
          setErroredTurnSummaryIds((prev) => new Set(prev).add(entry.id));
        })
        .finally(() => {
          setLoadingTurnSummaryIds((prev) => {
            const next = new Set(prev);
            next.delete(entry.id);
            return next;
          });
        });
    },
    [
      loadTurnSummaryRows,
      loadingTurnSummaryIds,
      threadId,
      turnSummaryRowsById,
    ],
  );

  useEffect(() => {
    setLoadingTurnSummaryIds(new Set());
    setErroredTurnSummaryIds(new Set());
    setTurnSummaryRowsById({});
  }, [threadId]);

  return {
    erroredTurnSummaryIds,
    handleLoadTurnSummaryRows,
    loadingTurnSummaryIds,
    turnSummaryRowsById,
  };
}
