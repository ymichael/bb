import { useCallback, useMemo } from "react";
import type {
  TimelineCommandWorkRow,
  TimelineToolWorkRow,
} from "@bb/server-contract";
import { useThreadTimelineTurnSummaryDetails } from "@/hooks/queries/thread-queries";

export type TimelinePreviewableWorkRow =
  | TimelineCommandWorkRow
  | TimelineToolWorkRow;

export type TimelineWorkRowFullOutputState =
  | "complete"
  | "streaming-preview"
  | "loading"
  | "error"
  | "loaded";

export interface TimelineWorkRowFullOutput {
  output: string;
  state: TimelineWorkRowFullOutputState;
  retry: () => void;
}

export function useTimelineWorkRowFullOutput(
  row: TimelinePreviewableWorkRow,
): TimelineWorkRowFullOutput {
  const isPreview = row.outputPreview !== undefined;
  const shouldLoad =
    isPreview && row.turnId !== null && row.status !== "pending";
  const { data, isError, refetch } = useThreadTimelineTurnSummaryDetails(
    {
      sourceSeqEnd: row.sourceSeqEnd,
      sourceSeqStart: row.sourceSeqStart,
      threadId: row.threadId,
      turnId: row.turnId ?? "",
    },
    { enabled: shouldLoad, refetchOnMount: false },
  );
  const retry = useCallback((): void => {
    void refetch();
  }, [refetch]);
  const loadedOutput = useMemo((): string | null => {
    if (!shouldLoad || data === undefined) {
      return null;
    }
    const match =
      data.rows.find((candidate) => candidate.id === row.id) ??
      data.rows.find(
        (candidate) =>
          candidate.kind === "work" &&
          candidate.workKind === row.workKind &&
          candidate.callId === row.callId,
      );
    if (
      !match ||
      match.kind !== "work" ||
      (match.workKind !== "command" && match.workKind !== "tool")
    ) {
      return null;
    }
    return match.output;
  }, [data, row.callId, row.id, row.workKind, shouldLoad]);

  if (!isPreview) {
    return { output: row.output, state: "complete", retry };
  }
  if (loadedOutput !== null) {
    return { output: loadedOutput, state: "loaded", retry };
  }
  if (!shouldLoad) {
    return { output: row.output, state: "streaming-preview", retry };
  }
  if (isError || data !== undefined) {
    return { output: row.output, state: "error", retry };
  }
  return { output: row.output, state: "loading", retry };
}
