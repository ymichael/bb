import type {
  TimelineActivityIntent,
  TimelineApprovalStatus,
  TimelineCommandWorkRow,
  TimelineFileChange,
  TimelineFileChangeWorkRow,
  TimelineRowStatus,
  TimelineToolWorkRow,
  TimelineWebFetchWorkRow,
  TimelineWebSearchWorkRow,
} from "@bb/server-contract";
import { assertNever } from "./assert-never.js";
import {
  formatFileChangePath,
  getFileChangeAction,
  getFileChangeActionPastTense,
  getFileChangeActionPresentTense,
} from "./file-change-summary.js";
import { durationToCompactString, plural } from "./format-helpers.js";
import {
  formatTimelineActivityIntentDetail,
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  type TimelineExplorationWorkRow,
} from "./timeline-activity-intents.js";
import {
  buildTimelineActivitySummaryLabel,
  type ThreadTimelineViewRow,
  type TimelineActivitySummaryRow,
  type TimelineViewDelegationWorkRow,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
} from "./timeline-view.js";

export type TimelineTitleTone = "default" | "destructive" | "summary";
export type TimelineTitleContentTone = "emphasis" | "muted";

export type TimelineTitleSuffix =
  | {
      kind: "text";
      text: string;
      truncate: boolean;
    }
  | {
      kind: "diff-stats";
      added: number;
      removed: number;
    };

/**
 * Describes what the title's content semantically represents when it's also an
 * actionable target (e.g. a file path that the consumer can open). Renderers
 * decide whether to surface the action; the title-builder only declares what's
 * available. New action kinds extend this union.
 */
export type TimelineTitleAction = {
  kind: "open-file-diff";
  /** Workspace-relative path of the file. For renames, the destination path. */
  path: string;
};

export interface TimelineTitle {
  /**
   * When set, the title's `content` represents an actionable target. Renderers
   * MAY surface the action (e.g. as a clickable button) when a handler is
   * available; when no handler is available, the content renders as plain
   * text.
   */
  action: TimelineTitleAction | null;
  content: string;
  contentTone: TimelineTitleContentTone;
  plain: string;
  prefix: string | null;
  shimmerPrefix: boolean;
  suffix: TimelineTitleSuffix | null;
  tone: TimelineTitleTone;
}

export interface BuildTimelineRowTitleOptions {
  preferOngoingLabel: boolean;
  summaryStyle: "bundle" | "background";
}

export interface TimelineActivityIntentTitle {
  id: string;
  title: TimelineTitle;
}

interface TitlePartsArgs {
  action?: TimelineTitleAction | null;
  content: string;
  contentTone?: TimelineTitleContentTone;
  plainContent?: string;
  prefix?: string | null;
  shimmerPrefix?: boolean;
  suffix?: TimelineTitleSuffix | null;
  tone?: TimelineTitleTone;
}

interface DisplayStatusArgs {
  approvalStatus: TimelineApprovalStatus;
  preferOngoingLabel: boolean;
  status: TimelineRowStatus;
}

type TimelineExecutionWorkRow = TimelineCommandWorkRow | TimelineToolWorkRow;
type TimelineApprovalWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "approval" }
>;
type TimelineSystemViewRow = Extract<ThreadTimelineViewRow, { kind: "system" }>;
type TimelineConversationViewRow = Extract<
  ThreadTimelineViewRow,
  { kind: "conversation" }
>;

function plainSuffixText(suffix: TimelineTitleSuffix | null): string {
  if (!suffix) {
    return "";
  }
  switch (suffix.kind) {
    case "text":
      return ` ${suffix.text}`;
    case "diff-stats": {
      const parts = [
        suffix.added > 0 ? `+${suffix.added}` : null,
        suffix.removed > 0 ? `-${suffix.removed}` : null,
      ].filter((part): part is string => part !== null);
      return parts.length > 0 ? ` ${parts.join(" ")}` : "";
    }
    default:
      return assertNever(suffix);
  }
}

function titleFromParts({
  action = null,
  content,
  contentTone = "emphasis",
  plainContent,
  prefix = null,
  shimmerPrefix = false,
  suffix = null,
  tone = "default",
}: TitlePartsArgs): TimelineTitle {
  const plainContentText = plainContent ?? content;
  const head = prefix ? `${prefix} ${plainContentText}` : plainContentText;
  return {
    action,
    content,
    contentTone,
    plain: `${head}${plainSuffixText(suffix)}`,
    prefix,
    shimmerPrefix,
    suffix,
    tone,
  };
}

function durationSuffix(durationMs: number | null): TimelineTitleSuffix | null {
  if (durationMs === null || durationMs <= 1_000) {
    return null;
  }
  return {
    kind: "text",
    text: durationToCompactString(durationMs),
    truncate: false,
  };
}

function visibleDurationText(durationMs: number | null): string | null {
  return durationMs === null || durationMs <= 1_000
    ? null
    : durationToCompactString(durationMs);
}

function metadataDurationSuffix(
  metadata: string | null,
  durationMs: number | null,
): TimelineTitleSuffix | null {
  const duration = visibleDurationText(durationMs);
  const parts = [metadata ? `(${metadata})` : null, duration].filter(
    (part): part is string => part !== null,
  );
  if (parts.length === 0) {
    return null;
  }
  return {
    kind: "text",
    text: parts.join(" "),
    truncate: metadata !== null,
  };
}

function statusDurationSuffix(
  status: "error" | "interrupted",
  durationMs: number | null,
): TimelineTitleSuffix {
  const duration = visibleDurationText(durationMs);
  return {
    kind: "text",
    text: duration ? `(${status}, ${duration})` : `(${status})`,
    truncate: false,
  };
}

function diffStatsSuffix(
  change: TimelineFileChange,
): TimelineTitleSuffix | null {
  const { added, removed } = change.diffStats;
  if (added === 0 && removed === 0) {
    return null;
  }
  return {
    kind: "diff-stats",
    added,
    removed,
  };
}

function displayStatus({
  approvalStatus,
  preferOngoingLabel,
  status,
}: DisplayStatusArgs): "waiting" | "denied" | TimelineRowStatus {
  if (approvalStatus === "waiting_for_approval") {
    return "waiting";
  }
  if (approvalStatus === "denied") {
    return "denied";
  }
  if (preferOngoingLabel && status === "completed") {
    return "pending";
  }
  return status;
}

function executionPrefix(
  row: TimelineExecutionWorkRow,
  preferOngoingLabel: boolean,
): string {
  const status = displayStatus({
    approvalStatus: row.approvalStatus,
    preferOngoingLabel,
    status: row.status,
  });
  switch (status) {
    case "waiting":
      return row.workKind === "command"
        ? "Waiting for approval to run"
        : "Waiting for approval to use";
    case "denied":
      return "Permission denied:";
    case "pending":
      return row.workKind === "command" ? "Running" : "Running tool:";
    case "completed":
      return row.workKind === "command" ? "Ran" : "Ran tool:";
    case "error":
      return row.workKind === "command" ? "Ran" : "Ran tool:";
    case "interrupted":
      return "Interrupted";
    default:
      return assertNever(status);
  }
}

function titleToneForExecution(
  row: TimelineExecutionWorkRow,
): TimelineTitleTone {
  return row.approvalStatus === "denied" ? "destructive" : "default";
}

function buildExecutionTitle(
  row: TimelineExecutionWorkRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  const prefix = executionPrefix(row, options.preferOngoingLabel);
  const content = row.workKind === "command" ? row.command : row.label;
  const statusSuffix =
    row.status === "interrupted"
        ? statusDurationSuffix("interrupted", row.durationMs)
        : durationSuffix(row.durationMs);
  return titleFromParts({
    prefix,
    content,
    suffix: statusSuffix,
    shimmerPrefix: row.status === "pending" && row.approvalStatus !== "denied",
    tone: titleToneForExecution(row),
  });
}

function buildFileChangeTitle(
  row: TimelineFileChangeWorkRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  const status = displayStatus({
    approvalStatus: row.approvalStatus,
    preferOngoingLabel: options.preferOngoingLabel,
    status: row.status,
  });
  const prefix = (() => {
    const action = getFileChangeAction(row.change);
    switch (status) {
      case "waiting":
        return "Waiting for approval to edit";
      case "denied":
        return "Permission denied:";
      case "pending":
        return getFileChangeActionPresentTense(action);
      case "completed":
        return getFileChangeActionPastTense(action);
      case "error":
        return "Failed";
      case "interrupted":
        return "Interrupted";
      default:
        return assertNever(status);
    }
  })();
  return titleFromParts({
    action: {
      kind: "open-file-diff",
      // For renames, the destination path is the canonical workspace location
      // and matches what TimelineFileDiffBlock renders against.
      path: row.change.movePath ?? row.change.path,
    },
    prefix,
    content: formatFileChangePath({ change: row.change, mode: "compact" }),
    plainContent: formatFileChangePath({ change: row.change, mode: "full" }),
    suffix: diffStatsSuffix(row.change),
    shimmerPrefix: status === "pending",
    tone: status === "denied" || status === "error" ? "destructive" : "default",
  });
}

function buildWebSearchTitle(row: TimelineWebSearchWorkRow): TimelineTitle {
  const query = row.queries.join(", ") || "web search";
  switch (row.status) {
    case "pending":
      return titleFromParts({
        prefix: "Running web search:",
        content: query,
        contentTone: "muted",
        shimmerPrefix: true,
      });
    case "completed":
      return titleFromParts({
        prefix: "Ran web search:",
        content: query,
        contentTone: "muted",
      });
    case "error":
      return titleFromParts({
        prefix: "Ran web search:",
        content: query,
        contentTone: "muted",
        suffix: { kind: "text", text: "error", truncate: false },
        tone: "destructive",
      });
    case "interrupted":
      return titleFromParts({
        prefix: "Interrupted web search:",
        content: query,
        contentTone: "muted",
      });
    default:
      return assertNever(row.status);
  }
}

function buildWebFetchTitle(row: TimelineWebFetchWorkRow): TimelineTitle {
  switch (row.status) {
    case "pending":
      return titleFromParts({
        prefix: "Fetching:",
        content: row.url,
        contentTone: "muted",
        shimmerPrefix: true,
      });
    case "completed":
      return titleFromParts({
        prefix: "Fetched:",
        content: row.url,
        contentTone: "muted",
      });
    case "error":
      return titleFromParts({
        prefix: "Fetched:",
        content: row.url,
        contentTone: "muted",
        suffix: { kind: "text", text: "error", truncate: false },
        tone: "destructive",
      });
    case "interrupted":
      return titleFromParts({
        prefix: "Interrupted fetch:",
        content: row.url,
        contentTone: "muted",
      });
    default:
      return assertNever(row.status);
  }
}

function buildDelegationTitle(
  row: TimelineViewDelegationWorkRow,
): TimelineTitle {
  const prefix =
    row.status === "pending" ? "Running subagent:" : "Ran subagent:";
  const content = row.description ?? (row.output.trim() || row.toolName);
  return titleFromParts({
    prefix,
    content,
    suffix: metadataDurationSuffix(row.subagentType, row.durationMs),
    shimmerPrefix: row.status === "pending",
    tone: row.status === "error" ? "destructive" : "default",
  });
}

function buildApprovalTitle(row: TimelineApprovalWorkRow): TimelineTitle {
  return titleFromParts({
    content: row.title,
    contentTone: "muted",
    shimmerPrefix: row.status === "pending",
    tone: row.status === "error" ? "destructive" : "default",
  });
}

function buildTimelineActivityIntentTitle(
  intent: TimelineActivityIntent,
): TimelineTitle {
  const detail = formatTimelineActivityIntentDetail({
    intent,
    pathMode: "compact",
  });
  const plainDetail = formatTimelineActivityIntentDetail({
    intent,
    pathMode: "full",
  });
  const spaceIndex = detail.indexOf(" ");
  if (spaceIndex === -1) {
    return titleFromParts({
      content: detail,
      contentTone: "muted",
      plainContent: plainDetail,
    });
  }
  const plainSpaceIndex = plainDetail.indexOf(" ");
  return titleFromParts({
    prefix: detail.slice(0, spaceIndex),
    content: detail.slice(spaceIndex + 1),
    contentTone: "muted",
    plainContent:
      plainSpaceIndex === -1
        ? plainDetail
        : plainDetail.slice(plainSpaceIndex + 1),
  });
}

function buildWorkTitle(
  row: TimelineViewWorkRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  switch (row.workKind) {
    case "command":
    case "tool":
      return buildExecutionTitle(row, options);
    case "file-change":
      return buildFileChangeTitle(row, options);
    case "web-search":
      return buildWebSearchTitle(row);
    case "web-fetch":
      return buildWebFetchTitle(row);
    case "delegation":
      return buildDelegationTitle(row);
    case "approval":
      return buildApprovalTitle(row);
    default:
      return assertNever(row);
  }
}

function buildActivitySummaryTitle(
  row: TimelineActivitySummaryRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  const activeStatus: TimelineRowStatus =
    options.preferOngoingLabel && row.status === "completed"
      ? "pending"
      : row.status;
  const activeRow =
    activeStatus === row.status ? row : { ...row, status: activeStatus };
  const label = buildTimelineActivitySummaryLabel(activeRow);
  if (options.summaryStyle === "background") {
    return titleFromParts({
      content: label,
      contentTone: "muted",
      tone: "summary",
    });
  }
  const spaceIndex = label.indexOf(" ");
  if (spaceIndex === -1) {
    return titleFromParts({
      content: label,
      contentTone: "emphasis",
      shimmerPrefix: activeRow.status === "pending",
    });
  }
  return titleFromParts({
    prefix: label.slice(0, spaceIndex),
    content: label.slice(spaceIndex + 1),
    shimmerPrefix: activeRow.status === "pending",
  });
}

function buildTurnTitle(
  row: TimelineViewTurnRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  const status =
    options.preferOngoingLabel && row.status === "completed"
      ? "pending"
      : row.status;
  if (row.durationMs !== null && row.durationMs > 1_000) {
    return titleFromParts({
      prefix: status === "pending" ? "Working for" : "Worked for",
      content: durationToCompactString(row.durationMs),
      shimmerPrefix: status === "pending",
    });
  }
  return titleFromParts({
    prefix: status === "pending" ? "Working on" : "Worked on",
    content: plural(row.summaryCount, "item"),
    shimmerPrefix: status === "pending",
  });
}

function buildSystemTitle(row: TimelineSystemViewRow): TimelineTitle {
  return titleFromParts({
    content: row.systemKind === "error" ? `Error: ${row.title}` : row.title,
    contentTone: row.systemKind === "error" ? "emphasis" : "muted",
    shimmerPrefix: row.status === "pending",
    tone: row.systemKind === "error" ? "destructive" : "default",
  });
}

function buildConversationTitle(
  row: TimelineConversationViewRow,
): TimelineTitle {
  return titleFromParts({
    content: row.role === "user" ? "User" : "Assistant",
    contentTone: "muted",
  });
}

export function buildTimelineActivityIntentTitles(
  row: TimelineExplorationWorkRow,
): TimelineActivityIntentTitle[] {
  if (!hasTimelineExplorationIntent(row)) {
    return [];
  }

  const dedupedDetailKeys = new Set<string>();
  const titles: TimelineActivityIntentTitle[] = [];

  row.activityIntents.forEach((intent, index) => {
    if (intent.type === "unknown") {
      return;
    }
    const dedupeKey = getTimelineActivityIntentDetailDedupeKey(intent);
    if (dedupeKey !== null) {
      if (dedupedDetailKeys.has(dedupeKey)) {
        return;
      }
      dedupedDetailKeys.add(dedupeKey);
    }
    titles.push({
      id: `${row.id}:activity-intent:${index}`,
      title: buildTimelineActivityIntentTitle(intent),
    });
  });

  return titles;
}

export function buildTimelineRowTitle(
  row: ThreadTimelineViewRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  switch (row.kind) {
    case "conversation":
      return buildConversationTitle(row);
    case "system":
      return buildSystemTitle(row);
    case "work":
      return buildWorkTitle(row, options);
    case "activity-summary":
      return buildActivitySummaryTitle(row, options);
    case "turn":
      return buildTurnTitle(row, options);
    default:
      return assertNever(row);
  }
}
