import type {
  TimelineCommandWorkRow,
  TimelineRow,
  TimelineRowStatus,
} from "@bb/server-contract";
import { assertNever } from "./assert-never.js";
import {
  buildTimelineWorkSummaryLabel,
  buildTimelineViewRows,
} from "./timeline-view.js";
import {
  formatTimelineActivityIntentDetail,
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  timelineRowActivityIntents,
  type TimelineExplorationWorkRow,
} from "./timeline-activity-intents.js";
import {
  buildTimelineRowTitle,
  findActiveLatestBundleId,
  type BuildTimelineRowTitleOptions,
} from "./timeline-row-title.js";
import type {
  ThreadTimelineViewRow,
  TimelineWorkSummaryRow,
  TimelineViewTurnRow,
  TimelineViewWorkRow,
} from "./timeline-view.js";

export type ThreadTimelineTextFormat = "json" | "minimal" | "verbose";

interface ThreadTimelineTextOptions {
  verbose?: boolean;
  color?: boolean;
}

interface TimelineTextFormatContext {
  verbose: boolean;
  color: boolean;
  depth: number;
  activeLatestBundleId: string | null;
}

const BASE_CLI_TITLE_OPTIONS = {
  summaryStyle: "bundle",
  workStyle: "default",
} satisfies BuildTimelineRowTitleOptions;

function cliTitleOptions(
  row: ThreadTimelineViewRow,
  context: TimelineTextFormatContext,
): BuildTimelineRowTitleOptions {
  return {
    ...BASE_CLI_TITLE_OPTIONS,
    isActiveLatestBundle:
      row.kind === "bundle-summary" && row.id === context.activeLatestBundleId,
  };
}

type TimelineConversationViewRow = Extract<
  ThreadTimelineViewRow,
  { kind: "conversation" }
>;

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
  nestedRows: readonly ThreadTimelineViewRow[] | null,
): TimelineTextFormatContext {
  return {
    ...context,
    depth: context.depth + 1,
    activeLatestBundleId: nestedRows
      ? findActiveLatestBundleId(nestedRows)
      : null,
  };
}

function indentBlock(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${prefix}${line}`))
    .join("\n");
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

function formatWorkTitle(
  row: TimelineViewWorkRow,
  context: TimelineTextFormatContext,
): string {
  return buildTimelineRowTitle(row, cliTitleOptions(row, context)).plain;
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
  return dim(`  exit ${row.exitCode}`, color);
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
      if (context.verbose && row.output.trim()) {
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
      return lines;
    case "web-fetch":
      return lines;
    case "image-view":
      return lines;
    case "file-read":
    case "search":
      return lines;
    case "plan-steps":
      if (context.verbose) {
        for (const step of row.steps) {
          const marker =
            step.status === "completed"
              ? "[x]"
              : step.status === "active"
                ? "[>]"
                : step.status === "failed"
                  ? "[!]"
                  : "[ ]";
          lines.push(dim(`  ${marker} ${step.step}`, context.color));
        }
      }
      return lines;
    case "extension":
      if (row.presentation.detail && row.presentation.detail.trim()) {
        lines.push(
          dim(indentBlock(row.presentation.detail, "  "), context.color),
        );
      }
      return lines;
    case "approval":
    case "question":
    case "workflow":
      return lines;
    case "delegation":
      if (row.childRows.length > 0) {
        lines.push(
          indentBlock(
            formatRows(row.childRows, nestedContext(context, row.childRows)),
            "  ",
          ),
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
  const lines = [rowHeader(formatWorkTitle(row, context), context)];
  const bodyLines = formatWorkBody(row, context);
  lines.push(...bodyLines);
  return lines.join("\n");
}

function formatExplorationWorkDetails(
  row: TimelineExplorationWorkRow,
): string[] {
  let lastEmittedKey: string | null = null;
  const details: string[] = [];
  for (const intent of timelineRowActivityIntents(row)) {
    if (intent.type === "unknown") {
      continue;
    }
    const dedupeKey = getTimelineActivityIntentDetailDedupeKey(intent);
    if (dedupeKey !== null && dedupeKey === lastEmittedKey) {
      continue;
    }
    details.push(
      formatTimelineActivityIntentDetail({
        intent,
        pathMode: "full",
        pending: row.status === "pending",
      }),
    );
    lastEmittedKey = dedupeKey;
  }
  return details;
}

function formatWorkSummaryDetails(
  row: TimelineWorkSummaryRow,
  context: TimelineTextFormatContext,
): string[] {
  const lines: string[] = [];
  const childContext = nestedContext(context, null);
  for (const child of row.children) {
    if (
      (child.workKind === "command" ||
        child.workKind === "file-read" ||
        child.workKind === "search") &&
      hasTimelineExplorationIntent(child)
    ) {
      lines.push(
        ...formatExplorationWorkDetails(child).map((detail) =>
          rowHeader(detail, childContext),
        ),
      );
      continue;
    }
    if (
      child.workKind === "web-search" ||
      child.workKind === "web-fetch" ||
      child.workKind === "image-view" ||
      child.workKind === "plan-steps" ||
      child.workKind === "extension"
    ) {
      lines.push(rowHeader(formatWorkTitle(child, childContext), childContext));
      continue;
    }
    lines.push(formatWorkRow(child, childContext));
  }
  return lines;
}

function formatWorkSummary(
  row: TimelineWorkSummaryRow,
  context: TimelineTextFormatContext,
): string {
  const isActive =
    row.kind === "bundle-summary" && row.id === context.activeLatestBundleId;
  const lines = [
    rowHeader(
      buildTimelineWorkSummaryLabel(row, { active: isActive }),
      context,
    ),
  ];
  if (context.verbose || row.kind === "bundle-summary") {
    const details = formatWorkSummaryDetails(row, context);
    if (details.length > 0) {
      lines.push(indentBlock(details.join("\n"), "  "));
    }
  }
  return lines.join("\n");
}

function formatTurnTitle(
  row: TimelineViewTurnRow,
  context: TimelineTextFormatContext,
): string {
  return buildTimelineRowTitle(row, cliTitleOptions(row, context)).plain;
}

function formatConversationRequestLabel(
  row: TimelineConversationViewRow,
): string | null {
  if (row.role !== "user" || row.turnRequest.kind !== "steer") {
    return null;
  }
  if (row.turnRequest.status === "pending") return "steer pending";
  if (row.turnRequest.status === "rejected") return "steer failed";
  return "steer";
}

function formatRow(
  row: ThreadTimelineViewRow,
  context: TimelineTextFormatContext,
): string {
  switch (row.kind) {
    case "conversation":
      return [
        rowHeader(row.role === "user" ? "User" : "Assistant", context),
        row.text,
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
          row.detail ? dim(indentBlock(row.detail, "  "), context.color) : "",
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
    case "bundle-summary":
    case "step-summary":
      return formatWorkSummary(row, context);
    case "turn": {
      const label = formatTurnTitle(row, context);
      if (!row.children || row.children.length === 0) {
        return rowHeader(label, context);
      }
      return [
        rowHeader(label, context),
        indentBlock(
          formatRows(row.children, nestedContext(context, null)),
          "  ",
        ),
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
    activeLatestBundleId: findActiveLatestBundleId(viewRows),
  });
}
