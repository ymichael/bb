import { useCallback, useEffect, useMemo, useState } from "react";

export interface TimelineExpansionState {
  isExpanded: (rowId: string) => boolean;
  toggle: (rowId: string) => void;
}

export interface UseTimelineExpansionStateOptions {
  autoExpandedRowIds: ReadonlySet<string>;
  rowIds: ReadonlySet<string>;
}

type ManualExpansionOverrides = ReadonlyMap<string, boolean>;

function pruneExpansionOverrides(
  overrides: ManualExpansionOverrides,
  rowIds: ReadonlySet<string>,
): ManualExpansionOverrides {
  let didPrune = false;
  const next = new Map<string, boolean>();
  for (const [rowId, value] of overrides) {
    if (rowIds.has(rowId)) {
      next.set(rowId, value);
    } else {
      didPrune = true;
    }
  }
  return didPrune ? next : overrides;
}

export function useTimelineExpansionState({
  autoExpandedRowIds,
  rowIds,
}: UseTimelineExpansionStateOptions): TimelineExpansionState {
  const [manualOverrides, setManualOverrides] =
    useState<ManualExpansionOverrides>(() => new Map());

  const prunedManualOverrides = useMemo(
    () => pruneExpansionOverrides(manualOverrides, rowIds),
    [manualOverrides, rowIds],
  );

  useEffect(() => {
    if (prunedManualOverrides !== manualOverrides) {
      setManualOverrides(prunedManualOverrides);
    }
  }, [manualOverrides, prunedManualOverrides]);

  const isExpanded = useCallback(
    (rowId: string) => {
      const manualOverride = prunedManualOverrides.get(rowId);
      return manualOverride ?? autoExpandedRowIds.has(rowId);
    },
    [autoExpandedRowIds, prunedManualOverrides],
  );

  const toggle = useCallback(
    (rowId: string) => {
      setManualOverrides((current) => {
        const currentOverride = current.get(rowId);
        const currentExpanded =
          currentOverride ?? autoExpandedRowIds.has(rowId);
        const next = new Map(current);
        next.set(rowId, !currentExpanded);
        return next;
      });
    },
    [autoExpandedRowIds],
  );

  return {
    isExpanded,
    toggle,
  };
}
