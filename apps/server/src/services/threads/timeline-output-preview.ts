import type { ThreadTimelineResponse, TimelineRow } from "@bb/server-contract";

export const TIMELINE_INLINE_OUTPUT_PREVIEW_THRESHOLD_CHARS = 4_000;
export const TIMELINE_INLINE_OUTPUT_PREVIEW_HEAD_CHARS = 2_000;
export const TIMELINE_INLINE_OUTPUT_PREVIEW_TAIL_CHARS = 1_000;

function buildTimelineOutputPreview(output: string): string {
  const omitted =
    output.length -
    TIMELINE_INLINE_OUTPUT_PREVIEW_HEAD_CHARS -
    TIMELINE_INLINE_OUTPUT_PREVIEW_TAIL_CHARS;
  return [
    output.slice(0, TIMELINE_INLINE_OUTPUT_PREVIEW_HEAD_CHARS),
    `\n…[${omitted.toLocaleString("en-US")} characters omitted from preview]\n`,
    output.slice(output.length - TIMELINE_INLINE_OUTPUT_PREVIEW_TAIL_CHARS),
  ].join("");
}

function previewRow(row: TimelineRow): TimelineRow {
  if (
    row.kind !== "work" ||
    (row.workKind !== "command" && row.workKind !== "tool") ||
    row.outputPreview !== undefined ||
    row.output.length <= TIMELINE_INLINE_OUTPUT_PREVIEW_THRESHOLD_CHARS
  ) {
    return row;
  }
  return {
    ...row,
    output: buildTimelineOutputPreview(row.output),
    outputPreview: { totalChars: row.output.length },
  };
}

export function previewTimelineResponseOutputs(
  response: ThreadTimelineResponse,
): ThreadTimelineResponse {
  let changed = false;
  const rows = response.rows.map((row) => {
    const previewed = previewRow(row);
    if (previewed !== row) {
      changed = true;
    }
    return previewed;
  });
  return changed ? { ...response, rows } : response;
}
