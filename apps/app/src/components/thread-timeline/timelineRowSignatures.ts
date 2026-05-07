import type { TimelineActivityIntent } from "@bb/server-contract";
import {
  assertNever,
  type ThreadTimelineViewRow,
  type TimelineViewWorkRow,
} from "@bb/thread-view";

type TimelineRowSignaturePart = boolean | number | string | null | undefined;

function signaturePart(value: TimelineRowSignaturePart): string {
  if (value === null) return "<null>";
  if (value === undefined) return "<undefined>";
  return String(value);
}

export function joinSignatureParts(
  parts: readonly TimelineRowSignaturePart[],
): string {
  return parts.map(signaturePart).join("\u001f");
}

function activityIntentSignature(intent: TimelineActivityIntent): string {
  switch (intent.type) {
    case "read":
      return joinSignatureParts([
        intent.type,
        intent.command,
        intent.name,
        intent.path,
      ]);
    case "list_files":
      return joinSignatureParts([intent.type, intent.command, intent.path]);
    case "search":
      return joinSignatureParts([
        intent.type,
        intent.command,
        intent.query,
        intent.path,
      ]);
    case "unknown":
      return joinSignatureParts([intent.type, intent.command]);
    default:
      return assertNever(intent);
  }
}

function activityIntentsSignature(
  intents: readonly TimelineActivityIntent[],
): string {
  return intents.map(activityIntentSignature).join("\u001e");
}

// View rows are immutable — `useTimelineViewRowsCache` preserves row identity
// across renders for unchanged data — so signature computation is safe to
// memoize by row reference. A miss is the streaming-update path (new row);
// a hit covers all cross-render reuse, including duplicate invocations from
// `areTimelineRowViewPropsEqual`, `useTimelineRowTitleRenderState`, and
// `TimelineExpandableBody`'s `contentKey`.
const rowSignatureCache = new WeakMap<ThreadTimelineViewRow, string>();
const rowsSignatureCache = new WeakMap<
  readonly ThreadTimelineViewRow[],
  string
>();

export function timelineRowsSignature(
  rows: readonly ThreadTimelineViewRow[],
): string {
  const cached = rowsSignatureCache.get(rows);
  if (cached !== undefined) return cached;
  const signature = rows.map(timelineRowRenderSignature).join("\u001e");
  rowsSignatureCache.set(rows, signature);
  return signature;
}

function timelineRowBaseSignature(row: ThreadTimelineViewRow): string {
  // sourceSeqEnd guards high-mutation fields omitted from signatures below,
  // including output, text, and diffs. In-place row content mutations must
  // advance the source sequence to avoid stale memoized UI.
  return joinSignatureParts([
    row.kind,
    row.id,
    row.threadId,
    row.turnId,
    row.sourceSeqStart,
    row.sourceSeqEnd,
    row.startedAt,
    row.createdAt,
  ]);
}

function timelineWorkRowRenderSignature(row: TimelineViewWorkRow): string {
  const baseParts: TimelineRowSignaturePart[] = [
    timelineRowBaseSignature(row),
    row.status,
    row.workKind,
    row.inClosedStep,
  ];

  switch (row.workKind) {
    case "command":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.command,
        row.source,
        row.exitCode,
        row.completedAt,
        row.approvalStatus,
        activityIntentsSignature(row.activityIntents),
      ]);
    case "tool":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.toolName,
        row.label,
        row.completedAt,
        row.approvalStatus,
        activityIntentsSignature(row.activityIntents),
      ]);
    case "file-change":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.approvalStatus,
        row.change.kind,
        row.change.path,
        row.change.movePath,
        row.change.diffStats.added,
        row.change.diffStats.removed,
      ]);
    case "web-search":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.queries.join("\u001e"),
        row.completedAt,
      ]);
    case "web-fetch":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.url,
        row.prompt,
        row.pattern,
        row.completedAt,
      ]);
    case "delegation":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.toolName,
        row.subagentType,
        row.description,
        row.completedAt,
        timelineRowsSignature(row.childRows),
      ]);
    case "approval":
      return joinSignatureParts([
        ...baseParts,
        row.interactionId,
        row.approvalKind,
        row.lifecycle,
        row.approvalKind === "permission-grant" ? row.grantScope : null,
        row.approvalKind === "permission-grant" ? row.statusReason : null,
        row.target.itemId,
        row.target.toolName,
      ]);
    default:
      return assertNever(row);
  }
}

export function timelineRowRenderSignature(row: ThreadTimelineViewRow): string {
  const cached = rowSignatureCache.get(row);
  if (cached !== undefined) return cached;
  const signature = computeTimelineRowRenderSignature(row);
  rowSignatureCache.set(row, signature);
  return signature;
}

function computeTimelineRowRenderSignature(row: ThreadTimelineViewRow): string {
  const baseSignature = timelineRowBaseSignature(row);
  switch (row.kind) {
    case "conversation":
      return joinSignatureParts([
        baseSignature,
        row.role,
        row.userRequest?.kind,
        row.userRequest?.status,
        row.attachments?.localFiles,
        row.attachments?.localImages,
        row.attachments?.webImages,
      ]);
    case "system":
      if (row.systemKind === "operation") {
        return joinSignatureParts([
          baseSignature,
          row.status,
          row.systemKind,
          row.operationKind,
          row.operationKind === "manager-assignment"
            ? row.managerAssignment.action
            : null,
          row.operationKind === "manager-assignment"
            ? row.managerAssignment.details
            : null,
          row.title,
          row.detail,
        ]);
      }
      return joinSignatureParts([
        baseSignature,
        row.status,
        row.systemKind,
        row.title,
        row.detail,
      ]);
    case "bundle-summary":
    case "step-summary":
      return joinSignatureParts([
        baseSignature,
        row.status,
        timelineRowsSignature(row.children),
      ]);
    case "turn":
      return joinSignatureParts([
        baseSignature,
        row.status,
        row.summaryCount,
        row.completedAt,
        row.children ? timelineRowsSignature(row.children) : null,
      ]);
    case "work":
      return timelineWorkRowRenderSignature(row);
    default:
      return assertNever(row);
  }
}
