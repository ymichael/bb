import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type {
  ManagerTimelineView,
  TimelineRow,
  TimelineTurnRow,
  TimelineTurnSummaryDetailsRequest,
  TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import { shouldLoadNestedRows } from "./turnSummaryRowLoaderHelpers";

export interface LoadTurnSummaryRowsArgs
  extends TimelineTurnSummaryDetailsRequest {
  id: string;
}

export type LoadTurnSummaryRows = (
  args: LoadTurnSummaryRowsArgs,
) => Promise<TimelineTurnSummaryDetailsResponse>;

interface UseTurnSummaryRowLoaderParams {
  managerTimelineView: ManagerTimelineView | undefined;
  threadId?: string;
  timelineRows: readonly TimelineRow[];
  loadTurnSummaryRows: LoadTurnSummaryRows;
}

type TurnSummaryRowsById = Record<string, TimelineRow[]>;

interface TurnSummaryRowRange {
  sourceSeqEnd: number;
  sourceSeqStart: number;
  turnId: string;
}

type TurnSummaryRowRangesById = Record<string, TurnSummaryRowRange>;

interface TurnSummaryRequest {
  loadGeneration: number;
  range: TurnSummaryRowRange;
  rowId: string;
}

interface TurnSummaryRequestCurrentArgs {
  currentLoadGeneration: number;
  request: TurnSummaryRequest;
  visibleRangesById: TurnSummaryRowRangesById;
}

interface CollectStaleTurnSummaryRowIdsArgs {
  candidateRowIds: Iterable<string>;
  previousRangesById: TurnSummaryRowRangesById;
  visibleRangesById: TurnSummaryRowRangesById;
}

function toTurnSummaryRowRange(row: TimelineTurnRow): TurnSummaryRowRange {
  return {
    sourceSeqEnd: row.sourceSeqEnd,
    sourceSeqStart: row.sourceSeqStart,
    turnId: row.turnId,
  };
}

function isSameTurnSummaryRowRange(
  left: TurnSummaryRowRange,
  right: TurnSummaryRowRange,
): boolean {
  return (
    left.turnId === right.turnId &&
    left.sourceSeqStart === right.sourceSeqStart &&
    left.sourceSeqEnd === right.sourceSeqEnd
  );
}

function collectVisibleTurnSummaryRowRanges(
  rows: readonly TimelineRow[],
): TurnSummaryRowRangesById {
  const rangesById: TurnSummaryRowRangesById = {};

  const visitRows = (currentRows: readonly TimelineRow[]): void => {
    for (const row of currentRows) {
      if (row.kind === "turn") {
        rangesById[row.id] = toTurnSummaryRowRange(row);
        if (row.children) {
          visitRows(row.children);
        }
        continue;
      }

      if (row.kind === "work" && row.workKind === "delegation") {
        visitRows(row.childRows);
      }
    }
  };

  visitRows(rows);
  return rangesById;
}

function collectStaleTurnSummaryRowIds({
  candidateRowIds,
  previousRangesById,
  visibleRangesById,
}: CollectStaleTurnSummaryRowIdsArgs): Set<string> {
  const staleRowIds = new Set<string>();

  for (const rowId of candidateRowIds) {
    const visibleRange = visibleRangesById[rowId];
    const previousRange = previousRangesById[rowId];
    if (
      !visibleRange ||
      (previousRange &&
        !isSameTurnSummaryRowRange(previousRange, visibleRange))
    ) {
      staleRowIds.add(rowId);
    }
  }

  return staleRowIds;
}

function removeSetEntries(
  values: Set<string>,
  entriesToRemove: ReadonlySet<string>,
): Set<string> | null {
  let nextValues: Set<string> | null = null;
  for (const entry of entriesToRemove) {
    if (!values.has(entry)) {
      continue;
    }
    nextValues ??= new Set(values);
    nextValues.delete(entry);
  }
  return nextValues;
}

function removeRecordEntries<TValue>(
  valuesById: Record<string, TValue>,
  entriesToRemove: ReadonlySet<string>,
): Record<string, TValue> | null {
  let nextValuesById: Record<string, TValue> | null = null;
  for (const entry of entriesToRemove) {
    if (!(entry in valuesById)) {
      continue;
    }
    nextValuesById ??= { ...valuesById };
    delete nextValuesById[entry];
  }
  return nextValuesById;
}

function isTurnSummaryRequestCurrent({
  currentLoadGeneration,
  request,
  visibleRangesById,
}: TurnSummaryRequestCurrentArgs): boolean {
  if (currentLoadGeneration !== request.loadGeneration) {
    return false;
  }

  const visibleRange = visibleRangesById[request.rowId];
  return (
    visibleRange !== undefined &&
    isSameTurnSummaryRowRange(visibleRange, request.range)
  );
}

export function useTurnSummaryRowLoader({
  loadTurnSummaryRows,
  managerTimelineView,
  timelineRows,
  threadId,
}: UseTurnSummaryRowLoaderParams) {
  const loadGenerationRef = useRef(0);
  const loadTurnSummaryRowsRef = useRef(loadTurnSummaryRows);
  const threadIdRef = useRef(threadId);
  const visibleTurnSummaryRowRangesByIdRef =
    useRef<TurnSummaryRowRangesById>({});
  const requestedTurnSummaryRowIdsRef = useRef(new Set<string>());
  const loadingTurnSummaryIdsRef = useRef(new Set<string>());
  const erroredTurnSummaryIdsRef = useRef(new Set<string>());
  const turnSummaryRowsByIdRef = useRef<TurnSummaryRowsById>({});
  const [loadingTurnSummaryIds, setLoadingTurnSummaryIds] = useState<
    Set<string>
  >(() => new Set());
  const [erroredTurnSummaryIds, setErroredTurnSummaryIds] = useState<
    Set<string>
  >(() => new Set());
  const [turnSummaryRowsById, setTurnSummaryRowsById] =
    useState<TurnSummaryRowsById>({});

  useLayoutEffect(() => {
    loadTurnSummaryRowsRef.current = loadTurnSummaryRows;
  }, [loadTurnSummaryRows]);

  useLayoutEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  useLayoutEffect(() => {
    const visibleRangesById = collectVisibleTurnSummaryRowRanges(timelineRows);
    const staleRowIds = collectStaleTurnSummaryRowIds({
      candidateRowIds: [
        ...Object.keys(turnSummaryRowsByIdRef.current),
        ...requestedTurnSummaryRowIdsRef.current,
        ...loadingTurnSummaryIdsRef.current,
        ...erroredTurnSummaryIdsRef.current,
      ],
      previousRangesById: visibleTurnSummaryRowRangesByIdRef.current,
      visibleRangesById,
    });
    visibleTurnSummaryRowRangesByIdRef.current = visibleRangesById;

    if (staleRowIds.size === 0) {
      return;
    }

    const nextRequestedTurnSummaryRowIds = removeSetEntries(
      requestedTurnSummaryRowIdsRef.current,
      staleRowIds,
    );
    if (nextRequestedTurnSummaryRowIds) {
      requestedTurnSummaryRowIdsRef.current = nextRequestedTurnSummaryRowIds;
    }

    const nextLoadingTurnSummaryIds = removeSetEntries(
      loadingTurnSummaryIdsRef.current,
      staleRowIds,
    );
    if (nextLoadingTurnSummaryIds) {
      loadingTurnSummaryIdsRef.current = nextLoadingTurnSummaryIds;
      setLoadingTurnSummaryIds(nextLoadingTurnSummaryIds);
    }

    const nextErroredTurnSummaryIds = removeSetEntries(
      erroredTurnSummaryIdsRef.current,
      staleRowIds,
    );
    if (nextErroredTurnSummaryIds) {
      erroredTurnSummaryIdsRef.current = nextErroredTurnSummaryIds;
      setErroredTurnSummaryIds(nextErroredTurnSummaryIds);
    }

    const nextTurnSummaryRowsById = removeRecordEntries(
      turnSummaryRowsByIdRef.current,
      staleRowIds,
    );
    if (nextTurnSummaryRowsById) {
      turnSummaryRowsByIdRef.current = nextTurnSummaryRowsById;
      setTurnSummaryRowsById(nextTurnSummaryRowsById);
    }
  }, [timelineRows]);

  const handleLoadTurnSummaryRows = useCallback((entry: TimelineTurnRow) => {
    const currentThreadId = threadIdRef.current;
    const request: TurnSummaryRequest = {
      loadGeneration: loadGenerationRef.current,
      range: toTurnSummaryRowRange(entry),
      rowId: entry.id,
    };
    const requestedTurnSummaryRowIds = requestedTurnSummaryRowIdsRef.current;
    const visibleRange = visibleTurnSummaryRowRangesByIdRef.current[entry.id];

    if (
      visibleRange === undefined ||
      !isSameTurnSummaryRowRange(visibleRange, request.range) ||
      requestedTurnSummaryRowIds.has(entry.id) ||
      !shouldLoadNestedRows({
        cachedRowCount:
          turnSummaryRowsByIdRef.current[entry.id]?.length ?? 0,
        inlineRowCount: entry.children?.length ?? 0,
        isLoading: loadingTurnSummaryIdsRef.current.has(entry.id),
        threadId: currentThreadId,
      })
    ) {
      return;
    }
    if (!currentThreadId) {
      return;
    }

    requestedTurnSummaryRowIds.add(entry.id);
    const nextLoadingTurnSummaryIds = new Set(
      loadingTurnSummaryIdsRef.current,
    ).add(entry.id);
    loadingTurnSummaryIdsRef.current = nextLoadingTurnSummaryIds;
    setLoadingTurnSummaryIds(nextLoadingTurnSummaryIds);

    if (erroredTurnSummaryIdsRef.current.has(entry.id)) {
      const nextErroredTurnSummaryIds = new Set(
        erroredTurnSummaryIdsRef.current,
      );
      nextErroredTurnSummaryIds.delete(entry.id);
      erroredTurnSummaryIdsRef.current = nextErroredTurnSummaryIds;
      setErroredTurnSummaryIds(nextErroredTurnSummaryIds);
    }

    void loadTurnSummaryRowsRef
      .current({
        id: currentThreadId,
        turnId: entry.turnId,
        sourceSeqStart: entry.sourceSeqStart,
        sourceSeqEnd: entry.sourceSeqEnd,
      })
      .then((response) => {
        if (
          !isTurnSummaryRequestCurrent({
            currentLoadGeneration: loadGenerationRef.current,
            request,
            visibleRangesById: visibleTurnSummaryRowRangesByIdRef.current,
          })
        ) {
          return;
        }
        const nextTurnSummaryRowsById = {
          ...turnSummaryRowsByIdRef.current,
          [entry.id]: response.rows,
        };
        turnSummaryRowsByIdRef.current = nextTurnSummaryRowsById;
        setTurnSummaryRowsById(nextTurnSummaryRowsById);
      })
      .catch(() => {
        if (
          !isTurnSummaryRequestCurrent({
            currentLoadGeneration: loadGenerationRef.current,
            request,
            visibleRangesById: visibleTurnSummaryRowRangesByIdRef.current,
          })
        ) {
          return;
        }
        requestedTurnSummaryRowIdsRef.current.delete(entry.id);
        const nextErroredTurnSummaryIds = new Set(
          erroredTurnSummaryIdsRef.current,
        ).add(entry.id);
        erroredTurnSummaryIdsRef.current = nextErroredTurnSummaryIds;
        setErroredTurnSummaryIds(nextErroredTurnSummaryIds);
      })
      .finally(() => {
        if (
          !isTurnSummaryRequestCurrent({
            currentLoadGeneration: loadGenerationRef.current,
            request,
            visibleRangesById: visibleTurnSummaryRowRangesByIdRef.current,
          })
        ) {
          return;
        }
        const nextLoadingTurnSummaryIds = new Set(
          loadingTurnSummaryIdsRef.current,
        );
        nextLoadingTurnSummaryIds.delete(entry.id);
        loadingTurnSummaryIdsRef.current = nextLoadingTurnSummaryIds;
        setLoadingTurnSummaryIds(nextLoadingTurnSummaryIds);
      });
  }, []);

  useLayoutEffect(() => {
    loadGenerationRef.current += 1;
    requestedTurnSummaryRowIdsRef.current = new Set();
    const nextLoadingTurnSummaryIds = new Set<string>();
    const nextErroredTurnSummaryIds = new Set<string>();
    const nextTurnSummaryRowsById: TurnSummaryRowsById = {};
    loadingTurnSummaryIdsRef.current = nextLoadingTurnSummaryIds;
    erroredTurnSummaryIdsRef.current = nextErroredTurnSummaryIds;
    turnSummaryRowsByIdRef.current = nextTurnSummaryRowsById;
    setLoadingTurnSummaryIds(nextLoadingTurnSummaryIds);
    setErroredTurnSummaryIds(nextErroredTurnSummaryIds);
    setTurnSummaryRowsById(nextTurnSummaryRowsById);
  }, [managerTimelineView, threadId]);

  return {
    erroredTurnSummaryIds,
    handleLoadTurnSummaryRows,
    loadingTurnSummaryIds,
    turnSummaryRowsById,
  };
}
