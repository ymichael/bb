import type {
  TimelineRow,
  TimelineToolGroupRow,
  ViewAssistantReasoningMessage,
  ViewAssistantTextMessage,
  ViewPermissionGrantLifecycleMessage,
  ViewDelegationMessage,
  ViewErrorMessage,
  ViewFileEditMessage,
  ViewMessage,
  ViewOperationMessage,
  ViewTasksMessage,
  ViewToolCallMessage,
  ViewToolExploringMessage,
  ViewUserMessage,
  ViewWebSearchMessage,
} from "@bb/domain";
import { durationToCompactString } from "./format-helpers.js";
import { taskStatusGlyph } from "./task-status.js";
import { buildTimelineRows } from "./thread-detail-rows.js";
import {
  getCommandExitCodeLine,
  getPermissionGrantDisplayStatus,
  getTimelineDisplayStatus,
  getTimelineDisplayStatusInfo,
  getVisibleCommandOutput,
  type TimelineDisplayStatus,
} from "./timeline-display-status.js";
import { buildToolGroupSummaryParts } from "./timeline-summary.js";
import {
  buildExploringDetailLines,
  formatDelegationSummary,
  formatExploringCountsLabel,
  summarizeExploringCounts,
} from "./timeline-render-helpers.js";

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
  durationMs: number | undefined,
): string | undefined {
  if (durationMs === undefined || durationMs < 1_000) {
    return undefined;
  }
  return durationToCompactString(durationMs);
}

function formatDurationLine(
  durationMs: number | undefined,
  duration: string | undefined,
  color: boolean,
): string | undefined {
  if (durationMs === undefined) {
    return undefined;
  }
  return dim(`  ${duration ?? `${durationMs}ms`}`, color);
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
  exitCode: number | undefined,
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

  if (exitCode !== undefined && exitCode !== 0) {
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

function formatReasoning(
  msg: ViewAssistantReasoningMessage,
  verbose: boolean,
  color: boolean,
): string {
  if (!verbose) return "";
  const lines: string[] = [];
  lines.push(separator("Reasoning", color));
  lines.push(dim(msg.text, color));
  return lines.join("\n");
}

function formatToolCall(
  msg: ViewToolCallMessage,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  const name = msg.toolName ?? "exec_command";
  const cmd = msg.command ?? "";
  const displayStatus = getTimelineDisplayStatus({
    approvalStatus: msg.approvalStatus,
    status: msg.status,
  });
  lines.push(separator(`Tool Call: ${name}`, color));
  lines.push(
    `  ${formatLifecycleLabel(displayStatus, color)} ${cyan(cmd || name, color)}`,
  );

  const durationLine = formatDurationLine(msg.durationMs, msg.duration, color);
  if (durationLine) {
    lines.push(durationLine);
  }

  const output = getVisibleCommandOutput(msg.output);
  if (output) {
    const outputLine = formatToolCallOutputLine(output, verbose, color);
    if (outputLine) {
      lines.push(outputLine);
    }
  }

  const exitCodeLine = formatCommandExitCodeLine(
    displayStatus,
    msg.exitCode,
    output !== undefined,
    color,
  );
  if (exitCodeLine) {
    lines.push(exitCodeLine);
  }

  return lines.join("\n");
}

function formatExploring(
  msg: ViewToolExploringMessage,
  verbose: boolean,
  color: boolean,
): string {
  const lines: string[] = [];
  const countsLabel =
    formatExploringCountsLabel(summarizeExploringCounts(msg.calls)) ||
    "workspace";
  lines.push(
    separator(
      `${msg.status === "pending" ? "Exploring" : "Explored"} ${countsLabel}`,
      color,
    ),
  );

  if (!verbose) {
    return lines.join("\n");
  }

  for (const line of buildExploringDetailLines(msg.calls, {
    readPathStyle: "full",
  })) {
    lines.push(`  ${line}`);
  }

  return lines.join("\n");
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
  const lifecycleLabel = formatLifecycleLabel(
    getTimelineDisplayStatus({
      status: msg.status,
    }),
    color,
  );
  lines.push(separator("Web Search", color));
  const query = msg.query ?? msg.action ?? "";
  lines.push(`  ${lifecycleLabel} ${cyan(query, color)}`);
  if (verbose && msg.output) {
    lines.push(dim(`  ${truncate(msg.output.trim(), 500)}`, color));
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
  lines.push(separator(`Subagent ${formatDelegationSummary(msg)}`, color));

  const durationLine = formatDurationLine(msg.durationMs, msg.duration, color);
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

  for (const row of buildTimelineRows(msg.childProjection, {
    collapseAll: true,
  })) {
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
    case "assistant-reasoning":
      return formatReasoning(msg, verbose, color);
    case "tool-call":
      return formatToolCall(msg, verbose, color);
    case "tool-exploring":
      return formatExploring(msg, verbose, color);
    case "file-edit":
      return formatFileEdit(msg, verbose, color);
    case "web-search":
      return formatWebSearch(msg, verbose, color);
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

function formatToolGroupSummary(entry: TimelineToolGroupRow): string {
  const duration = formatSummaryDuration(entry.durationMs);
  const parts = buildToolGroupSummaryParts({
    duration,
    status: entry.status,
    summaryCount: entry.summaryCount,
  });
  return [parts.prefix, parts.emphasis, parts.suffix].filter(Boolean).join(" ");
}

function formatTimelineRow(
  row: TimelineRow,
  verbose: boolean,
  color: boolean,
): string {
  if (row.kind === "message") {
    return formatMessage(row.message, verbose, color);
  }

  const lines: string[] = [];
  lines.push(separator(formatToolGroupSummary(row), color));

  if (!verbose) {
    return lines.join("\n");
  }

  for (const message of row.messages) {
    const block = formatMessage(message, true, color);
    if (block.length > 0) {
      lines.push(indentBlock(block, "  "));
    }
  }

  return lines.join("\n");
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

  const blocks: string[] = [];
  for (const row of rows) {
    const formatted = formatTimelineRow(row, verbose, color);
    if (formatted) {
      blocks.push(formatted);
    }
  }
  return blocks.join("\n\n");
}
