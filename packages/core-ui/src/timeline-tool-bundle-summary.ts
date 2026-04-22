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

function formatWebResearchSummary(
  summary: Extract<TimelineToolBundleSummary, { kind: "web-research" }>,
  status: TimelineGroupedRowStatus,
  capitalize: boolean,
): string {
  const parts: string[] = [];
  const searchVerb = getVerbPair(status, "Ran", "Running");
  const readVerb = getVerbPair(status, "Read", "Reading");

  if (summary.webSearches > 0) {
    parts.push(
      `${capitalize ? searchVerb.uppercase : searchVerb.lowercase} ${pluralize(
        summary.webSearches,
        "web search",
        "web searches",
      )}`,
    );
  }
  if (summary.webPagesRead > 0) {
    parts.push(
      `${parts.length === 0 && capitalize ? readVerb.uppercase : readVerb.lowercase} ${pluralize(
        summary.webPagesRead,
        "web page",
        "web pages",
      )}`,
    );
  }

  return parts.join(", ");
}

export function formatToolBundleSummaryLabel(
  args: FormatToolBundleSummaryLabelArgs,
): string {
  const { capitalize, status, summary } = args;
  switch (summary.kind) {
    case "exploration": {
      const countsLabel = formatExploringCountsLabel({
        filesRead: summary.filesRead,
        searches: summary.searches,
        lists: summary.lists,
      });
      const verb = getVerbPair(status, "Explored", "Exploring");
      const formattedVerb = capitalize ? verb.uppercase : verb.lowercase;
      return countsLabel.length > 0
        ? `${formattedVerb} ${countsLabel}`
        : `${formattedVerb} workspace`;
    }
    case "file-edits": {
      const verb = getVerbPair(status, "Edited", "Editing");
      return `${capitalize ? verb.uppercase : verb.lowercase} ${pluralize(summary.filesEdited, "file", "files")}`;
    }
    case "commands": {
      const verb = getVerbPair(status, "Ran", "Running");
      return `${capitalize ? verb.uppercase : verb.lowercase} ${pluralize(summary.commands, "command", "commands")}`;
    }
    case "web-research":
      return formatWebResearchSummary(summary, status, capitalize);
    default:
      return assertNever(summary);
  }
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
