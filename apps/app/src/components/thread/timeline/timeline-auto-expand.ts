import {
  assertNever,
  findTimelineFrontierRow,
  hasTimelineExplorationIntent,
  type ThreadTimelineViewRow,
  type TimelineViewWorkRow,
} from "@bb/thread-view";

interface CollectTimelineAutoExpandedRowIdsArgs {
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
}

export function isWorkRowExpandable(row: TimelineViewWorkRow): boolean {
  switch (row.workKind) {
    case "web-search":
    case "web-fetch":
    case "approval":
      return false;
    case "question":
      // Resolving and answered rows both carry a recorded answer in their
      // body. Pending/interrupted/expired stay title-only. Matches the
      // body-collapse rule in QuestionWorkRowBody.
      return row.lifecycle === "answered" || row.lifecycle === "resolving";
    case "command":
    case "tool":
      return !hasTimelineExplorationIntent(row);
    case "file-change":
      return true;
    case "delegation":
      return row.childRows.length > 0 || row.output.trim().length > 0;
    default:
      return assertNever(row);
  }
}

export function isRowExpandable(row: ThreadTimelineViewRow): boolean {
  switch (row.kind) {
    case "conversation":
      return false;
    case "system":
      return row.detail !== null && row.detail.trim().length > 0;
    case "bundle-summary":
    case "step-summary":
      return row.children.length > 0;
    case "turn":
      return true;
    case "work":
      return isWorkRowExpandable(row);
    default:
      return assertNever(row);
  }
}

/**
 * Bundle and step summaries whose children are all non-expandable get the
 * base max-height cap with overflow fades. Summaries that contain any
 * expandable child do not — capping then would put the child's own scroll
 * body inside a scrolling parent, which is poor UX. The expandability test
 * reuses `isWorkRowExpandable` so the cap rule and the per-row expand
 * affordance can never disagree.
 */
export function isNonExpandableSummary(
  children: readonly TimelineViewWorkRow[],
): boolean {
  return (
    children.length > 0 &&
    children.every((child) => !isWorkRowExpandable(child))
  );
}

function shouldAutoExpandFrontierRow(row: ThreadTimelineViewRow): boolean {
  if (!isRowExpandable(row)) {
    return false;
  }
  switch (row.kind) {
    case "system":
    case "bundle-summary":
      return true;
    case "work":
      return row.workKind === "delegation";
    case "conversation":
    case "step-summary":
    case "turn":
      return false;
    default:
      return assertNever(row);
  }
}

// Auto-expand rule (single rule, applied uniformly):
//
//   In an active container, find the trailing row that the agent produced
//   (skipping over user-role conversation rows — initial messages,
//   follow-ups, accepted or pending steers — since those are inputs to
//   the agent rather than events on the activity timeline). If that
//   frontier row is expandable and is a system row, bundle summary, or
//   delegation, auto-expand it. Otherwise, nothing in the container
//   auto-expands. We do not search backward past a non-qualifying
//   frontier.
//
// Active containers are the timeline's top-level row list (when the thread
// is active) and the childRows of pending delegations *inside an active
// container*. A completed delegation closes its scope, so a pending
// sub-delegation buried inside a completed parent does NOT auto-expand —
// the active scope must propagate from the top-level thread runtime down
// through every enclosing container. The rule does not apply to
// bundle-summary, step-summary, or turn-summary children — those represent
// grouped or archived work whose interior is not the current frontier.
function visitForAutoExpand(
  rows: readonly ThreadTimelineViewRow[],
  scopeActive: boolean,
  ids: Set<string>,
): void {
  if (!scopeActive) {
    return;
  }
  const frontier = findTimelineFrontierRow(rows);
  if (frontier && shouldAutoExpandFrontierRow(frontier)) {
    ids.add(frontier.id);
  }
  for (const row of rows) {
    if (
      row.kind === "work" &&
      row.workKind === "delegation" &&
      row.status === "pending"
    ) {
      visitForAutoExpand(row.childRows, true, ids);
    }
  }
}

export function collectTimelineAutoExpandedRowIds({
  rows,
  scopeActive,
}: CollectTimelineAutoExpandedRowIdsArgs): ReadonlySet<string> {
  const ids = new Set<string>();
  visitForAutoExpand(rows, scopeActive, ids);
  return ids;
}
