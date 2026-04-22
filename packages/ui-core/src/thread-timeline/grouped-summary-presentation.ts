import type { TimelineRow } from "@bb/domain";

export function shouldDeEmphasizeGroupedSummary(row: TimelineRow): boolean {
  if (row.kind === "assistant-step-summary") {
    return true;
  }

  return (
    row.kind === "tool-bundle" &&
    row.presentation === "assistant-step-summary-placeholder"
  );
}
