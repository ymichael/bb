import type {
  TimelineAssistantStepSummaryRow,
  TimelineRow,
  TimelineToolBundleRow,
  TimelineTurnSummaryRow,
  ViewAssistantTextMessage,
  ViewCommandMessage,
  ViewPermissionGrantLifecycleMessage,
  ViewDelegationMessage,
  ViewErrorMessage,
  ViewFileEditMessage,
  ViewMessage,
  ViewOperationMessage,
  ViewTasksMessage,
  ViewToolCallMessage,
  ViewUserMessage,
  ViewWebFetchMessage,
  ViewWebSearchMessage,
} from "@bb/domain";
import { buildTimelineAssistantStepSummaryLabel } from "./timeline-assistant-step-summary.js";
import { durationToCompactString, durationToString } from "./format-helpers.js";
import { taskStatusGlyph } from "./task-status.js";
import { buildCollapsedGroupedTimelineRows } from "./timeline-grouping.js";
import {
  getCommandExitCodeLine,
  getPermissionGrantDisplayStatus,
  getTimelineDisplayStatus,
  getTimelineDisplayStatusInfo,
  getVisibleCommandOutput,
  type TimelineDisplayStatus,
} from "./timeline-display-status.js";
import {
  buildToolBundleDetailLines,
  buildToolBundleSummaryLabel,
} from "./timeline-tool-bundle-summary.js";
import { buildTurnSummaryParts } from "./timeline-turn-summary.js";
import { formatDelegationSummary } from "./timeline-render-helpers.js";
import { formatToolCallCommand } from "./tool-call-parsing.js";

export type TimelineFormat = "json" | "minimal" | "verbose";

export interface FormatTimelineOptions {
  format: TimelineFormat;
  /** Whether to use ANSI colors. Default: auto-detect from stdout.isTTY. */
  color?: boolean;
}

export interface TimelineTextFormatOptions {
  verbose?: boolean;
  color?: boolean;
}

// Simple ANSI helpers (no external dependency)
function dim(text: string, color: boolean): string {
  return color ? `\x1b[2m${text}\x1b[22m` : text;
}
function cyan(text: string, color: boolean): string {
  return color ? `\x1b[36m${text}\x1b[39m` : text;
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

function separator(label: string, color: boolean): string {
  const pad = Math.max(0, 60 - label.length - 4);
  return dim(`── ${label} ${"─".repeat(pad)}`, color);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function indentBlock(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatLifecycleLabel(
  displayStatus: TimelineDisplayStatus,
  color: boolean,
): string {
  const statusInfo = getTimelineDisplayStatusInfo(displayStatus);

  switch (statusInfo.cliTone) {
    case "success":
      return green(statusInfo.cliLabel, color);
    case "danger":
      return red(statusInfo.cliLabel, color);
    case "warning":
      return yellow(statusInfo.cliLabel, color);
  }
}

function formatSummaryDuration(
  durationMs: number | null | undefined,
): string | undefined {
  if (durationMs === null || durationMs === undefined || durationMs < 1_000) {
    return undefined;
  }
  return durationToCompactString(durationMs);
}

function formatDurationLine(
  durationMs: number | null | undefined,
  color: boolean,
): string | undefined {
  if (durationMs === null || durationMs === undefined) {
    return undefined;
  }
  return dim(`  ${durationToString(durationMs) ?? `${durationMs}ms`}`, color);
}

function formatToolCallOutputLine(
  output: string,
  verbose: boolean,
  color: boolean,
): string | undefined {
  const maxOut = verbose ? output.length : 200;
  const formattedOutput = truncate(output.trim(), maxOut);
  if (formattedOutput.length === 0) {
    return undefined;
  }
  return dim(`  ${formattedOutput.split("\n").join("\n  ")}`, color);
}

function formatCommandExitCodeLine(
  displayStatus: TimelineDisplayStatus,
  exitCode: number | null,
  hasVisibleOutput: boolean,
  color: boolean,
): string | undefined {
  const exitCodeLine = getCommandExitCodeLine({
    displayStatus,
    exitCode,
    hasVisibleOutput,
  });

  if (!exitCodeLine) {
    return undefined;
  }

  if (exitCode !== null && exitCode !== 0) {
    return red(`  ${exitCodeLine}`, color);
  }

  return dim(`  ${exitCodeLine}`, color);
}

function formatPermissionLifecycleLabel(
  msg: ViewPermissionGrantLifecycleMessage,
  color: boolean,
): string {
  return formatLifecycleLabel(
    getPermissionGrantDisplayStatus(msg.status),
    color,
  );
}

function formatOperationLifecycleLabel(
  msg: ViewOperationMessage,
  color: boolean,
): string | undefined {
  if (!msg.status || msg.opType === "warning" || msg.opType === "deprecation") {
    return undefined;
  }

  return formatLifecycleLabel(
    getTimelineDisplayStatus({
      status: msg.status,
    }),
    color,
  );
}

function formatUser(
  msg: ViewUserMessage,
  _verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  lines.push(separator("User", color));
  lines.push(msg.text);
  if (msg.attachments) {
    const parts: string[] = [];
    if (msg.attachments.localImages > 0)
      parts.push(`${msg.attachments.localImages} image(s)`);
    if (msg.attachments.localFiles > 0)
      parts.push(`${msg.attachments.localFiles} file(s)`);
    if (parts.length > 0) lines.push(dim(`  [${parts.join(", ")}]`, color));
  }
  return lines.join("\n");
}

function formatAssistantText(
  msg: ViewAssistantTextMessage,
  _verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  lines.push(separator("Assistant", color));
  lines.push(msg.text);
  return lines.join("\n");
}

interface FormatExecutionCallArgs {
  approvalStatus: ViewCommandMessage["approvalStatus"];
  durationMs: number | null;
  exitCode: number | null;
  label: string;
  output: string;
  status: ViewCommandMessage["status"];
  title: string;
}

function formatExecutionCall(
  args: FormatExecutionCallArgs,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  const displayStatus = getTimelineDisplayStatus({
    approvalStatus: args.approvalStatus,
    status: args.status,
  });
  lines.push(separator(`Tool Call: ${args.label}`, color));
  lines.push(
    `  ${formatLifecycleLabel(displayStatus, color)} ${cyan(args.title || args.label, color)}`,
  );

  const durationLine = formatDurationLine(args.durationMs, color);
  if (durationLine) {
    lines.push(durationLine);
  }

  const output = getVisibleCommandOutput(args.output);
  if (output) {
    const outputLine = formatToolCallOutputLine(output, verbose, color);
    if (outputLine) {
      lines.push(outputLine);
    }
  }

  const exitCodeLine = formatCommandExitCodeLine(
    displayStatus,
    args.exitCode,
    output !== undefined,
    color,
  );
  if (exitCodeLine) {
    lines.push(exitCodeLine);
  }

  return lines.join("\n");
}

function formatToolCall(
  msg: ViewToolCallMessage,
  verbose: boolean,
  color: boolean,
): string {
  return formatExecutionCall(
    {
      approvalStatus: msg.approvalStatus,
      durationMs: msg.durationMs,
      exitCode: null,
      label: msg.toolName,
      output: msg.output,
      status: msg.status,
      title: formatToolCallCommand(msg.toolName, msg.toolArgs),
    },
    verbose,
    color,
  );
}

function formatCommand(
  msg: ViewCommandMessage,
  verbose: boolean,
  color: boolean,
): string {
  return formatExecutionCall(
    {
      approvalStatus: msg.approvalStatus,
      durationMs: msg.durationMs,
      exitCode: msg.exitCode,
      label: "exec_command",
      output: msg.output,
      status: msg.status,
      title: msg.command,
    },
    verbose,
    color,
  );
}

function formatFileEdit(
  msg: ViewFileEditMessage,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  const lifecycleLabel = formatLifecycleLabel(
    getTimelineDisplayStatus({
      approvalStatus: msg.approvalStatus,
      status: msg.status,
    }),
    color,
  );
  lines.push(separator("File Edit", color));
  if (msg.changes.length === 0) {
    lines.push(`  ${lifecycleLabel} ${cyan("file changes", color)}`);
  }
  for (const change of msg.changes) {
    const kindLabel = change.kind ? ` (${change.kind})` : "";
    lines.push(
      `  ${lifecycleLabel} ${cyan(change.path, color)}${dim(kindLabel, color)}`,
    );
    if (verbose && change.diff) {
      const diff = truncate(change.diff.trim(), 2_000);
      lines.push(dim(`  ${diff.split("\n").join("\n  ")}`, color));
    }
  }
  if (msg.stdout && verbose) {
    lines.push(dim(`  ${truncate(msg.stdout.trim(), 500)}`, color));
  }
  return lines.join("\n");
}

function formatWebSearch(
  msg: ViewWebSearchMessage,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  const query = msg.queries[0] ?? "web search";
  const lifecycleLabel = formatLifecycleLabel(
    getTimelineDisplayStatus({
      status: msg.status,
    }),
    color,
  );
  lines.push(separator(`Searched ${query}`, color));
  lines.push(`  ${lifecycleLabel} ${cyan(query, color)}`);
  if (verbose && msg.resultText) {
    lines.push(dim(`  ${truncate(msg.resultText.trim(), 500)}`, color));
  }
  return lines.join("\n");
}

function formatWebFetch(
  msg: ViewWebFetchMessage,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  const lifecycleLabel = formatLifecycleLabel(
    getTimelineDisplayStatus({
      status: msg.status,
    }),
    color,
  );
  lines.push(separator(`Fetched ${msg.url}`, color));
  lines.push(`  ${lifecycleLabel} ${cyan(msg.url, color)}`);
  if (verbose && msg.resultText) {
    lines.push(dim(`  ${truncate(msg.resultText.trim(), 500)}`, color));
  }
  return lines.join("\n");
}

function formatOperation(
  msg: ViewOperationMessage,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  lines.push(separator(`Operation: ${msg.title}`, color));
  const lifecycleLabel = formatOperationLifecycleLabel(msg, color);
  if (lifecycleLabel) {
    lines.push(`  ${lifecycleLabel}`);
  }
  if (msg.detail) lines.push(dim(`  ${msg.detail}`, color));
  return lines.join("\n");
}

function formatPermissionGrantLifecycle(
  msg: ViewPermissionGrantLifecycleMessage,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  lines.push(separator(msg.title, color));
  lines.push(`  ${formatPermissionLifecycleLabel(msg, color)}`);
  if (verbose) {
    lines.push(`  item: ${msg.approvalTarget.itemId}`);
    if (msg.approvalTarget.toolName) {
      lines.push(dim(`  tool: ${msg.approvalTarget.toolName}`, color));
    }
  }
  return lines.join("\n");
}

function formatTasks(
  msg: ViewTasksMessage,
  _verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  lines.push(separator("Updated tasks", color));
  for (const task of msg.tasks) {
    lines.push(`  ${taskStatusGlyph(task.status)} ${task.text}`);
  }
  return lines.join("\n");
}

function formatDelegation(
  msg: ViewDelegationMessage,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  const verb = msg.status === "pending" ? "Running" : "Ran";
  lines.push(
    separator(`${verb} subagent: ${formatDelegationSummary(msg)}`, color),
  );

  const durationLine = formatDurationLine(msg.durationMs, color);
  if (durationLine) {
    lines.push(durationLine);
  }

  if (!verbose) {
    if (msg.output) {
      const output = truncate(msg.output.trim(), 160);
      if (output) {
        lines.push(dim(`  ${output.split("\n").join("\n  ")}`, color));
      }
    }
    return lines.join("\n");
  }

  for (const row of buildCollapsedGroupedTimelineRows(msg.childProjection)) {
    const block = formatTimelineRow(row, true, color);
    if (block) {
      lines.push(indentBlock(block, "  "));
    }
  }

  if (msg.output) {
    const output = msg.output.trim();
    if (output) {
      lines.push(dim(`  ${output.split("\n").join("\n  ")}`, color));
    }
  }

  return lines.join("\n");
}

function formatError(
  msg: ViewErrorMessage,
  _verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  lines.push(separator("Error", color));
  lines.push(red(`  ${msg.message}`, color));
  return lines.join("\n");
}

function formatMessage(
  msg: ViewMessage,
  verbose: boolean,
  color: boolean,
): string {
  switch (msg.kind) {
    case "user":
      return formatUser(msg, verbose, color);
    case "assistant-text":
      return formatAssistantText(msg, verbose, color);
    case "command":
      return formatCommand(msg, verbose, color);
    case "tool-call":
      return formatToolCall(msg, verbose, color);
    case "file-edit":
      return formatFileEdit(msg, verbose, color);
    case "web-search":
      return formatWebSearch(msg, verbose, color);
    case "web-fetch":
      return formatWebFetch(msg, verbose, color);
    case "operation":
      return formatOperation(msg, verbose, color);
    case "permission-grant-lifecycle":
      return formatPermissionGrantLifecycle(msg, verbose, color);
    case "tasks":
      return formatTasks(msg, verbose, color);
    case "delegation":
      return formatDelegation(msg, verbose, color);
    case "error":
      return formatError(msg, verbose, color);
    case "debug/raw-event":
      return "";
    default:
      return "";
  }
}

function formatTurnSummary(entry: TimelineTurnSummaryRow): string {
  const duration = formatSummaryDuration(entry.durationMs);
  const parts = buildTurnSummaryParts({
    duration,
    status: entry.status,
    summaryCount: entry.summaryCount,
  });
  return [parts.prefix, parts.emphasis].join(" ");
}

function formatNestedTimelineRows(
  rows: TimelineRow[],
  verbose: boolean,
  color: boolean,
): string {
  const blocks: string[] = [];
  for (const row of rows) {
    const block = formatTimelineRow(row, verbose, color);
    if (block.length > 0) {
      blocks.push(block);
    }
  }
  return blocks.join("\n\n");
}

function formatAssistantStepSummaryRow(
  row: TimelineAssistantStepSummaryRow,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  lines.push(
    separator(buildTimelineAssistantStepSummaryLabel(row.rows), color),
  );

  if (!verbose) {
    return lines.join("\n");
  }

  const body = formatNestedTimelineRows(row.rows, true, color);
  if (body.length > 0) {
    lines.push(indentBlock(body, "  "));
  }

  return lines.join("\n");
}

function formatToolBundleRow(
  row: TimelineToolBundleRow,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  lines.push(separator(buildToolBundleSummaryLabel(row), color));

  if (!verbose) {
    return lines.join("\n");
  }

  if (row.bundleKind === "exploration") {
    for (const line of buildToolBundleDetailLines(row, {
      readPathStyle: "full",
    })) {
      lines.push(`  ${line}`);
    }
    return lines.join("\n");
  }

  for (const messageRow of row.rows) {
    const block = formatMessage(messageRow.message, true, color);
    if (block.length > 0) {
      lines.push(indentBlock(block, "  "));
    }
  }

  return lines.join("\n");
}

function formatTurnSummaryRow(
  row: TimelineTurnSummaryRow,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  lines.push(separator(formatTurnSummary(row), color));

  if (!verbose || !row.rows) {
    return lines.join("\n");
  }

  const body = formatNestedTimelineRows(row.rows, true, color);
  if (body.length > 0) {
    lines.push(indentBlock(body, "  "));
  }

  return lines.join("\n");
}

function formatTimelineRow(
  row: TimelineRow,
  verbose: boolean,
  color: boolean,
): string {
  switch (row.kind) {
    case "message":
      return formatMessage(row.message, verbose, color);
    case "assistant-step-summary":
      return formatAssistantStepSummaryRow(row, verbose, color);
    case "tool-bundle":
      return formatToolBundleRow(row, verbose, color);
    case "turn-summary":
      return formatTurnSummaryRow(row, verbose, color);
    default:
      return "";
  }
}

/**
 * Format timeline rows as human-readable terminal text.
 *
 * - `minimal`: Compact view — grouped tool work stays collapsed, reasoning hidden
 * - `verbose`: Expanded view — grouped rows are expanded, diffs shown
 */
export function formatTimelineAsText(
  rows: TimelineRow[],
  options?: TimelineTextFormatOptions,
): string {
  const verbose = options?.verbose ?? false;
  const color = options?.color ?? false;

  return formatNestedTimelineRows(rows, verbose, color);
}
