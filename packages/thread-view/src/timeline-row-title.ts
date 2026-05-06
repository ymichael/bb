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
  getFileChangeActionInfinitive,
  getFileChangeActionPastTense,
  getFileChangeActionPresentTense,
} from "./file-change-summary.js";
import { durationToCompactString } from "./format-helpers.js";
import {
  formatTimelineActivityIntentDetailParts,
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  type TimelineExplorationWorkRow,
} from "./timeline-activity-intents.js";
import {
  buildTimelineWorkSummaryLabelParts,
  isTimelineStepBoundary,
  type ThreadTimelineViewRow,
  type TimelineWorkSummaryRow,
  type TimelineViewDelegationWorkRow,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
} from "./timeline-view.js";

export type TimelineTitleTone = "default" | "destructive" | "summary";

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
}

export type TimelineTitleDecoration =
  | {
      kind: "duration";
      durationMs: number;
      /**
       * `true` when the row is still actively running and the App should
       * tick the duration locally between server snapshots. CLI rendering
       * always shows the static `durationMs`.
       */
      live: boolean;
    }
  | {
      kind: "status";
      status: "error" | "interrupted";
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
}

function segment(text: string, opts: SegmentOptions = {}): TimelineTitleSegment {
  return {
    text,
    em: opts.em ?? false,
    shimmer: opts.shimmer ?? false,
    truncate: opts.truncate ?? false,
    ...(opts.plainText !== undefined ? { plainText: opts.plainText } : {}),
  };
}

function filterNull<T>(values: (T | null)[]): T[] {
  return values.filter((v): v is T => v !== null);
}

function visibleDurationMs(durationMs: number | null): number | null {
  return durationMs !== null && durationMs > 1_000 ? durationMs : null;
}

function durationDecoration(
  durationMs: number | null,
  options: { live?: boolean } = {},
): TimelineTitleDecoration | null {
  const visible = visibleDurationMs(durationMs);
  if (visible === null) return null;
  return { kind: "duration", durationMs: visible, live: options.live ?? false };
}

function statusDecoration(
  status: "error" | "interrupted",
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
    case "duration":
      return `(${durationToCompactString(d.durationMs)})`;
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
    case "diff-stats": {
      const parts: string[] = [];
      if (d.added > 0) parts.push(`+${d.added}`);
      if (d.removed > 0) parts.push(`-${d.removed}`);
      return parts.join(" ");
    }
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
  const content = isCommand ? row.command : row.label;
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
        decorations: filterNull([durationDecoration(row.durationMs)]),
        tone: "destructive",
      });
    case "pending":
      return makeTitle({
        segments: [
          segment(isCommand ? "Running" : "Running tool:", { shimmer: true }),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: filterNull([
          durationDecoration(row.durationMs, { live: true }),
        ]),
      });
    case "completed":
      return makeTitle({
        segments: [
          segment(isCommand ? "Ran" : "Ran tool:"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: filterNull([durationDecoration(row.durationMs)]),
      });
    case "error":
      return makeTitle({
        segments: [
          segment(isCommand ? "Ran" : "Ran tool:"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: [statusDecoration("error", row.durationMs)],
      });
    case "interrupted":
      return makeTitle({
        segments: [
          segment(isCommand ? "Ran" : "Ran tool:"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: [statusDecoration("interrupted", row.durationMs)],
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
      tone: "destructive",
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
        tone: "destructive",
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
      return makeTitle({
        segments: [
          segment("Running web search:", { shimmer: true }),
          querySegment,
        ],
      });
    case "completed":
      return makeTitle({
        segments: [segment("Ran web search:"), querySegment],
      });
    case "error":
      return makeTitle({
        segments: [segment("Ran web search:"), querySegment],
        decorations: [statusDecoration("error", null)],
      });
    case "interrupted":
      return makeTitle({
        segments: [segment("Interrupted web search:"), querySegment],
      });
    default:
      return assertNever(row.status);
  }
}

function mapWebFetchTitle(row: TimelineWebFetchWorkRow): TimelineTitle {
  const urlSegment = segment(row.url, { em: false, truncate: true });
  switch (row.status) {
    case "pending":
      return makeTitle({
        segments: [segment("Fetching:", { shimmer: true }), urlSegment],
      });
    case "completed":
      return makeTitle({
        segments: [segment("Fetched:"), urlSegment],
      });
    case "error":
      return makeTitle({
        segments: [segment("Fetched:"), urlSegment],
        decorations: [statusDecoration("error", null)],
      });
    case "interrupted":
      return makeTitle({
        segments: [segment("Interrupted fetch:"), urlSegment],
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
      durationDecoration(row.durationMs, { live: row.status === "pending" }),
    ]),
  });
}

function mapApprovalTitle(row: TimelineApprovalWorkRow): TimelineTitle {
  return makeTitle({
    segments: [
      segment(row.title, {
        em: false,
        truncate: true,
        shimmer: row.status === "pending",
      }),
    ],
  });
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
  const verbSegment = segment(verb, { shimmer: isActive });
  if (rest.length === 0) {
    return makeTitle({
      segments: [{ ...verbSegment, truncate: true }],
      decorations,
    });
  }
  return makeTitle({
    segments: [
      verbSegment,
      segment(rest, { em: false, truncate: true, shimmer: isActive }),
    ],
    decorations,
  });
}

function mapTurnTitle(row: TimelineViewTurnRow): TimelineTitle {
  const status = row.status;
  const durationDeco = durationDecoration(row.durationMs, {
    live: status === "pending",
  });
  if (durationDeco !== null) {
    return makeTitle({
      segments: [
        segment(status === "pending" ? "Working for" : "Worked for", {
          shimmer: status === "pending",
        }),
      ],
      decorations: [durationDeco],
    });
  }
  return makeTitle({
    segments: [
      segment(status === "pending" ? "Working" : "Worked", {
        shimmer: status === "pending",
      }),
    ],
  });
}

function mapSystemTitle(row: TimelineSystemViewRow): TimelineTitle {
  const hasErrorTone = row.systemKind === "error" || row.status === "error";
  const text =
    row.systemKind === "error" ? `Error: ${row.title}` : row.title;
  return makeTitle({
    segments: [
      segment(text, {
        em: hasErrorTone,
        shimmer: row.status === "pending",
        truncate: true,
      }),
    ],
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
  return makeTitle({ segments });
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
      title: mapTimelineActivityIntentTitle({
        intent,
        pending: row.status === "pending",
      }),
    });
  });

  return titles;
}

/**
 * Returns the `id` of the bundle-summary that should render as the open step's
 * active-latest bundle, or `null` when no such bundle exists. The active-latest
 * bundle is the *most recent work row* after the last step boundary, but only
 * when that row is itself a `bundle-summary`. A trailing leaf (single same-step
 * work row of a different concept) displaces any earlier bundle, so the
 * earlier bundle renders completed-not-latest. Pending steers (user
 * conversation rows with `userRequest.status === "pending"`) sit at the tail
 * outside the open step and do not count as boundaries.
 */
export function findActiveLatestBundleId(
  rows: readonly ThreadTimelineViewRow[],
): string | null {
  // Single backward pass: the first work or bundle-summary we hit is the
  // step's most recent activity. If we hit a step boundary first, the open
  // step has no work yet.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    if (isTimelineStepBoundary(row)) {
      return null;
    }
    if (row.kind === "bundle-summary") {
      return row.id;
    }
    if (row.kind === "work") {
      return null;
    }
  }
  return null;
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
