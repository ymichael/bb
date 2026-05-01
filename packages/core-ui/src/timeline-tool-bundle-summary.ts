import type {
  TimelineMessageRow,
  TimelineGroupedRowStatus,
  TimelineToolBundleRow,
  TimelineToolBundleSummary,
  ViewCommandMessage,
  ViewToolCallMessage,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import {
  buildExploringDetailLines,
  formatExploringCountsLabel,
  type ToolIntentSummary,
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
    case "commands": {
      const verb = getVerbPair(status, "Ran", "Running");
      return {
        prefix: verb.uppercase,
        emphasis: pluralize(summary.commands, "command", "commands"),
      };
    }
    case "web-research":
      return formatWebResearchSummaryParts(summary, status);
    case "delegations": {
      const verb = getVerbPair(status, "Ran", "Running");
      return {
        prefix: verb.uppercase,
        emphasis: pluralize(summary.delegations, "subagent", "subagents"),
      };
    }
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

type ExplorationBundleMessage = ViewCommandMessage | ViewToolCallMessage;

function toToolCallSummary(
  message: ExplorationBundleMessage,
): ToolIntentSummary {
  if (message.kind === "command") {
    return {
      kind: "command",
      command: message.command,
      parsedIntents: message.parsedIntents,
    };
  }
  return {
    kind: "tool-call",
    toolName: message.toolName,
    toolArgs: message.toolArgs,
    parsedIntents: message.parsedIntents,
  };
}

function getExplorationBundleCalls(
  rows: readonly TimelineMessageRow[],
): ToolIntentSummary[] {
  return rows.map((row) => {
    if (row.message.kind !== "command" && row.message.kind !== "tool-call") {
      throw new Error(
        `Exploration tool bundles must only contain command or tool-call rows, got ${row.message.kind}`,
      );
    }
    return toToolCallSummary(row.message);
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
    case "web-research":
    case "delegations":
      return [];
    default:
      return assertNever(row.bundleKind);
  }
}
