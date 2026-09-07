import type {
  TimelinePaginationCursor,
  TimelineRow,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";

export type ThreadTimelinePageKind = "latest" | "older";

export interface TimelineSequenceWindowStart {
  kind: "byte" | "event";
  sequenceStart: number;
  threadId: string;
}

const SEQUENCE_CURSOR_ANCHOR_ID_SEPARATOR = ":in-turn:";
const BYTE_CURSOR_ANCHOR_ID_SEPARATOR = ":byte-window:";

function buildSequenceCursorAnchorId(
  args: TimelineSequenceWindowStart,
): string {
  const separator =
    args.kind === "byte"
      ? BYTE_CURSOR_ANCHOR_ID_SEPARATOR
      : SEQUENCE_CURSOR_ANCHOR_ID_SEPARATOR;
  return `${args.threadId}${separator}${args.sequenceStart}`;
}

export function readSequenceCursor(
  cursor: TimelinePaginationCursor,
  threadId: string,
): Pick<TimelineSequenceWindowStart, "kind" | "sequenceStart"> | null {
  const eventPrefix = `${threadId}${SEQUENCE_CURSOR_ANCHOR_ID_SEPARATOR}`;
  const bytePrefix = `${threadId}${BYTE_CURSOR_ANCHOR_ID_SEPARATOR}`;
  const kind = cursor.anchorId.startsWith(bytePrefix) ? "byte" : "event";
  const prefix = kind === "byte" ? bytePrefix : eventPrefix;
  if (!cursor.anchorId.startsWith(prefix)) {
    return null;
  }
  if (
    cursor.anchorId.slice(prefix.length) !== String(cursor.anchorSeq) ||
    !Number.isInteger(cursor.anchorSeq)
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "Timeline pagination cursor is no longer available",
    );
  }
  return { kind, sequenceStart: cursor.anchorSeq };
}

interface LatestThreadTimelinePageRequest {
  kind: "latest";
  segmentLimit: number;
}

interface OlderThreadTimelinePageRequest {
  beforeCursor: TimelinePaginationCursor;
  kind: "older";
  segmentLimit: number;
}

export type ThreadTimelinePageRequest =
  | LatestThreadTimelinePageRequest
  | OlderThreadTimelinePageRequest;

interface TimelineLogicalSegment {
  cursor: TimelinePaginationCursor;
  rows: TimelineRow[];
}

interface PaginatedTimelineRowsResult {
  hasOlderRows: boolean;
  olderCursor: TimelinePaginationCursor | null;
  returnedSegmentCount: number;
  rows: TimelineRow[];
}

function isTimelineSegmentAnchorRow(
  row: TimelineRow,
  contextBoundarySeq: number | null,
): boolean {
  return (
    row.sourceSeqStart === contextBoundarySeq ||
    (row.kind === "conversation" &&
      row.role === "user" &&
      row.turnRequest.kind === "message")
  );
}

function buildTimelineLogicalSegment(
  rows: TimelineRow[],
): TimelineLogicalSegment {
  const anchorRow = rows[0];
  if (!anchorRow) {
    throw new Error("Cannot build a timeline segment without rows");
  }

  return {
    cursor: {
      anchorSeq: anchorRow.sourceSeqStart,
      anchorId: anchorRow.id,
    },
    rows,
  };
}

function buildTimelineLogicalSegments(
  rows: readonly TimelineRow[],
  contextBoundarySeq: number | null,
): TimelineLogicalSegment[] {
  const segments: TimelineLogicalSegment[] = [];
  let currentRows: TimelineRow[] = [];

  for (const row of rows) {
    if (
      isTimelineSegmentAnchorRow(row, contextBoundarySeq) &&
      currentRows.length > 0 &&
      currentRows[0]?.sourceSeqStart !== row.sourceSeqStart
    ) {
      segments.push(buildTimelineLogicalSegment(currentRows));
      currentRows = [row];
      continue;
    }

    currentRows.push(row);
  }

  if (currentRows.length > 0) {
    segments.push(buildTimelineLogicalSegment(currentRows));
  }

  return segments;
}

interface PaginateTimelineRowsArgs {
  contextBoundarySeq: number | null;
  sequenceWindowStart: TimelineSequenceWindowStart | null;
  knownHasOlderSegments: boolean | null;
  page: ThreadTimelinePageRequest;
  rows: readonly TimelineRow[];
}

export function paginateTimelineRows(
  args: PaginateTimelineRowsArgs,
): PaginatedTimelineRowsResult {
  const {
    contextBoundarySeq,
    knownHasOlderSegments,
    page,
    rows,
    sequenceWindowStart,
  } = args;
  const segments = buildTimelineLogicalSegments(rows, contextBoundarySeq);
  if (sequenceWindowStart !== null) {
    return {
      hasOlderRows: true,
      olderCursor: {
        anchorSeq: sequenceWindowStart.sequenceStart,
        anchorId: buildSequenceCursorAnchorId(sequenceWindowStart),
      },
      returnedSegmentCount: segments.length,
      rows: [...rows],
    };
  }
  const selectedSegments = segments.slice(-page.segmentLimit);
  const hasOlderRows =
    knownHasOlderSegments ?? segments.length > selectedSegments.length;
  const oldestSelectedSegment = selectedSegments[0];

  return {
    hasOlderRows,
    olderCursor:
      hasOlderRows && oldestSelectedSegment
        ? oldestSelectedSegment.cursor
        : null,
    returnedSegmentCount: selectedSegments.length,
    rows: selectedSegments.flatMap((segment) => segment.rows),
  };
}
