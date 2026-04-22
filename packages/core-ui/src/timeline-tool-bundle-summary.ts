import type {
  TimelineMessageRow,
  TimelineGroupedRowStatus,
  TimelineToolBundleRow,
  TimelineToolBundleSummary,
  ViewToolExploringMessage,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import {
  buildExploringDetailLines,
  formatExploringCountsLabel,
} from "./timeline-render-helpers.js";

interface FormatToolBundleSummaryLabelArgs {
  capitalize: boolean;
  status: TimelineGroupedRowStatus;
  summary: TimelineToolBundleSummary;
}

export interface ToolBundleSummaryParts {
  prefix: string;
  emphasis: string;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getVerbPair(
  status: TimelineGroupedRowStatus,
  completed: string,
  pending: string,
): { lowercase: string; uppercase: string } {
  if (status === "pending") {
    return {
      lowercase: pending.toLowerCase(),
      uppercase: pending,
    };
  }

  return {
    lowercase: completed.toLowerCase(),
    uppercase: completed,
  };
}

function formatWebResearchSummaryParts(
  summary: Extract<TimelineToolBundleSummary, { kind: "web-research" }>,
  status: TimelineGroupedRowStatus,
): ToolBundleSummaryParts {
  const searchVerb = getVerbPair(status, "Ran", "Running");
  const readVerb = getVerbPair(status, "Read", "Reading");

  if (summary.webSearches > 0 && summary.webPagesRead > 0) {
    return {
      prefix: searchVerb.uppercase,
      emphasis: `${pluralize(
        summary.webSearches,
        "web search",
        "web searches",
      )}, ${readVerb.lowercase} ${pluralize(
        summary.webPagesRead,
        "web page",
        "web pages",
      )}`,
    };
  }
  if (summary.webSearches > 0) {
    return {
      prefix: searchVerb.uppercase,
      emphasis: pluralize(summary.webSearches, "web search", "web searches"),
    };
  }
  return {
    prefix: readVerb.uppercase,
    emphasis: pluralize(summary.webPagesRead, "web page", "web pages"),
  };
}

function formatToolBundleSummaryParts({
  status,
  summary,
}: {
  status: TimelineGroupedRowStatus;
  summary: TimelineToolBundleSummary;
}): ToolBundleSummaryParts {
  switch (summary.kind) {
    case "exploration": {
      const countsLabel = formatExploringCountsLabel({
        filesRead: summary.filesRead,
        searches: summary.searches,
        lists: summary.lists,
      });
      const verb = getVerbPair(status, "Explored", "Exploring");
      return {
        prefix: verb.uppercase,
        emphasis: countsLabel.length > 0 ? countsLabel : "workspace",
      };
    }
    case "file-edits": {
      const verb = getVerbPair(status, "Edited", "Editing");
      return {
        prefix: verb.uppercase,
        emphasis: pluralize(summary.filesEdited, "file", "files"),
      };
    }
    case "commands": {
      const verb = getVerbPair(status, "Ran", "Running");
      return {
        prefix: verb.uppercase,
        emphasis: pluralize(summary.commands, "command", "commands"),
      };
    }
    case "web-research":
      return formatWebResearchSummaryParts(summary, status);
    default:
      return assertNever(summary);
  }
}

export function formatToolBundleSummaryLabel(
  args: FormatToolBundleSummaryLabelArgs,
): string {
  const parts = formatToolBundleSummaryParts({
    status: args.status,
    summary: args.summary,
  });
  const prefix = args.capitalize ? parts.prefix : parts.prefix.toLowerCase();
  return `${prefix} ${parts.emphasis}`;
}

export function buildToolBundleSummaryLabel(
  row: Pick<TimelineToolBundleRow, "status" | "summary">,
): string {
  return formatToolBundleSummaryLabel({
    capitalize: true,
    status: row.status,
    summary: row.summary,
  });
}

export function buildToolBundleSummaryParts(
  row: Pick<TimelineToolBundleRow, "status" | "summary">,
): ToolBundleSummaryParts {
  return formatToolBundleSummaryParts({
    status: row.status,
    summary: row.summary,
  });
}

function getExplorationBundleCalls(
  rows: readonly TimelineMessageRow[],
): ViewToolExploringMessage["calls"] {
  return rows.flatMap((row) => {
    if (row.message.kind !== "tool-exploring") {
      throw new Error(
        `Exploration tool bundles must only contain tool-exploring rows, got ${row.message.kind}`,
      );
    }
    return row.message.calls;
  });
}

export function buildToolBundleDetailLines(
  row: Pick<TimelineToolBundleRow, "bundleKind" | "rows">,
  options?: { readPathStyle?: "basename" | "full" },
): string[] {
  switch (row.bundleKind) {
    case "exploration":
      return buildExploringDetailLines(
        getExplorationBundleCalls(row.rows),
        options,
      );
    case "commands":
    case "file-edits":
    case "web-research":
      return [];
    default:
      return assertNever(row.bundleKind);
  }
}
