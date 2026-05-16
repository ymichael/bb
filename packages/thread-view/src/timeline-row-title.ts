import type {
  TimelineActivityIntent,
  TimelineApprovalStatus,
  TimelineCommandWorkRow,
  TimelineFileChange,
  TimelineFileChangeWorkRow,
  TimelineManagerAssignmentSystemRow,
  TimelineRowStatus,
  TimelineToolWorkRow,
  TimelineWebFetchWorkRow,
  TimelineWebSearchWorkRow,
} from "@bb/server-contract";
import { assertNever } from "./assert-never.js";
import {
  formatFileChangePath,
  getFileChangeAction,
  getFileChangeActionInfinitive,
  getFileChangeActionPastTense,
  getFileChangeActionPresentTense,
} from "./file-change-summary.js";
import {
  durationToCompactString,
  formatDiffStatsText,
} from "./format-helpers.js";
import { formatToolCallCommand } from "./tool-call-parsing.js";
import {
  formatTimelineActivityIntentDetailParts,
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  type TimelineExplorationWorkRow,
} from "./timeline-activity-intents.js";
import {
  buildTimelineWorkSummaryLabelParts,
  type ThreadTimelineViewRow,
  type TimelineWorkSummaryRow,
  type TimelineViewDelegationWorkRow,
  type TimelineQuestionViewWorkRow,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
} from "./timeline-view.js";

export type TimelineTitleTone = "default" | "destructive" | "summary";
export type TimelineStatusDecorationStatus =
  | "denied"
  | "error"
  | "expired"
  | "interrupted";

/**
 * Optional link target attached to a title segment. Renderers that support
 * navigation (the App) can wrap the segment in a link; CLI renderers ignore
 * the link and render the segment text directly.
 */
export type TimelineTitleLink = { kind: "thread"; threadId: string };

/**
 * One slice of the title's text. Renderers walk the segment list and apply
 * `em`/`shimmer`/`truncate` per slice. There is no implicit "prefix vs content"
 * positional meaning — segment order is the only positional cue.
 */
export interface TimelineTitleSegment {
  text: string;
  /** Optional plain-text override for CLI rendering. Defaults to `text`. */
  plainText?: string;
  em: boolean;
  shimmer: boolean;
  truncate: boolean;
  /**
   * Optional navigation target. App renderers wrap the segment in a link;
   * CLI/plain renderers ignore this field.
   */
  link?: TimelineTitleLink;
}

export type TimelineTitleDecoration =
  | {
      kind: "duration";
      /** Wall-clock millis when the work began. */
      startedAt: number;
      /**
       * Wall-clock millis when the work reached a terminal status. `null`
       * while pending; renderers derive elapsed from `now - startedAt` and
       * tick locally. When non-null the decoration renders statically as
       * `completedAt - startedAt`.
       */
      completedAt: number | null;
      /** Render with title-emphasis tone instead of the default muted decoration tone. */
      em: boolean;
    }
  | {
      kind: "status";
      status: TimelineStatusDecorationStatus;
      durationMs: number | null;
    }
  | {
      kind: "summary-status";
      errorCount: number;
      interruptedCount: number;
    }
  | { kind: "diff-stats"; added: number; removed: number };

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
  segments: TimelineTitleSegment[];
  decorations: TimelineTitleDecoration[];
  tone: TimelineTitleTone;
  action: TimelineTitleAction | null;
  /** CLI plain rendering — segments + decorations joined per `renderTitlePlain`. */
  plain: string;
}

export interface BuildTimelineRowTitleOptions {
  summaryStyle: "bundle" | "background";
  workStyle: "default" | "summary";
  /**
   * Whether this row is the open step's currently-active bundle. Determined by
   * the list-level renderer that walks the row sequence; only bundles that are
   * the latest bundle-summary in the trailing open step set this to `true`.
   * Defaults to `false` so non-bundle rows and displaced bundles render past.
   */
  isActiveLatestBundle?: boolean;
}

export interface TimelineActivityIntentTitle {
  id: string;
  title: TimelineTitle;
}

interface BuildTimelineActivityIntentTitleArgs {
  intent: TimelineActivityIntent;
  pending: boolean;
  /**
   * When set, append a status decoration ("(error)" / "(interrupted)") after
   * the intent's title segments. The compact intent rendering used inside
   * activity bundles relies on this to surface row-level outcomes — the
   * bundle's own label only conveys an aggregate count.
   */
  failureStatus?: "error" | "interrupted";
}

interface DisplayStatusArgs {
  approvalStatus: TimelineApprovalStatus;
  status: TimelineRowStatus;
}

type TimelineExecutionWorkRow = TimelineCommandWorkRow | TimelineToolWorkRow;
type TimelineApprovalWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "approval" }
>;
type TimelineFileEditApprovalWorkRow = Extract<
  TimelineApprovalWorkRow,
  { approvalKind: "file-edit" }
>;
type TimelinePermissionGrantApprovalWorkRow = Extract<
  TimelineApprovalWorkRow,
  { approvalKind: "permission-grant" }
>;
type TimelineSystemViewRow = Extract<ThreadTimelineViewRow, { kind: "system" }>;
type TimelineConversationViewRow = Extract<
  ThreadTimelineViewRow,
  { kind: "conversation" }
>;

interface SegmentOptions {
  em?: boolean;
  shimmer?: boolean;
  truncate?: boolean;
  plainText?: string;
  link?: TimelineTitleLink;
}

// Titles are always rendered on a single line — both in the App (segments
// use `whitespace-pre`, which would otherwise honor `\n` as a line break)
// and in the CLI/tooltip plain text. Normalizing newlines at segment
// construction means any caller that passes user-supplied content
// (commands, tool labels, file paths) gets single-line rendering for free,
// without each call site having to remember to sanitize.
function collapseTitleNewlines(text: string): string {
  return text.replace(/[\r\n]+/gu, " ");
}

function segment(text: string, opts: SegmentOptions = {}): TimelineTitleSegment {
  return {
    text: collapseTitleNewlines(text),
    em: opts.em ?? false,
    shimmer: opts.shimmer ?? false,
    truncate: opts.truncate ?? false,
    ...(opts.plainText !== undefined
      ? { plainText: collapseTitleNewlines(opts.plainText) }
      : {}),
    ...(opts.link !== undefined ? { link: opts.link } : {}),
  };
}

function filterNull<T>(values: (T | null)[]): T[] {
  return values.filter((v): v is T => v !== null);
}

function visibleDurationMs(durationMs: number | null): number | null {
  return durationMs !== null && durationMs > 1_000 ? durationMs : null;
}

/**
 * Most below-threshold elapsed durations don't render — sub-second flickers
 * would be noisy for active rows and too much detail for small work rows.
 */
function durationDecoration(
  startedAt: number,
  completedAt: number | null,
  options: { em?: boolean } = {},
): TimelineTitleDecoration | null {
  if (completedAt !== null) {
    const finalMs = completedAt - startedAt;
    if (visibleDurationMs(finalMs) === null) return null;
  }
  return {
    kind: "duration",
    startedAt,
    completedAt,
    em: options.em ?? false,
  };
}

function completedTurnDurationDecoration(
  startedAt: number,
  completedAt: number | null,
): TimelineTitleDecoration | null {
  if (completedAt === null) return null;
  return {
    kind: "duration",
    startedAt,
    completedAt,
    em: true,
  };
}

function statusDecoration(
  status: TimelineStatusDecorationStatus,
  durationMs: number | null,
): TimelineTitleDecoration {
  return { kind: "status", status, durationMs: visibleDurationMs(durationMs) };
}

function summaryStatusDecoration(
  row: TimelineWorkSummaryRow,
): TimelineTitleDecoration | null {
  let errorCount = 0;
  let interruptedCount = 0;
  for (const child of row.children) {
    if (child.status === "error") errorCount += 1;
    if (child.status === "interrupted") interruptedCount += 1;
  }
  if (errorCount === 0 && interruptedCount === 0) {
    return null;
  }
  return { kind: "summary-status", errorCount, interruptedCount };
}

function diffStatsDecoration(
  change: TimelineFileChange,
): TimelineTitleDecoration | null {
  const { added, removed } = change.diffStats;
  if (added === 0 && removed === 0) {
    return null;
  }
  return { kind: "diff-stats", added, removed };
}

/**
 * Canonical text rendering for a decoration. Used by the CLI plain renderer
 * directly and by the App renderer when it falls back to a plain text node
 * (App may also render structured spans for tone/styling).
 */
export function formatTimelineDecorationText(
  d: TimelineTitleDecoration,
): string {
  switch (d.kind) {
    case "duration": {
      // CLI is a static snapshot; pending rows have no captured end yet,
      // so we omit the duration entirely rather than print a placeholder
      // or a sub-second number.
      if (d.completedAt === null) return "";
      return `(${durationToCompactString(d.completedAt - d.startedAt)})`;
    }
    case "status":
      return d.durationMs !== null
        ? `(${durationToCompactString(d.durationMs)}, ${d.status})`
        : `(${d.status})`;
    case "summary-status": {
      const parts: string[] = [];
      if (d.errorCount > 0) {
        parts.push(
          `${d.errorCount} error${d.errorCount > 1 ? "s" : ""}`,
        );
      }
      if (d.interruptedCount > 0) {
        parts.push(`${d.interruptedCount} interrupted`);
      }
      return parts.length === 0 ? "" : `(${parts.join(", ")})`;
    }
    case "diff-stats":
      return formatDiffStatsText({
        added: d.added,
        removed: d.removed,
        hideZero: true,
      });
    default:
      return assertNever(d);
  }
}

export function renderTitlePlain(
  segments: readonly TimelineTitleSegment[],
  decorations: readonly TimelineTitleDecoration[],
): string {
  const segmentsText = segments
    .map((s) => s.plainText ?? s.text)
    .filter((t) => t.length > 0)
    .join(" ");
  const decorationsText = decorations
    .map(formatTimelineDecorationText)
    .filter((t) => t.length > 0)
    .join(" ");
  if (decorationsText.length === 0) return segmentsText;
  if (segmentsText.length === 0) return decorationsText;
  return `${segmentsText} ${decorationsText}`;
}

interface MakeTitleArgs {
  segments: TimelineTitleSegment[];
  decorations?: TimelineTitleDecoration[];
  tone?: TimelineTitleTone;
  action?: TimelineTitleAction | null;
}

function makeTitle({
  segments,
  decorations = [],
  tone = "default",
  action = null,
}: MakeTitleArgs): TimelineTitle {
  return {
    segments,
    decorations,
    tone,
    action,
    plain: renderTitlePlain(segments, decorations),
  };
}

function displayStatus({
  approvalStatus,
  status,
}: DisplayStatusArgs): "waiting" | "denied" | TimelineRowStatus {
  if (approvalStatus === "waiting_for_approval") {
    return "waiting";
  }
  if (approvalStatus === "denied") {
    return "denied";
  }
  return status;
}

// ---------------------------------------------------------------------------
// Mappers — one per row kind. Each produces a structured Title.
// ---------------------------------------------------------------------------

function mapExecutionTitle(row: TimelineExecutionWorkRow): TimelineTitle {
  const explorationTitle = mapSingleExplorationIntentTitle(row);
  if (explorationTitle !== null) {
    return explorationTitle;
  }
  const status = displayStatus({
    approvalStatus: row.approvalStatus,
    status: row.status,
  });
  const isCommand = row.workKind === "command";
  const content = isCommand
    ? row.command
    : formatToolCallCommand(row.toolName, row.toolArgs);
  switch (status) {
    case "waiting":
      return makeTitle({
        segments: [
          segment("Waiting for approval", { shimmer: true }),
          segment(isCommand ? "to run" : "to use"),
          segment(content, { em: true, truncate: true }),
        ],
      });
    case "denied":
      return makeTitle({
        segments: [
          segment("Permission denied:"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: filterNull([durationDecoration(row.startedAt, row.completedAt)]),
      });
    case "pending":
      return makeTitle({
        segments: [
          segment(isCommand ? "Running" : "Running tool:", { shimmer: true }),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: filterNull([
          durationDecoration(row.startedAt, row.completedAt),
        ]),
      });
    case "completed":
      return makeTitle({
        segments: [
          segment(isCommand ? "Ran" : "Ran tool:"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: filterNull([durationDecoration(row.startedAt, row.completedAt)]),
      });
    case "error":
      return makeTitle({
        segments: [
          segment(isCommand ? "Ran" : "Ran tool:"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: [statusDecoration("error", row.completedAt !== null ? row.completedAt - row.startedAt : null)],
      });
    case "interrupted":
      return makeTitle({
        segments: [
          segment(isCommand ? "Ran" : "Ran tool:"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: [statusDecoration("interrupted", row.completedAt !== null ? row.completedAt - row.startedAt : null)],
      });
    default:
      return assertNever(status);
  }
}

function mapSingleExplorationIntentTitle(
  row: TimelineExecutionWorkRow,
): TimelineTitle | null {
  if (!hasTimelineExplorationIntent(row)) {
    return null;
  }
  const knownIntents = row.activityIntents.filter(
    (intent) => intent.type !== "unknown",
  );
  if (knownIntents.length !== 1) {
    return null;
  }
  const intent = knownIntents[0];
  if (!intent) {
    return null;
  }
  const status = displayStatus({
    approvalStatus: row.approvalStatus,
    status: row.status,
  });
  const pending = status === "pending";
  const detail = formatTimelineActivityIntentDetailParts({
    intent,
    pathMode: "compact",
    pending,
  });
  const plainDetail = formatTimelineActivityIntentDetailParts({
    intent,
    pathMode: "full",
    pending,
  });

  if (status === "denied") {
    const verbContent = detail.prefix
      ? `${detail.prefix} ${detail.content}`
      : detail.content;
    const plainVerbContent = plainDetail.prefix
      ? `${plainDetail.prefix} ${plainDetail.content}`
      : plainDetail.content;
    return makeTitle({
      segments: [
        segment("Permission denied:"),
        segment(verbContent, {
          em: true,
          truncate: true,
          plainText: plainVerbContent,
        }),
      ],
    });
  }
  if (status === "waiting") {
    const verbContent = detail.prefix
      ? `${detail.prefix} ${detail.content}`
      : detail.content;
    const plainVerbContent = plainDetail.prefix
      ? `${plainDetail.prefix} ${plainDetail.content}`
      : plainDetail.content;
    return makeTitle({
      segments: [
        segment("Waiting for approval", { shimmer: true }),
        segment("to use"),
        segment(verbContent, {
          em: true,
          truncate: true,
          plainText: plainVerbContent,
        }),
      ],
    });
  }

  const segments: TimelineTitleSegment[] = [];
  if (detail.prefix) {
    segments.push(segment(detail.prefix, { shimmer: pending }));
  }
  segments.push(
    segment(detail.content, {
      em: false,
      truncate: true,
      plainText: plainDetail.content,
    }),
  );

  const decorations: TimelineTitleDecoration[] =
    status === "error"
      ? [statusDecoration("error", null)]
      : status === "interrupted"
        ? [statusDecoration("interrupted", null)]
        : [];

  return makeTitle({ segments, decorations });
}

function mapFileChangeTitle(row: TimelineFileChangeWorkRow): TimelineTitle {
  const status = displayStatus({
    approvalStatus: row.approvalStatus,
    status: row.status,
  });
  const action = getFileChangeAction(row.change);
  const compactPath = formatFileChangePath({ change: row.change, mode: "compact" });
  const fullPath = formatFileChangePath({ change: row.change, mode: "full" });
  const titleAction: TimelineTitleAction = {
    kind: "open-file-diff",
    // For renames, the destination path is the canonical workspace location
    // and matches what TimelineFileDiffBlock renders against.
    path: row.change.movePath ?? row.change.path,
  };
  const pathSegment = segment(compactPath, {
    em: true,
    truncate: true,
    plainText: fullPath,
  });

  switch (status) {
    case "waiting":
      return makeTitle({
        segments: [
          segment("Waiting for approval", { shimmer: true }),
          segment("to edit"),
          pathSegment,
        ],
        decorations: filterNull([diffStatsDecoration(row.change)]),
        action: titleAction,
      });
    case "denied":
      return makeTitle({
        segments: [segment("Permission denied:"), pathSegment],
        decorations: filterNull([diffStatsDecoration(row.change)]),
        action: titleAction,
      });
    case "pending":
      return makeTitle({
        segments: [
          segment(getFileChangeActionPresentTense(action), { shimmer: true }),
          pathSegment,
        ],
        decorations: filterNull([diffStatsDecoration(row.change)]),
        action: titleAction,
      });
    case "completed":
      return makeTitle({
        segments: [
          segment(getFileChangeActionPastTense(action)),
          pathSegment,
        ],
        decorations: filterNull([diffStatsDecoration(row.change)]),
        action: titleAction,
      });
    case "error":
      return makeTitle({
        segments: [
          segment(`Failed to ${getFileChangeActionInfinitive(action)}`),
          pathSegment,
        ],
        decorations: [statusDecoration("error", null)],
        action: titleAction,
      });
    case "interrupted":
      return makeTitle({
        segments: [
          segment(
            `Interrupted while ${getFileChangeActionPresentTense(action).toLowerCase()}`,
          ),
          pathSegment,
        ],
        action: titleAction,
      });
    default:
      return assertNever(status);
  }
}

function mapWebSearchTitle(row: TimelineWebSearchWorkRow): TimelineTitle {
  const query = row.queries.join(", ") || "web search";
  const querySegment = segment(query, {
    em: false,
    truncate: true,
  });
  switch (row.status) {
    case "pending":
      // No live duration: the projection only sets `durationMs` at completion.
      return makeTitle({
        segments: [
          segment("Running web search:", { shimmer: true }),
          querySegment,
        ],
      });
    case "completed":
      return makeTitle({
        segments: [segment("Ran web search:"), querySegment],
        decorations: filterNull([durationDecoration(row.startedAt, row.completedAt)]),
      });
    case "error":
      return makeTitle({
        segments: [segment("Ran web search:"), querySegment],
        decorations: [statusDecoration("error", row.completedAt !== null ? row.completedAt - row.startedAt : null)],
      });
    case "interrupted":
      return makeTitle({
        segments: [segment("Interrupted web search:"), querySegment],
        decorations: [
          statusDecoration(
            "interrupted",
            row.completedAt !== null ? row.completedAt - row.startedAt : null,
          ),
        ],
      });
    default:
      return assertNever(row.status);
  }
}

function mapWebFetchTitle(row: TimelineWebFetchWorkRow): TimelineTitle {
  const urlSegment = segment(row.url, { em: false, truncate: true });
  switch (row.status) {
    case "pending":
      // No live duration: the projection only sets `durationMs` at completion.
      return makeTitle({
        segments: [segment("Fetching:", { shimmer: true }), urlSegment],
      });
    case "completed":
      return makeTitle({
        segments: [segment("Fetched:"), urlSegment],
        decorations: filterNull([durationDecoration(row.startedAt, row.completedAt)]),
      });
    case "error":
      return makeTitle({
        segments: [segment("Fetched:"), urlSegment],
        decorations: [statusDecoration("error", row.completedAt !== null ? row.completedAt - row.startedAt : null)],
      });
    case "interrupted":
      return makeTitle({
        segments: [segment("Interrupted fetch:"), urlSegment],
        decorations: [
          statusDecoration(
            "interrupted",
            row.completedAt !== null ? row.completedAt - row.startedAt : null,
          ),
        ],
      });
    default:
      return assertNever(row.status);
  }
}

function delegationVerbForStatus(status: TimelineRowStatus): {
  text: string;
  shimmer: boolean;
} {
  switch (status) {
    case "pending":
      return { text: "Running subagent:", shimmer: true };
    case "completed":
      return { text: "Ran subagent:", shimmer: false };
    case "error":
      return { text: "Failed subagent:", shimmer: false };
    case "interrupted":
      return { text: "Interrupted subagent:", shimmer: false };
    default:
      return assertNever(status);
  }
}

function mapDelegationTitle(
  row: TimelineViewDelegationWorkRow,
): TimelineTitle {
  const description = row.description ?? (row.output.trim() || row.toolName);
  const verb = delegationVerbForStatus(row.status);
  const segments: TimelineTitleSegment[] = [
    segment(verb.text, { shimmer: verb.shimmer }),
    segment(description, { em: true, truncate: true }),
  ];
  if (row.subagentType) {
    segments.push(
      segment(`(${row.subagentType})`, { em: false, truncate: true }),
    );
  }
  // The verb prefix (Failed/Interrupted/Ran subagent) already conveys the
  // status, so the decoration only carries duration. Tone stays neutral —
  // destructive tone is reserved for the system-error row kind.
  return makeTitle({
    segments,
    decorations: filterNull([
      durationDecoration(row.startedAt, row.completedAt),
    ]),
  });
}

function mapFileEditApprovalTitle(
  row: TimelineFileEditApprovalWorkRow,
): TimelineTitle {
  switch (row.lifecycle) {
    case "waiting":
      return makeTitle({
        segments: [
          segment("Waiting for approval to edit", { shimmer: true }),
          segment("files", { em: true, truncate: true }),
        ],
      });
    case "denied":
      return makeTitle({
        segments: [
          segment("Permission denied:"),
          segment("file changes", { em: true, truncate: true }),
        ],
      });
    default:
      return assertNever(row.lifecycle);
  }
}

function mapPermissionGrantApprovalTitle(
  row: TimelinePermissionGrantApprovalWorkRow,
): TimelineTitle {
  const toolName = row.target.toolName;
  const reason =
    row.statusReason !== null && row.statusReason.trim().length > 0
      ? row.statusReason.trim()
      : null;
  const reasonSegment =
    reason !== null ? segment(`(${reason})`, { truncate: true }) : null;
  switch (row.lifecycle) {
    case "pending": {
      const segments =
        toolName !== null
          ? [
              segment("Waiting for permission", { shimmer: true }),
              segment("to use"),
              segment(toolName, { em: true, truncate: true }),
            ]
          : [segment("Waiting for permissions", { shimmer: true })];
      return makeTitle({
        segments,
      });
    }
    case "resolving": {
      const segments =
        toolName !== null
          ? [
              segment("Delivering permission", { shimmer: true }),
              segment("to use"),
              segment(toolName, { em: true, truncate: true }),
            ]
          : [segment("Delivering permissions", { shimmer: true })];
      return makeTitle({
        segments,
      });
    }
    case "granted": {
      const scopeText =
        row.grantScope === "turn"
          ? "for this turn"
          : row.grantScope === "session"
            ? "for this session"
            : null;
      const prefix =
        scopeText !== null
          ? `Permission granted ${scopeText}:`
          : "Permission granted:";
      const segments =
        toolName !== null
          ? [segment(prefix), segment(toolName, { em: true, truncate: true })]
          : [
              segment(
                scopeText !== null
                  ? `Permission granted ${scopeText}`
                  : "Permission granted",
              ),
            ];
      return makeTitle({
        segments,
      });
    }
    case "denied":
      return makeTitle({
        segments:
          toolName !== null
            ? [
                segment("Permission denied:"),
                segment(toolName, { em: true, truncate: true }),
              ]
            : [segment("Permission denied")],
      });
    case "interrupted":
      return makeTitle({
        segments: filterNull([
          toolName !== null
            ? segment("Permission grant interrupted:")
            : segment("Permission grant interrupted"),
          toolName !== null
            ? segment(toolName, { em: true, truncate: true })
            : null,
          reasonSegment,
        ]),
      });
    case "expired":
      return makeTitle({
        segments: filterNull([
          toolName !== null
            ? segment("Permission grant expired:")
            : segment("Permission grant expired"),
          toolName !== null
            ? segment(toolName, { em: true, truncate: true })
            : null,
          reasonSegment,
        ]),
      });
    default:
      return assertNever(row.lifecycle);
  }
}

function mapApprovalTitle(row: TimelineApprovalWorkRow): TimelineTitle {
  switch (row.approvalKind) {
    case "file-edit":
      return mapFileEditApprovalTitle(row);
    case "permission-grant":
      return mapPermissionGrantApprovalTitle(row);
    default:
      return assertNever(row);
  }
}

function firstQuestionPrompt(row: TimelineQuestionViewWorkRow): string | null {
  return row.questions[0]?.prompt ?? null;
}

function mapQuestionTitle(row: TimelineQuestionViewWorkRow): TimelineTitle {
  const prompt = firstQuestionPrompt(row);
  const reasonSegment = row.statusReason
    ? segment(row.statusReason, { truncate: true })
    : null;
  switch (row.lifecycle) {
    case "pending":
      return makeTitle({
        segments: filterNull([
          segment("Waiting for answer", { shimmer: true }),
          prompt ? segment(prompt, { em: true, truncate: true }) : null,
        ]),
      });
    case "resolving":
      return makeTitle({
        segments: filterNull([
          segment("Delivering answer", { shimmer: true }),
          prompt ? segment(prompt, { em: true, truncate: true }) : null,
        ]),
      });
    case "answered":
      return makeTitle({
        segments: filterNull([
          segment("Answered"),
          prompt ? segment(prompt, { em: true, truncate: true }) : null,
        ]),
      });
    case "interrupted":
      return makeTitle({
        segments: filterNull([
          segment("Question interrupted"),
          prompt ? segment(prompt, { em: true, truncate: true }) : null,
          reasonSegment,
        ]),
      });
    case "expired":
      return makeTitle({
        segments: filterNull([
          segment("Question expired"),
          prompt ? segment(prompt, { em: true, truncate: true }) : null,
          reasonSegment,
        ]),
      });
    default:
      return assertNever(row.lifecycle);
  }
}

function mapWorkTitle(
  row: TimelineViewWorkRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  const title = (() => {
    switch (row.workKind) {
      case "command":
      case "tool":
        return mapExecutionTitle(row);
      case "file-change":
        return mapFileChangeTitle(row);
      case "web-search":
        return mapWebSearchTitle(row);
      case "web-fetch":
        return mapWebFetchTitle(row);
      case "delegation":
        return mapDelegationTitle(row);
      case "approval":
        return mapApprovalTitle(row);
      case "question":
        return mapQuestionTitle(row);
      default:
        return assertNever(row);
    }
  })();
  if (options.workStyle === "default" || title.tone === "destructive") {
    return title;
  }
  // Summary work-style mutes the title via tone; segment-level `em` is kept
  // so content emphasis stays visible inside the muted wrapper, per spec.
  return {
    ...title,
    tone: "summary",
  };
}

function mapWorkSummaryTitle(
  row: TimelineWorkSummaryRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  // Bundles only render with active/present-tense treatment when the caller
  // (a list-level renderer) tells us this is the open step's latest bundle.
  const isActive =
    row.kind === "bundle-summary" && options.isActiveLatestBundle === true;
  const { verb, rest } = buildTimelineWorkSummaryLabelParts(row, {
    active: isActive,
  });
  const decorations = filterNull([summaryStatusDecoration(row)]);
  if (options.summaryStyle === "background") {
    const labelText = rest.length === 0 ? verb : `${verb} ${rest}`;
    return makeTitle({
      segments: [segment(labelText, { em: false, truncate: true })],
      decorations,
      tone: "summary",
    });
  }
  // Bundle summaryStyle: the rest always carries em — bundles are content
  // recaps and should read emphasized regardless of frontier state. Shimmer
  // is the active-latest tell on the verb.
  const verbSegment = segment(verb, { shimmer: isActive });
  if (rest.length === 0) {
    return makeTitle({
      segments: [{ ...verbSegment, truncate: true }],
      decorations,
    });
  }
  return makeTitle({
    segments: [verbSegment, segment(rest, { em: true, truncate: true })],
    decorations,
  });
}

function mapTurnTitle(row: TimelineViewTurnRow): TimelineTitle {
  const isPending = row.status === "pending";
  const durationDeco = isPending
    ? durationDecoration(row.startedAt, row.completedAt, { em: true })
    : completedTurnDurationDecoration(row.startedAt, row.completedAt);
  const hasCapturedDuration =
    !isPending && row.completedAt !== null && durationDeco !== null;
  if (hasCapturedDuration) {
    // Completed turn with a visible captured duration: "Worked for (8m 14s)".
    return makeTitle({
      segments: [segment("Worked for", { shimmer: false })],
      decorations: [durationDeco],
    });
  }
  return makeTitle({
    segments: [
      segment(isPending ? "Working" : "Worked", { shimmer: isPending }),
    ],
    // Pending rows still emit the decoration so the App's `LiveDurationText`
    // can tick locally; CLI formatters return "" for pending and
    // `renderTitlePlain` filters that out.
    decorations: isPending && durationDeco !== null ? [durationDeco] : [],
  });
}

function managerLinkSegment(
  threadId: string | null,
  title: string | null,
): TimelineTitleSegment | null {
  if (threadId === null) {
    return null;
  }
  return segment(title ?? threadId, {
    em: true,
    truncate: true,
    link: { kind: "thread", threadId },
  });
}

interface ManagerAssignmentVerbs {
  assign: string;
  release: string;
  transferFrom: string;
  transferTo: string;
}

function managerAssignmentVerbs(
  status: TimelineRowStatus,
): ManagerAssignmentVerbs {
  switch (status) {
    case "completed":
    case "error":
    case "interrupted":
      // Past-tense verb shared across terminal statuses; status decoration
      // ("(failed)" / "(interrupted)") differentiates the outcome.
      return {
        assign: "Thread assigned to",
        release: "Thread unassigned from",
        transferFrom: "Thread reassigned from",
        transferTo: "to",
      };
    case "pending":
      return {
        assign: "Assigning thread to",
        release: "Releasing thread from",
        transferFrom: "Reassigning thread from",
        transferTo: "to",
      };
    default:
      return assertNever(status);
  }
}

function mapManagerAssignmentSystemTitle(
  row: TimelineManagerAssignmentSystemRow,
): TimelineTitle {
  const assignment = row.managerAssignment;
  const linkPrev = managerLinkSegment(
    assignment.previousManagerThreadId,
    assignment.previousManagerThreadTitle,
  );
  const linkNext = managerLinkSegment(
    assignment.nextManagerThreadId,
    assignment.nextManagerThreadTitle,
  );
  const shimmer = row.status === "pending";
  const verbs = managerAssignmentVerbs(row.status);

  const segments: TimelineTitleSegment[] = (() => {
    switch (assignment.action) {
      case "assign":
        return filterNull([segment(verbs.assign, { shimmer }), linkNext]);
      case "release":
        return filterNull([segment(verbs.release, { shimmer }), linkPrev]);
      case "transfer":
        return filterNull([
          segment(verbs.transferFrom, { shimmer }),
          linkPrev,
          linkNext !== null ? segment(verbs.transferTo, { shimmer }) : null,
          linkNext,
        ]);
      default:
        return assertNever(assignment.action);
    }
  })();

  const decorations: TimelineTitleDecoration[] = (() => {
    switch (row.status) {
      case "error":
        return [statusDecoration("error", null)];
      case "interrupted":
        return [statusDecoration("interrupted", null)];
      case "pending":
      case "completed":
        return [];
      default:
        return assertNever(row.status);
    }
  })();

  return makeTitle({
    segments,
    decorations,
    tone: row.status === "error" ? "destructive" : "default",
  });
}

function mapSystemTitle(row: TimelineSystemViewRow): TimelineTitle {
  const hasErrorTone = row.systemKind === "error" || row.status === "error";
  if (
    row.systemKind === "operation" &&
    row.operationKind === "manager-assignment"
  ) {
    return mapManagerAssignmentSystemTitle(row);
  }
  const isCompaction =
    row.systemKind === "operation" && row.operationKind === "compaction";
  const decorations =
    isCompaction && (row.status === "pending" || row.status === "completed")
      ? filterNull([durationDecoration(row.startedAt, row.completedAt)])
      : [];
  const titleText =
    isCompaction && row.status === "pending" ? `${row.title}…` : row.title;
  return makeTitle({
    segments: [
      segment(titleText, {
        em: hasErrorTone,
        shimmer: row.status === "pending",
        truncate: true,
      }),
    ],
    decorations,
    tone: hasErrorTone ? "destructive" : "default",
  });
}

function mapConversationTitle(
  row: TimelineConversationViewRow,
): TimelineTitle {
  return makeTitle({
    segments: [
      segment(row.role === "user" ? "User" : "Assistant", { em: false }),
    ],
  });
}

function mapTimelineActivityIntentTitle({
  intent,
  pending,
  failureStatus,
}: BuildTimelineActivityIntentTitleArgs): TimelineTitle {
  const detail = formatTimelineActivityIntentDetailParts({
    intent,
    pathMode: "compact",
    pending,
  });
  const plainDetail = formatTimelineActivityIntentDetailParts({
    intent,
    pathMode: "full",
    pending,
  });
  const segments: TimelineTitleSegment[] = [];
  if (detail.prefix) {
    segments.push(segment(detail.prefix, { shimmer: pending }));
  }
  segments.push(
    segment(detail.content, {
      em: false,
      truncate: true,
      plainText: plainDetail.content,
    }),
  );
  const decorations = failureStatus
    ? [statusDecoration(failureStatus, null)]
    : [];
  return makeTitle({ segments, decorations });
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

export function buildTimelineActivityIntentTitles(
  row: TimelineExplorationWorkRow,
): TimelineActivityIntentTitle[] {
  if (!hasTimelineExplorationIntent(row)) {
    return [];
  }

  let lastEmittedKey: string | null = null;
  const titles: TimelineActivityIntentTitle[] = [];
  const failureStatus =
    row.status === "error"
      ? "error"
      : row.status === "interrupted"
        ? "interrupted"
        : undefined;

  row.activityIntents.forEach((intent, index) => {
    if (intent.type === "unknown") {
      return;
    }
    const dedupeKey = getTimelineActivityIntentDetailDedupeKey(intent);
    if (dedupeKey !== null && dedupeKey === lastEmittedKey) {
      return;
    }
    titles.push({
      id: `${row.id}:activity-intent:${index}`,
      title: mapTimelineActivityIntentTitle({
        intent,
        pending: row.status === "pending",
        ...(failureStatus ? { failureStatus } : {}),
      }),
    });
    lastEmittedKey = dedupeKey;
  });

  return titles;
}

function isUserConversationRow(row: ThreadTimelineViewRow): boolean {
  return row.kind === "conversation" && row.role === "user";
}

/**
 * Returns the trailing row of `rows` for auto-expand and active-latest bundle
 * styling. User-role conversation rows are transparent: they are *requests*
 * to the agent rather than events the agent produced, so a user message at
 * the tail (initial message, follow-up, pending steer, accepted steer) does
 * not displace the previous frontier of activity.
 */
export function findTimelineFrontierRow(
  rows: readonly ThreadTimelineViewRow[],
): ThreadTimelineViewRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    if (isUserConversationRow(row)) continue;
    return row;
  }
  return null;
}

/**
 * Returns the `id` of the trailing bundle-summary in `rows`, or `null` if the
 * trailing row is anything else. Callers pair this with a scope-active gate:
 * in active scopes (top-level when the thread is active, delegation childRows
 * when the delegation is pending), this id receives present-tense
 * "Exploring/Running" treatment. We do not search backward past a non-bundle
 * trailing row — a non-bundle tail means no bundle is currently the frontier
 * of activity. User-role conversation rows are skipped because they are
 * inputs to the agent, not events on the activity timeline.
 */
export function findActiveLatestBundleId(
  rows: readonly ThreadTimelineViewRow[],
): string | null {
  const frontier = findTimelineFrontierRow(rows);
  return frontier?.kind === "bundle-summary" ? frontier.id : null;
}

export function buildTimelineRowTitle(
  row: ThreadTimelineViewRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  switch (row.kind) {
    case "conversation":
      return mapConversationTitle(row);
    case "system":
      return mapSystemTitle(row);
    case "work":
      return mapWorkTitle(row, options);
    case "bundle-summary":
    case "step-summary":
      return mapWorkSummaryTitle(row, options);
    case "turn":
      return mapTurnTitle(row);
    default:
      return assertNever(row);
  }
}
