import {
  isBackgroundAgentTaskType,
  isBackgroundCommandTaskType,
  isSettledWorkflowAgentState,
} from "@bb/domain";
import type {
  TimelineActivityIntent,
  TimelineApprovalStatus,
  TimelineCommandWorkRow,
  TimelineExtensionWorkRow,
  TimelineFileChange,
  TimelineFileChangeWorkRow,
  TimelineFileReadWorkRow,
  TimelineImageViewWorkRow,
  TimelineParentChangeSystemRow,
  TimelinePlanStepsWorkRow,
  TimelineRowPresentation,
  TimelineRowStatus,
  TimelineSearchWorkRow,
  TimelineToolWorkRow,
  TimelineWebFetchWorkRow,
  TimelineWebSearchWorkRow,
} from "@bb/server-contract";
import { assertNever } from "./assert-never.js";
import { OWNERSHIP_CHANGE_VERBS } from "./family-a-verbs.js";
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
  timelineRowActivityIntents,
  type TimelineExplorationWorkRow,
} from "./timeline-activity-intents.js";
import {
  fileNameFromPath,
  formatTimelinePath,
} from "./timeline-path-display.js";
import {
  buildTimelineWorkSummaryLabelParts,
  type ThreadTimelineViewRow,
  type TimelineWorkSummaryRow,
  type TimelineViewDelegationWorkRow,
  type TimelineQuestionViewWorkRow,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
  type TimelineViewWorkflowWorkRow,
} from "./timeline-view.js";

export type TimelineTitleTone = "default" | "summary";
type TimelineStatusDecorationStatus = "denied" | "error" | "interrupted";

export type TimelineTitleLink = { kind: "thread"; threadId: string };

export type TimelineTitleSegmentAccent = "muted" | "subtle" | "file";

export interface TimelineTitleSegment {
  text: string;
  plainText?: string;
  em: boolean;
  shimmer: boolean;
  truncate: boolean;
  accent?: TimelineTitleSegmentAccent;
  link?: TimelineTitleLink;
}

export type TimelineTitleDecoration =
  | {
      kind: "duration";
      startedAt: number;
      completedAt: number | null;
      em: boolean;
    }
  | {
      kind: "status";
      status: TimelineStatusDecorationStatus;
      durationMs: number | null;
      emphasis: boolean;
    }
  | {
      kind: "summary-status";
      errorCount: number;
      interruptedCount: number;
    }
  | { kind: "diff-stats"; added: number; removed: number }
  | {
      kind: "badge";
      glyph: string;
      label: string;
      hint: string;
      tone: "neutral" | "destructive";
    };

export type TimelineTitleAction =
  | {
      kind: "open-file-diff";
      path: string;
    }
  | {
      kind: "open-plugin-side-chat";
      threadId: string;
    };

export interface TimelineTitle {
  segments: TimelineTitleSegment[];
  decorations: TimelineTitleDecoration[];
  tone: TimelineTitleTone;
  action: TimelineTitleAction | null;
  plain: string;
}

export interface BuildTimelineRowTitleOptions {
  summaryStyle: "bundle" | "background";
  workStyle: "default" | "summary";
  isActiveLatestBundle?: boolean;
}

export interface TimelineActivityIntentTitle {
  id: string;
  intent: TimelineActivityIntent;
  title: TimelineTitle;
  intentType: "read" | "list_files" | "search";
}

interface BuildTimelineActivityIntentTitleArgs {
  intent: TimelineActivityIntent;
  pending: boolean;
  failureStatus?: "error" | "interrupted";
  badges: readonly TimelineTitleDecoration[];
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
  accent?: TimelineTitleSegmentAccent;
}

function collapseTitleNewlines(text: string): string {
  return text.replace(/[\r\n]+/gu, " ");
}

function segment(
  text: string,
  opts: SegmentOptions = {},
): TimelineTitleSegment {
  return {
    text: collapseTitleNewlines(text),
    em: opts.em ?? false,
    shimmer: opts.shimmer ?? false,
    truncate: opts.truncate ?? false,
    ...(opts.plainText !== undefined
      ? { plainText: collapseTitleNewlines(opts.plainText) }
      : {}),
    ...(opts.link !== undefined ? { link: opts.link } : {}),
    ...(opts.accent !== undefined ? { accent: opts.accent } : {}),
  };
}

function filterNull<T>(values: (T | null)[]): T[] {
  return values.filter((v): v is T => v !== null);
}

function visibleDurationMs(durationMs: number | null): number | null {
  return durationMs !== null && durationMs > 1_000 ? durationMs : null;
}

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
    em: false,
  };
}

function badgeDecorations(row: {
  presentation?: TimelineRowPresentation;
}): TimelineTitleDecoration[] {
  const badge = row.presentation?.badge;
  if (badge === undefined) {
    return [];
  }
  return [
    {
      kind: "badge",
      glyph: badge.glyph,
      label: badge.label,
      hint: badge.hint,
      tone: badge.tone,
    },
  ];
}

function statusDecoration(
  status: TimelineStatusDecorationStatus,
  durationMs: number | null,
  options: { emphasis?: boolean } = {},
): TimelineTitleDecoration {
  return {
    kind: "status",
    status,
    durationMs: visibleDurationMs(durationMs),
    emphasis: options.emphasis ?? false,
  };
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

export function formatTimelineDecorationText(
  d: TimelineTitleDecoration,
): string {
  switch (d.kind) {
    case "duration": {
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
        parts.push(`${d.errorCount} error${d.errorCount > 1 ? "s" : ""}`);
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
    case "badge":
      return `(${d.label})`;
    default:
      return assertNever(d);
  }
}

function renderTitlePlain(
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

function presentationLabel(
  presentation: TimelineRowPresentation,
  status: TimelineRowStatus,
): string {
  return status === "pending"
    ? presentation.label.pending
    : presentation.label.completed;
}

interface PresentedTitleArgs {
  presentation: TimelineRowPresentation;
  status: TimelineRowStatus;
  startedAt: number;
  completedAt: number | null;
  content?: string | null;
  plainContent?: string;
  em?: boolean;
}

function presentedTitle({
  presentation,
  status,
  startedAt,
  completedAt,
  content,
  plainContent,
  em = true,
}: PresentedTitleArgs): TimelineTitle {
  const resolvedContent = content === undefined ? presentation.title : content;
  const segments: TimelineTitleSegment[] = [
    segment(presentationLabel(presentation, status), {
      shimmer: status === "pending",
      truncate: resolvedContent ? false : true,
    }),
  ];
  if (resolvedContent) {
    segments.push(
      segment(resolvedContent, {
        em,
        truncate: true,
        ...(plainContent === undefined ? {} : { plainText: plainContent }),
      }),
    );
  }
  const durationMs = completedAt !== null ? completedAt - startedAt : null;
  const decorations: TimelineTitleDecoration[] = [
    ...badgeDecorations({ presentation }),
    ...(status === "error"
      ? [statusDecoration("error", durationMs)]
      : status === "interrupted"
        ? [statusDecoration("interrupted", durationMs)]
        : filterNull([durationDecoration(startedAt, completedAt)])),
  ];
  return makeTitle({ segments, decorations });
}

function mapExecutionTitle(row: TimelineExecutionWorkRow): TimelineTitle {
  const status = displayStatus({
    approvalStatus: row.approvalStatus,
    status: row.status,
  });
  const isCommand = row.workKind === "command";
  if (
    row.presentation &&
    status !== "waiting" &&
    status !== "denied" &&
    !isCommand
  ) {
    return presentedTitle({
      presentation: row.presentation,
      status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    });
  }
  const content = isCommand
    ? row.command
    : formatToolCallCommand(row.toolName, row.toolArgs);
  const explorationTitle =
    row.workKind === "command" ? mapSingleExplorationIntentTitle(row) : null;
  if (explorationTitle !== null) {
    return explorationTitle;
  }
  const badges = badgeDecorations(row);
  switch (status) {
    case "waiting":
      return makeTitle({
        segments: [
          segment("Waiting for approval", { shimmer: true }),
          segment(isCommand ? "to run" : "to use"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: badges,
      });
    case "denied":
      return makeTitle({
        segments: [
          segment("Permission denied:"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: [
          ...badges,
          ...filterNull([durationDecoration(row.startedAt, row.completedAt)]),
        ],
      });
    case "pending":
      return makeTitle({
        segments: [
          segment(isCommand ? "Running" : "Running tool:", { shimmer: true }),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: [
          ...badges,
          ...filterNull([durationDecoration(row.startedAt, row.completedAt)]),
        ],
      });
    case "completed":
      return makeTitle({
        segments: [
          segment(isCommand ? "Ran" : "Ran tool"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: [
          ...badges,
          ...filterNull([durationDecoration(row.startedAt, row.completedAt)]),
        ],
      });
    case "error":
      return makeTitle({
        segments: [
          segment(isCommand ? "Ran" : "Ran tool"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: [
          ...badges,
          statusDecoration(
            "error",
            row.completedAt !== null ? row.completedAt - row.startedAt : null,
          ),
        ],
      });
    case "interrupted":
      return makeTitle({
        segments: [
          segment(isCommand ? "Ran" : "Ran tool"),
          segment(content, { em: true, truncate: true }),
        ],
        decorations: [
          ...badges,
          statusDecoration(
            "interrupted",
            row.completedAt !== null ? row.completedAt - row.startedAt : null,
          ),
        ],
      });
    default:
      return assertNever(status);
  }
}

function mapSingleExplorationIntentTitle(
  row: TimelineExplorationWorkRow,
): TimelineTitle | null {
  if (!hasTimelineExplorationIntent(row)) {
    return null;
  }
  const knownIntents = timelineRowActivityIntents(row).filter(
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
    approvalStatus: row.workKind === "command" ? row.approvalStatus : null,
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

  const badges = badgeDecorations(row);
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
      decorations: badges,
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
      decorations: badges,
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

  const decorations: TimelineTitleDecoration[] = [
    ...badges,
    ...(status === "error"
      ? [statusDecoration("error", null)]
      : status === "interrupted"
        ? [statusDecoration("interrupted", null)]
        : []),
  ];

  return makeTitle({ segments, decorations });
}

function mapFileChangeTitle(row: TimelineFileChangeWorkRow): TimelineTitle {
  const status = displayStatus({
    approvalStatus: row.approvalStatus,
    status: row.status,
  });
  const action = getFileChangeAction(row.change);
  const compactPath = formatFileChangePath({
    change: row.change,
    mode: "compact",
  });
  const fullPath = formatFileChangePath({ change: row.change, mode: "full" });
  const titleAction: TimelineTitleAction = {
    kind: "open-file-diff",
    path: row.change.movePath ?? row.change.path,
  };
  const pathSegment = segment(compactPath, {
    em: true,
    truncate: true,
    plainText: fullPath,
    accent: "file",
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
        segments: [segment(getFileChangeActionPastTense(action)), pathSegment],
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
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: row.queries.join(", "),
      em: false,
    });
  }
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
        decorations: filterNull([
          durationDecoration(row.startedAt, row.completedAt),
        ]),
      });
    case "error":
      return makeTitle({
        segments: [segment("Ran web search:"), querySegment],
        decorations: [
          statusDecoration(
            "error",
            row.completedAt !== null ? row.completedAt - row.startedAt : null,
          ),
        ],
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
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: row.url,
      em: false,
    });
  }
  const urlSegment = segment(row.url, { em: false, truncate: true });
  switch (row.status) {
    case "pending":
      return makeTitle({
        segments: [segment("Fetching:", { shimmer: true }), urlSegment],
      });
    case "completed":
      return makeTitle({
        segments: [segment("Fetched:"), urlSegment],
        decorations: filterNull([
          durationDecoration(row.startedAt, row.completedAt),
        ]),
      });
    case "error":
      return makeTitle({
        segments: [segment("Fetched:"), urlSegment],
        decorations: [
          statusDecoration(
            "error",
            row.completedAt !== null ? row.completedAt - row.startedAt : null,
          ),
        ],
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

function mapImageViewTitle(row: TimelineImageViewWorkRow): TimelineTitle {
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: fileNameFromPath(row.path),
      plainContent: row.path,
    });
  }
  const pathSegment = segment(fileNameFromPath(row.path), {
    em: false,
    plainText: row.path,
    truncate: true,
  });
  switch (row.status) {
    case "pending":
      return makeTitle({
        segments: [segment("Viewing image:", { shimmer: true }), pathSegment],
      });
    case "completed":
      return makeTitle({
        segments: [segment("Viewed image:"), pathSegment],
        decorations: filterNull([
          durationDecoration(row.startedAt, row.completedAt),
        ]),
      });
    case "error":
      return makeTitle({
        segments: [segment("Viewed image:"), pathSegment],
        decorations: [
          statusDecoration(
            "error",
            row.completedAt !== null ? row.completedAt - row.startedAt : null,
          ),
        ],
      });
    case "interrupted":
      return makeTitle({
        segments: [segment("Interrupted image view:"), pathSegment],
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

function mapDelegationTitle(row: TimelineViewDelegationWorkRow): TimelineTitle {
  const description = row.description ?? (row.output.trim() || row.toolName);
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: description,
    });
  }
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
  return makeTitle({
    segments,
    decorations: filterNull([
      durationDecoration(row.startedAt, row.completedAt),
    ]),
  });
}

function workflowVerbForStatus(status: TimelineRowStatus): {
  text: string;
  shimmer: boolean;
} {
  switch (status) {
    case "pending":
      return { text: "Running workflow:", shimmer: true };
    case "completed":
      return { text: "Ran workflow:", shimmer: false };
    case "error":
      return { text: "Failed workflow:", shimmer: false };
    case "interrupted":
      return { text: "Interrupted workflow:", shimmer: false };
    default:
      return assertNever(status);
  }
}

function formatWorkflowAgentProgress(
  row: TimelineViewWorkflowWorkRow,
): string | null {
  const agents = row.workflow?.agents ?? [];
  if (agents.length === 0) {
    return null;
  }
  const done = agents.filter((agent) =>
    isSettledWorkflowAgentState(agent.state),
  ).length;
  return `(${done}/${agents.length} agents)`;
}

function backgroundCommandVerbForStatus(status: TimelineRowStatus): {
  text: string;
  shimmer: boolean;
} {
  switch (status) {
    case "pending":
      return { text: "Running background command:", shimmer: true };
    case "completed":
      return { text: "Ran background command:", shimmer: false };
    case "error":
      return { text: "Background command failed:", shimmer: false };
    case "interrupted":
      return { text: "Background command interrupted:", shimmer: false };
    default:
      return assertNever(status);
  }
}

function backgroundAgentVerbForStatus(status: TimelineRowStatus): {
  text: string;
  shimmer: boolean;
} {
  switch (status) {
    case "pending":
      return { text: "Running background agent:", shimmer: true };
    case "completed":
      return { text: "Ran background agent:", shimmer: false };
    case "error":
      return { text: "Background agent failed:", shimmer: false };
    case "interrupted":
      return { text: "Background agent interrupted:", shimmer: false };
    default:
      return assertNever(status);
  }
}

function mapBackgroundCommandTitle(
  row: TimelineViewWorkflowWorkRow,
): TimelineTitle {
  const verb = backgroundCommandVerbForStatus(row.status);
  return makeTitle({
    segments: [
      segment(verb.text, { shimmer: verb.shimmer }),
      segment(row.description, { em: true, truncate: true }),
    ],
    decorations: filterNull([
      durationDecoration(row.startedAt, row.completedAt),
    ]),
  });
}

function mapBackgroundAgentTitle(
  row: TimelineViewWorkflowWorkRow,
): TimelineTitle {
  const verb = backgroundAgentVerbForStatus(row.status);
  return makeTitle({
    segments: [
      segment(verb.text, { shimmer: verb.shimmer }),
      segment(row.description, { em: true, truncate: true }),
    ],
    decorations: filterNull([
      durationDecoration(row.startedAt, row.completedAt),
    ]),
  });
}

function mapWorkflowTitle(row: TimelineViewWorkflowWorkRow): TimelineTitle {
  if (isBackgroundCommandTaskType(row.taskType)) {
    return mapBackgroundCommandTitle(row);
  }
  if (isBackgroundAgentTaskType(row.taskType)) {
    return mapBackgroundAgentTitle(row);
  }
  const verb = workflowVerbForStatus(row.status);
  const name = row.workflowName ?? row.description;
  const segments: TimelineTitleSegment[] = [
    segment(verb.text, { shimmer: verb.shimmer }),
    segment(name, { em: true, truncate: true }),
  ];
  const agentProgress = formatWorkflowAgentProgress(row);
  if (agentProgress) {
    segments.push(segment(agentProgress, { em: false }));
  }
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

function singleQuestion(
  row: TimelineQuestionViewWorkRow,
): TimelineQuestionViewWorkRow["questions"][number] | null {
  return row.questions.length === 1 ? (row.questions[0] ?? null) : null;
}

function singleQuestionAnswerSummary(
  row: TimelineQuestionViewWorkRow,
  question: TimelineQuestionViewWorkRow["questions"][number],
): string | null {
  const answer = row.answers?.[question.id];
  if (!answer) {
    return null;
  }
  const parts = answer.selected.map((value) => {
    const option = question.options?.find(
      (candidate) => candidate.value === value,
    );
    return option?.label ?? value;
  });
  if (answer.freeText) {
    parts.push(answer.freeText);
  }
  const text = parts.join(", ");
  return text.length > 0 ? text : null;
}

function mapQuestionTitle(row: TimelineQuestionViewWorkRow): TimelineTitle {
  const question = singleQuestion(row);
  const subject = question
    ? segment(question.prompt, { em: true, truncate: true })
    : segment(`${row.questions.length} questions`, { em: true });

  switch (row.lifecycle) {
    case "pending":
      return makeTitle({
        segments: [
          segment(question ? "Waiting for answer" : "Waiting for answers to", {
            shimmer: true,
          }),
          subject,
        ],
      });
    case "resolving":
      return makeTitle({
        segments: [
          segment(question ? "Delivering answer" : "Delivering answers to", {
            shimmer: true,
          }),
          subject,
        ],
      });
    case "answered": {
      const answerSummary = question
        ? singleQuestionAnswerSummary(row, question)
        : null;
      return makeTitle({
        segments: filterNull([
          segment("Answered"),
          subject,
          answerSummary
            ? segment(`— ${answerSummary}`, { truncate: true })
            : null,
        ]),
      });
    }
    case "interrupted":
      return makeTitle({
        segments: [segment("Asked"), subject],
        decorations: [statusDecoration("interrupted", null)],
      });
    default:
      return assertNever(row.lifecycle);
  }
}

function mapFileReadTitle(row: TimelineFileReadWorkRow): TimelineTitle {
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: formatTimelinePath({ path: row.path, mode: "compact" }),
      plainContent: row.path,
    });
  }
  return (
    mapSingleExplorationIntentTitle(row) ??
    makeTitle({
      segments: [
        segment(row.status === "pending" ? "Reading" : "Read", {
          shimmer: row.status === "pending",
        }),
        segment(row.path, { em: true, truncate: true }),
      ],
    })
  );
}

function searchContent(row: TimelineSearchWorkRow): string {
  const root = row.path ? ` in ${row.path}` : "";
  switch (row.mode) {
    case "content":
      return `for ${row.query}${root}`;
    case "path":
      return `matching ${row.query}${root}`;
    case "list":
      return row.path
        ? `in ${row.path}`
        : row.query.length > 0
          ? `in ${row.query}`
          : "";
    default:
      return assertNever(row.mode);
  }
}

function mapSearchTitle(row: TimelineSearchWorkRow): TimelineTitle {
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: searchContent(row),
      em: false,
    });
  }
  return (
    mapSingleExplorationIntentTitle(row) ??
    makeTitle({
      segments: [
        segment(row.status === "pending" ? "Searching" : "Searched", {
          shimmer: row.status === "pending",
        }),
        segment(searchContent(row), { truncate: true }),
      ],
    })
  );
}

function activePlanStep(row: TimelinePlanStepsWorkRow): string | null {
  const active = row.steps.find((step) => step.status === "active");
  return active?.step ?? row.explanation;
}

function mapPlanStepsTitle(row: TimelinePlanStepsWorkRow): TimelineTitle {
  const content = activePlanStep(row);
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: row.presentation.title ?? content,
      em: false,
    });
  }
  const completedSteps = row.steps.filter(
    (step) => step.status === "completed",
  ).length;
  return makeTitle({
    segments: [
      segment(row.status === "pending" ? "Updating plan" : "Updated plan", {
        shimmer: row.status === "pending",
      }),
      segment(content ?? `${completedSteps}/${row.steps.length} steps done`, {
        truncate: true,
      }),
    ],
    decorations: filterNull([
      durationDecoration(row.startedAt, row.completedAt),
    ]),
  });
}

function mapExtensionTitle(row: TimelineExtensionWorkRow): TimelineTitle {
  return presentedTitle({
    presentation: row.presentation,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    em: false,
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
      case "file-read":
        return mapFileReadTitle(row);
      case "search":
        return mapSearchTitle(row);
      case "plan-steps":
        return mapPlanStepsTitle(row);
      case "extension":
        return mapExtensionTitle(row);
      case "file-change":
        return mapFileChangeTitle(row);
      case "web-search":
        return mapWebSearchTitle(row);
      case "web-fetch":
        return mapWebFetchTitle(row);
      case "image-view":
        return mapImageViewTitle(row);
      case "delegation":
        return mapDelegationTitle(row);
      case "workflow":
        return mapWorkflowTitle(row);
      case "approval":
        return mapApprovalTitle(row);
      case "question":
        return mapQuestionTitle(row);
      default:
        return assertNever(row);
    }
  })();
  if (options.workStyle === "default") {
    return title;
  }
  return {
    ...title,
    tone: "summary",
  };
}

function mapWorkSummaryTitle(
  row: TimelineWorkSummaryRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
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
  const settledAccent: TimelineTitleSegmentAccent | undefined = isActive
    ? undefined
    : "subtle";
  const verbSegment = segment(verb, {
    shimmer: isActive,
    accent: settledAccent,
  });
  if (rest.length === 0) {
    return makeTitle({
      segments: [{ ...verbSegment, truncate: true }],
      decorations,
    });
  }
  return makeTitle({
    segments: [
      verbSegment,
      segment(rest, { em: true, truncate: true, accent: settledAccent }),
    ],
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
    return makeTitle({
      segments: [segment("Worked for", { shimmer: false, accent: "subtle" })],
      decorations: [durationDeco],
    });
  }
  return makeTitle({
    segments: [
      segment(isPending ? "Working" : "Worked", {
        shimmer: isPending,
        accent: isPending ? undefined : "subtle",
      }),
    ],
    decorations: isPending && durationDeco !== null ? [durationDeco] : [],
  });
}

function parentChangeThreadSegment(
  row: TimelineParentChangeSystemRow,
  name: string,
  shimmer: boolean,
): TimelineTitleSegment {
  return segment(name, {
    em: true,
    truncate: true,
    shimmer,
    ...(row.threadId.length > 0
      ? { link: { kind: "thread", threadId: row.threadId } }
      : {}),
  });
}

function parentChangeParentSegment(
  threadId: string | null,
  title: string | null,
): TimelineTitleSegment {
  if (threadId === null) {
    return segment("parent");
  }
  return segment(title ?? threadId, {
    em: true,
    truncate: true,
    link: { kind: "thread", threadId },
  });
}

function parentChangeThreadName(row: TimelineParentChangeSystemRow): string {
  const verb = OWNERSHIP_CHANGE_VERBS[row.parentChange.action];
  const parentTitle =
    row.parentChange.action === "release"
      ? row.parentChange.previousParentThreadTitle
      : row.parentChange.nextParentThreadTitle;
  const parent =
    parentTitle !== null && parentTitle.trim().length > 0
      ? parentTitle.trim()
      : "parent";
  const suffix = ` ${verb} ${parent}`;
  if (row.title.endsWith(suffix) && row.title.length > suffix.length) {
    return row.title.slice(0, row.title.length - suffix.length);
  }
  return row.threadId;
}

function mapParentChangeSystemTitle(
  row: TimelineParentChangeSystemRow,
): TimelineTitle {
  const assignment = row.parentChange;
  const shimmer = row.status === "pending";
  const verb = OWNERSHIP_CHANGE_VERBS[assignment.action];
  const threadSegment = parentChangeThreadSegment(
    row,
    parentChangeThreadName(row),
    shimmer,
  );
  const parentSegment =
    assignment.action === "release"
      ? parentChangeParentSegment(
          assignment.previousParentThreadId,
          assignment.previousParentThreadTitle,
        )
      : parentChangeParentSegment(
          assignment.nextParentThreadId,
          assignment.nextParentThreadTitle,
        );

  const segments: TimelineTitleSegment[] = [
    threadSegment,
    segment(verb, { shimmer, accent: "muted" }),
    parentSegment,
  ];

  const decorations: TimelineTitleDecoration[] = (() => {
    switch (row.status) {
      case "error":
        return [statusDecoration("error", null, { emphasis: true })];
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
  });
}

function mapSystemTitle(row: TimelineSystemViewRow): TimelineTitle {
  const hasError = row.systemKind === "error" || row.status === "error";
  if (row.systemKind === "operation" && row.operationKind === "parent-change") {
    return mapParentChangeSystemTitle(row);
  }
  const isCompaction =
    row.systemKind === "operation" && row.operationKind === "compaction";
  const titleText =
    isCompaction && row.status === "pending" ? `${row.title}…` : row.title;
  const decorations: TimelineTitleDecoration[] = hasError
    ? [statusDecoration("error", null, { emphasis: true })]
    : isCompaction && (row.status === "pending" || row.status === "completed")
      ? filterNull([durationDecoration(row.startedAt, row.completedAt)])
      : [];
  const shimmer = row.status === "pending";
  return makeTitle({
    segments: [segment(titleText, { shimmer, truncate: true })],
    decorations,
  });
}

function mapConversationTitle(row: TimelineConversationViewRow): TimelineTitle {
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
  badges,
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
  const decorations = [
    ...badges,
    ...(failureStatus ? [statusDecoration(failureStatus, null)] : []),
  ];
  return makeTitle({ segments, decorations });
}

export function buildTimelineActivityIntentTitles(
  row: TimelineExplorationWorkRow,
): TimelineActivityIntentTitle[] {
  if (!hasTimelineExplorationIntent(row)) {
    return [];
  }

  let lastEmittedKey: string | null = null;
  const titles: TimelineActivityIntentTitle[] = [];
  const badges = badgeDecorations(row);
  const failureStatus =
    row.status === "error"
      ? "error"
      : row.status === "interrupted"
        ? "interrupted"
        : undefined;

  timelineRowActivityIntents(row).forEach((intent, index) => {
    if (intent.type === "unknown") {
      return;
    }
    const dedupeKey = getTimelineActivityIntentDetailDedupeKey(intent);
    if (dedupeKey !== null && dedupeKey === lastEmittedKey) {
      return;
    }
    titles.push({
      id: `${row.id}:activity-intent:${index}`,
      intent,
      intentType: intent.type,
      title: mapTimelineActivityIntentTitle({
        intent,
        pending: row.status === "pending",
        badges: titles.length === 0 ? badges : [],
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
