import type {
  TimelineCommandWorkRow,
  TimelineFileChange,
  TimelineFileChangeWorkRow,
  TimelineRow,
  TimelineRowStatus,
  TimelineToolWorkRow,
  TimelineWebFetchWorkRow,
  TimelineWebSearchWorkRow,
} from "@bb/server-contract";
import { assertNever } from "./assert-never.js";
import { durationToCompactString, plural } from "./format-helpers.js";
import {
  buildTimelineActivitySummaryLabel,
  buildTimelineViewRows,
} from "./timeline-view.js";
import {
  formatFileChangePath,
  getFileChangeAction,
  getFileChangeActionPastTense,
  getFileChangeActionPresentTense,
} from "./file-change-summary.js";
import {
  formatTimelineActivityIntentDetail,
  formatTimelineActivityIntentTitle,
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  primaryTimelineActivityIntent,
  type TimelineExplorationWorkRow,
} from "./timeline-activity-intents.js";
import type {
  ThreadTimelineViewRow,
  TimelineActivitySummaryRow,
  TimelineViewDelegationWorkRow,
  TimelineViewTurnRow,
  TimelineViewWorkRow,
} from "./timeline-view.js";

export type ThreadTimelineTextFormat = "json" | "minimal" | "verbose";

export interface ThreadTimelineTextOptions {
  verbose?: boolean;
  color?: boolean;
  truncateForAudit?: boolean;
}

interface TimelineTextFormatContext {
  verbose: boolean;
  color: boolean;
  depth: number;
  truncateForAudit: boolean;
}

type TimelineConversationViewRow = Extract<
  ThreadTimelineViewRow,
  { kind: "conversation" }
>;

interface AuditTruncationNoticeOptions {
  skippedLineCount: number;
  indent: number;
}

const AUDIT_BODY_LINE_LIMIT = 3;
const AUDIT_LINE_LENGTH_LIMIT = 100;

function dim(text: string, color: boolean): string {
  return color ? `\x1b[2m${text}\x1b[22m` : text;
}

function green(text: string, color: boolean): string {
  return color ? `\x1b[32m${text}\x1b[39m` : text;
}

function yellow(text: string, color: boolean): string {
  return color ? `\x1b[33m${text}\x1b[39m` : text;
}

function red(text: string, color: boolean): string {
  return color ? `\x1b[31m${text}\x1b[39m` : text;
}

function cyan(text: string, color: boolean): string {
  return color ? `\x1b[36m${text}\x1b[39m` : text;
}

function separator(label: string, color: boolean): string {
  const pad = Math.max(0, 60 - label.length - 4);
  const suffix = "─".repeat(pad);
  return dim(
    suffix.length > 0 ? `── ${label} ${suffix}` : `── ${label}`,
    color,
  );
}

function rowHeader(label: string, context: TimelineTextFormatContext): string {
  if (context.depth === 0) {
    return separator(label, context.color);
  }
  return dim(`── ${label}`, context.color);
}

function nestedContext(
  context: TimelineTextFormatContext,
): TimelineTextFormatContext {
  return {
    ...context,
    depth: context.depth + 1,
  };
}

function indentBlock(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${prefix}${line}`))
    .join("\n");
}

function lineIndent(line: string): number {
  return /^\s*/u.exec(line)?.[0].length ?? 0;
}

function auditTruncatedLine(line: string): string {
  if (line.length <= AUDIT_LINE_LENGTH_LIMIT) {
    return line;
  }

  const omittedCharacterCount = line.length - AUDIT_LINE_LENGTH_LIMIT;
  return `${line.slice(0, AUDIT_LINE_LENGTH_LIMIT)}... [truncated ${omittedCharacterCount} chars]`;
}

function auditTruncatedLinesNotice(
  options: AuditTruncationNoticeOptions,
): string {
  return `${" ".repeat(options.indent)}... [truncated ${options.skippedLineCount} lines]`;
}

function auditTruncationNoticeIndent(
  skippedLines: readonly string[],
  fallbackLines: readonly string[],
): number {
  const skippedLineIndents = skippedLines
    .filter((line) => line.length > 0)
    .map(lineIndent);
  if (skippedLineIndents.length > 0) {
    return Math.min(...skippedLineIndents);
  }

  const fallbackLineIndents = fallbackLines
    .filter((line) => line.length > 0)
    .map(lineIndent);
  return fallbackLineIndents.length > 0 ? Math.min(...fallbackLineIndents) : 0;
}

function truncateBodyLinesForAudit(lines: readonly string[]): string[] {
  const bodyLines = lines.flatMap((line) => line.split("\n"));
  const visibleLines = bodyLines
    .slice(0, AUDIT_BODY_LINE_LIMIT)
    .map(auditTruncatedLine);
  const skippedLines = bodyLines.slice(AUDIT_BODY_LINE_LIMIT);
  if (skippedLines.length === 0) {
    return visibleLines;
  }

  return [
    ...visibleLines,
    auditTruncatedLinesNotice({
      skippedLineCount: skippedLines.length,
      indent: auditTruncationNoticeIndent(skippedLines, visibleLines),
    }),
  ];
}

function maybeTruncateBodyLinesForAudit(
  lines: readonly string[],
  context: TimelineTextFormatContext,
): string[] {
  if (!context.truncateForAudit) {
    return [...lines];
  }
  return truncateBodyLinesForAudit(lines);
}

function statusVerb(status: TimelineRowStatus, running: string, past: string) {
  switch (status) {
    case "pending":
      return running;
    case "completed":
      return past;
    case "error":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      return assertNever(status);
  }
}

function plainStatusLabel(status: TimelineRowStatus): string {
  switch (status) {
    case "pending":
      return "running";
    case "completed":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
      return "interrupted";
    default:
      return assertNever(status);
  }
}

function statusLabel(status: TimelineRowStatus, color: boolean): string {
  switch (status) {
    case "pending":
      return yellow("running", color);
    case "completed":
      return green("completed", color);
    case "error":
      return red("error", color);
    case "interrupted":
      return yellow("interrupted", color);
    default:
      return assertNever(status);
  }
}

function workStatusLabel(row: TimelineViewWorkRow, color: boolean): string {
  if (
    (row.workKind === "command" ||
      row.workKind === "tool" ||
      row.workKind === "file-change") &&
    row.approvalStatus === "denied"
  ) {
    return red("denied", color);
  }
  if (
    (row.workKind === "command" ||
      row.workKind === "tool" ||
      row.workKind === "file-change") &&
    row.approvalStatus === "waiting_for_approval"
  ) {
    return yellow("waiting", color);
  }
  return statusLabel(row.status, color);
}

function formatDiffStats(change: TimelineFileChange): string | null {
  const { added, removed } = change.diffStats;
  if (added === 0 && removed === 0) {
    return null;
  }
  if (added === 0) {
    return `-${removed}`;
  }
  if (removed === 0) {
    return `+${added}`;
  }
  return `+${added} -${removed}`;
}

function formatFileChangeTitle(row: TimelineFileChangeWorkRow): string {
  const change = row.change;
  const action = getFileChangeAction(change);
  const completedVerb = getFileChangeActionPastTense(action);
  const verb =
    row.status === "pending"
      ? getFileChangeActionPresentTense(action)
      : statusVerb(row.status, "Editing", completedVerb);
  const stats = formatDiffStats(change);
  return [verb, formatFileChangePath({ change, mode: "full" }), stats]
    .filter(Boolean)
    .join(" ");
}

function formatStatusDurationSuffix(
  status: TimelineRowStatus,
  durationMs: number | null,
): string {
  const parts = [plainStatusLabel(status)];
  if (durationMs !== null) {
    parts.push(durationToCompactString(durationMs));
  }
  return `(${parts.join(", ")})`;
}

function formatCommandTitle(row: TimelineCommandWorkRow): string {
  const intent = primaryTimelineActivityIntent(row);
  if (intent) {
    return formatTimelineActivityIntentTitle({
      intent,
      pathMode: "full",
      pending: row.status === "pending",
    });
  }
  if (row.approvalStatus === "waiting_for_approval") {
    return "Command (waiting)";
  }
  if (row.approvalStatus === "denied") {
    return "Command (denied)";
  }
  if (row.status === "error") {
    const duration =
      row.durationMs !== null
        ? ` ${durationToCompactString(row.durationMs)}`
        : "";
    return `Ran command${duration}`;
  }
  const verb = row.status === "pending" ? "Running" : "Ran";
  return `${verb} command ${formatStatusDurationSuffix(row.status, row.durationMs)}`;
}

function formatToolTitle(row: TimelineToolWorkRow): string {
  const intent = primaryTimelineActivityIntent(row);
  if (intent) {
    return formatTimelineActivityIntentTitle({
      intent,
      pathMode: "full",
      pending: row.status === "pending",
    });
  }
  if (row.approvalStatus === "waiting_for_approval") {
    return `Tool (waiting): ${row.label}`;
  }
  if (row.approvalStatus === "denied") {
    return `Tool (denied): ${row.label}`;
  }
  const verb = statusVerb(row.status, "Running", "Ran");
  return `${verb} tool: ${row.label}`;
}

function formatDelegationTitle(row: TimelineViewDelegationWorkRow): string {
  const description = row.description ?? (row.output.trim() || row.toolName);
  const metadata = row.subagentType ? ` (${row.subagentType})` : "";
  const duration =
    row.durationMs !== null
      ? ` ${durationToCompactString(row.durationMs)}`
      : "";
  return `${statusVerb(row.status, "Running subagent", "Ran subagent")}: ${description}${metadata}${duration}`;
}

function formatWebSearchTitle(row: TimelineWebSearchWorkRow): string {
  const query = row.queries.join(", ") || "web search";
  switch (row.status) {
    case "pending":
      return `Running web search: ${query}`;
    case "completed":
      return `Ran web search: ${query}`;
    case "error":
      return `Failed web search: ${query}`;
    case "interrupted":
      return `Interrupted web search: ${query}`;
    default:
      return assertNever(row.status);
  }
}

function formatWebFetchTitle(row: TimelineWebFetchWorkRow): string {
  switch (row.status) {
    case "pending":
      return `Fetching: ${row.url}`;
    case "completed":
      return `Fetched: ${row.url}`;
    case "error":
      return `Failed fetch: ${row.url}`;
    case "interrupted":
      return `Interrupted fetch: ${row.url}`;
    default:
      return assertNever(row.status);
  }
}

function formatWorkTitle(row: TimelineViewWorkRow): string {
  switch (row.workKind) {
    case "command":
      return formatCommandTitle(row);
    case "tool":
      return formatToolTitle(row);
    case "file-change":
      return formatFileChangeTitle(row);
    case "web-search":
      return formatWebSearchTitle(row);
    case "web-fetch":
      return formatWebFetchTitle(row);
    case "approval":
      return row.title;
    case "delegation":
      return formatDelegationTitle(row);
    default:
      return assertNever(row);
  }
}

function formatWorkOutput(output: string, color: boolean): string {
  return dim(indentBlock(output.trim(), "  "), color);
}

function formatCommandExitCodeLine(
  row: TimelineCommandWorkRow,
  color: boolean,
): string | null {
  if (row.exitCode === null || row.status === "pending") {
    return null;
  }
  if (row.exitCode === 0 && row.output.trim().length > 0) {
    return null;
  }
  if (row.exitCode === 0) {
    return dim("  exit code 0", color);
  }
  return red(`  exit ${row.exitCode}`, color);
}

function formatWorkBody(
  row: TimelineViewWorkRow,
  context: TimelineTextFormatContext,
): string[] {
  const lines: string[] = [];
  switch (row.workKind) {
    case "command":
      lines.push(`  $ ${cyan(row.command, context.color)}`);
      if (
        context.verbose &&
        row.output.trim() &&
        !hasTimelineExplorationIntent(row)
      ) {
        lines.push(formatWorkOutput(row.output, context.color));
      }
      const exitCodeLine = formatCommandExitCodeLine(row, context.color);
      if (exitCodeLine) {
        lines.push(exitCodeLine);
      }
      return lines;
    case "tool":
      if (row.approvalStatus !== null) {
        lines.push(`  ${workStatusLabel(row, context.color)}`);
      }
      if (
        context.verbose &&
        row.output.trim() &&
        !hasTimelineExplorationIntent(row)
      ) {
        lines.push(formatWorkOutput(row.output, context.color));
      }
      return lines;
    case "file-change":
      if (row.approvalStatus !== null) {
        lines.push(`  ${workStatusLabel(row, context.color)}`);
      }
      if (context.verbose && row.change.diff) {
        lines.push(
          dim(indentBlock(row.change.diff.trimEnd(), "  "), context.color),
        );
      }
      return lines;
    case "web-search":
      if (context.verbose && row.resultText) {
        lines.push(dim(indentBlock(row.resultText, "  "), context.color));
      }
      return lines;
    case "web-fetch":
      if (context.verbose && row.resultText) {
        lines.push(dim(indentBlock(row.resultText, "  "), context.color));
      }
      return lines;
    case "approval":
      return lines;
    case "delegation":
      if (row.childRows.length > 0) {
        lines.push(
          indentBlock(formatRows(row.childRows, nestedContext(context)), "  "),
        );
      }
      return lines;
    default:
      return assertNever(row);
  }
}

function formatWorkRow(
  row: TimelineViewWorkRow,
  context: TimelineTextFormatContext,
): string {
  const lines = [rowHeader(formatWorkTitle(row), context)];
  const bodyLines = formatWorkBody(row, context);
  lines.push(
    ...(row.workKind === "delegation"
      ? bodyLines
      : maybeTruncateBodyLinesForAudit(bodyLines, context)),
  );
  return lines.join("\n");
}

function formatExplorationWorkDetails(
  row: TimelineExplorationWorkRow,
  dedupedDetailKeys: Set<string>,
): string[] {
  const details: string[] = [];
  for (const intent of row.activityIntents) {
    if (intent.type === "unknown") {
      continue;
    }
    const dedupeKey = getTimelineActivityIntentDetailDedupeKey(intent);
    if (dedupeKey !== null) {
      if (dedupedDetailKeys.has(dedupeKey)) {
        continue;
      }
      dedupedDetailKeys.add(dedupeKey);
    }
    details.push(
      formatTimelineActivityIntentDetail({ intent, pathMode: "full" }),
    );
  }
  return details;
}

function formatActivitySummaryDetails(
  row: TimelineActivitySummaryRow,
  context: TimelineTextFormatContext,
): string[] {
  const lines: string[] = [];
  const dedupedDetailKeys = new Set<string>();
  const childContext = nestedContext(context);
  for (const child of row.children) {
    if (
      (child.workKind === "command" || child.workKind === "tool") &&
      hasTimelineExplorationIntent(child)
    ) {
      lines.push(
        ...formatExplorationWorkDetails(child, dedupedDetailKeys).map(
          (detail) => rowHeader(detail, childContext),
        ),
      );
      continue;
    }
    if (child.workKind === "web-search" || child.workKind === "web-fetch") {
      lines.push(rowHeader(formatWorkTitle(child), childContext));
      continue;
    }
    lines.push(formatWorkRow(child, childContext));
  }
  return lines;
}

function formatActivitySummary(
  row: TimelineActivitySummaryRow,
  context: TimelineTextFormatContext,
): string {
  const lines = [rowHeader(buildTimelineActivitySummaryLabel(row), context)];
  if (context.verbose) {
    const details = formatActivitySummaryDetails(row, context);
    if (details.length > 0) {
      lines.push(indentBlock(details.join("\n"), "  "));
    }
  }
  return lines.join("\n");
}

function formatTurnTitle(row: TimelineViewTurnRow): string {
  if (row.durationMs !== null && row.durationMs >= 1_000) {
    return `Worked for ${durationToCompactString(row.durationMs)}`;
  }
  if (row.summaryCount > 0) {
    return `Worked on ${plural(row.summaryCount, "item")}`;
  }
  return "Turn";
}

function formatConversationRequestLabel(
  row: TimelineConversationViewRow,
): string | null {
  if (row.role !== "user" || row.userRequest.kind !== "steer") {
    return null;
  }
  return row.userRequest.status === "pending" ? "steer pending" : "steer";
}

function formatRow(
  row: ThreadTimelineViewRow,
  context: TimelineTextFormatContext,
): string {
  switch (row.kind) {
    case "conversation":
      return [
        rowHeader(row.role === "user" ? "User" : "Assistant", context),
        maybeTruncateBodyLinesForAudit(row.text.split("\n"), context).join(
          "\n",
        ),
        formatConversationRequestLabel(row),
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
    case "work":
      return formatWorkRow(row, context);
    case "system":
      if (row.systemKind === "reconnect") {
        return rowHeader(row.title, context);
      }
      if (row.systemKind === "error") {
        return [
          rowHeader("Error", context),
          dim(indentBlock(row.title, "  "), context.color),
        ]
          .filter((line) => line.length > 0)
          .join("\n");
      }
      return [
        rowHeader(row.title, context),
        row.detail ? dim(indentBlock(row.detail, "  "), context.color) : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    case "activity-summary":
      return formatActivitySummary(row, context);
    case "turn": {
      const label = formatTurnTitle(row);
      if (!row.children || row.children.length === 0) {
        return rowHeader(label, context);
      }
      return [
        rowHeader(label, context),
        indentBlock(formatRows(row.children, nestedContext(context)), "  "),
      ].join("\n");
    }
    default:
      return assertNever(row);
  }
}

function formatRows(
  rows: readonly ThreadTimelineViewRow[],
  context: TimelineTextFormatContext,
): string {
  return rows.map((row) => formatRow(row, context)).join("\n\n");
}

export function formatThreadTimelineText(
  rows: readonly TimelineRow[],
  options?: ThreadTimelineTextOptions,
): string {
  const viewRows = buildTimelineViewRows(rows);
  return formatRows(viewRows, {
    verbose: options?.verbose ?? false,
    color: options?.color ?? false,
    depth: 0,
    truncateForAudit: options?.truncateForAudit ?? false,
  });
}
