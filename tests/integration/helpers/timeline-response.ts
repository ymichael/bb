import type {
  ThreadTimelineResponse,
  TimelineRow,
} from "@bb/server-contract";

export function timelineHasAssistantConversation(
  timeline: ThreadTimelineResponse,
): boolean {
  return flattenTimelineRows(timeline.rows).some(
    (row) => row.kind === "conversation" && row.role === "assistant",
  );
}

export function formatTimelineRowKindsForDiagnostics(
  timeline: ThreadTimelineResponse,
): string {
  return flattenTimelineRows(timeline.rows).map(formatTimelineRowKind).join(", ");
}

function flattenTimelineRows(rows: readonly TimelineRow[]): TimelineRow[] {
  const flattened: TimelineRow[] = [];
  for (const row of rows) {
    flattened.push(row);
    switch (row.kind) {
      case "turn":
        if (row.children) {
          flattened.push(...flattenTimelineRows(row.children));
        }
        break;
      case "work":
        if (row.workKind === "delegation") {
          flattened.push(...flattenTimelineRows(row.childRows));
        }
        break;
      case "conversation":
      case "system":
        break;
    }
  }
  return flattened;
}

function formatTimelineRowKind(row: TimelineRow): string {
  switch (row.kind) {
    case "conversation":
      return `conversation:${row.role}`;
    case "work":
      return `work:${row.workKind}`;
    case "turn":
      return "turn";
    case "system":
      return `system:${row.systemKind}`;
  }
}
