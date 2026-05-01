import type {
  TimelineAssistantStepSummaryRow,
  TimelineGroupedRowStatus,
  TimelineRow,
  TimelineToolBundleRow,
  TimelineTurnSummaryRow,
  ViewMessage,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { durationToCompactString } from "./format-helpers.js";
import {
  getTimelineDisplayStatus,
  getTimelineDisplayStatusInfo,
} from "./timeline-display-status.js";
import { buildTimelineAssistantStepSummaryLabel } from "./timeline-assistant-step-summary.js";
import { buildToolBundleSummaryParts } from "./timeline-tool-bundle-summary.js";
import { buildTurnSummaryParts } from "./timeline-turn-summary.js";
import { getDelegationSummaryParts } from "./timeline-render-helpers.js";
import { formatToolCallCommand } from "./tool-call-parsing.js";

type ViewWebSearchStatus = Extract<
  ViewMessage,
  { kind: "web-search" }
>["status"];
type ViewWebFetchStatus = Extract<
  ViewMessage,
  { kind: "web-fetch" }
>["status"];
type ViewExecutionMessage = Extract<
  ViewMessage,
  { kind: "command" | "tool-call" }
>;

export type ThreadTimelineRichTitle =
  | {
      kind: "plain";
      text: string;
    }
  | {
      kind: "prefixed";
      prefix: string;
      content: string;
      metadata: string | null;
    };

type ThreadTimelinePrefixedRichTitle = Extract<
  ThreadTimelineRichTitle,
  { kind: "prefixed" }
>;

export interface ThreadTimelineRowTitle {
  plain: string;
  rich: ThreadTimelineRichTitle;
}

export interface ThreadTimelineTitleContext {
  preferOngoingLabels: boolean;
}

function formatSummaryDuration(
  durationMs: number | null | undefined,
): string | undefined {
  if (durationMs === null || durationMs === undefined || durationMs < 1_000) {
    return undefined;
  }
  return durationToCompactString(durationMs);
}

function applyOngoingLabelPreference(
  status: TimelineGroupedRowStatus,
  context: ThreadTimelineTitleContext,
): TimelineGroupedRowStatus {
  if (context.preferOngoingLabels && status === "completed") {
    return "pending";
  }
  return status;
}

function titleFromRich(rich: ThreadTimelineRichTitle): ThreadTimelineRowTitle {
  if (rich.kind === "plain") {
    return {
      plain: rich.text,
      rich,
    };
  }

  const text = `${rich.prefix} ${rich.content}`;
  return {
    plain: rich.metadata ? `${text} (${rich.metadata})` : text,
    rich,
  };
}

function titleFromPlain(plain: string): ThreadTimelineRowTitle {
  return titleFromRich({
    kind: "plain",
    text: plain,
  });
}

function titleWithPlain(
  plain: string,
  rich: ThreadTimelinePrefixedRichTitle,
): ThreadTimelineRowTitle {
  return {
    plain,
    rich,
  };
}

function webSearchPrefix(status: ViewWebSearchStatus): string {
  switch (status) {
    case "pending":
      return "Searching";
    case "interrupted":
      return "Search interrupted";
    case "completed":
      return "Searched";
    default:
      return assertNever(status);
  }
}

function webFetchPrefix(status: ViewWebFetchStatus): string {
  switch (status) {
    case "pending":
      return "Fetching";
    case "interrupted":
      return "Fetch interrupted";
    case "completed":
      return "Fetched";
    default:
      return assertNever(status);
  }
}

function getExecutionContent(message: ViewExecutionMessage): string {
  switch (message.kind) {
    case "command":
      return message.command;
    case "tool-call":
      return formatToolCallCommand(message.toolName, message.toolArgs);
    default:
      return assertNever(message);
  }
}

function getExecutionPrefix(message: ViewExecutionMessage): string {
  return getTimelineDisplayStatusInfo(
    getTimelineDisplayStatus({
      approvalStatus: message.approvalStatus,
      status: message.status,
    }),
  ).reactLabel;
}

function getTimelineMessageRowTitle(
  message: ViewMessage,
): ThreadTimelineRowTitle {
  switch (message.kind) {
    case "user":
      return titleFromPlain("User");
    case "assistant-text":
      return titleFromPlain("Assistant");
    case "command":
      return titleWithPlain("Tool Call: exec_command", {
        kind: "prefixed",
        prefix: getExecutionPrefix(message),
        content: getExecutionContent(message),
        metadata: null,
      });
    case "tool-call":
      return titleWithPlain(`Tool Call: ${message.toolName}`, {
        kind: "prefixed",
        prefix: getExecutionPrefix(message),
        content: getExecutionContent(message),
        metadata: null,
      });
    case "file-edit":
      return titleFromPlain("File Edit");
    case "web-search": {
      const query = message.queries[0] ?? "web search";
      return titleWithPlain(`Searched ${query}`, {
        kind: "prefixed",
        prefix: webSearchPrefix(message.status),
        content: query,
        metadata: null,
      });
    }
    case "web-fetch":
      return titleWithPlain(`Fetched ${message.url}`, {
        kind: "prefixed",
        prefix: webFetchPrefix(message.status),
        content: message.url,
        metadata: null,
      });
    case "operation":
      return titleFromPlain(`Operation: ${message.title}`);
    case "permission-grant-lifecycle":
      return titleFromPlain(message.title);
    case "tasks":
      return titleFromPlain("Updated tasks");
    case "delegation": {
      const verb = message.status === "pending" ? "Running" : "Ran";
      const parts = getDelegationSummaryParts(message);
      return titleFromRich({
        kind: "prefixed",
        prefix: `${verb} subagent:`,
        content: parts.label,
        metadata: parts.metadata ?? null,
      });
    }
    case "error":
      return titleFromPlain("Error");
    case "debug/raw-event":
      return titleFromPlain("");
    default:
      return assertNever(message);
  }
}

function getToolBundleRowTitle(
  row: TimelineToolBundleRow,
  context: ThreadTimelineTitleContext,
): ThreadTimelineRowTitle {
  const titleRow = {
    ...row,
    status: applyOngoingLabelPreference(row.status, context),
  };
  const parts = buildToolBundleSummaryParts(titleRow);
  return titleFromRich({
    kind: "prefixed",
    prefix: parts.prefix,
    content: parts.emphasis,
    metadata: null,
  });
}

function getAssistantStepSummaryRowTitle(
  row: TimelineAssistantStepSummaryRow,
): ThreadTimelineRowTitle {
  return titleFromPlain(buildTimelineAssistantStepSummaryLabel(row.rows));
}

function getTurnSummaryRowTitle(
  row: TimelineTurnSummaryRow,
  context: ThreadTimelineTitleContext,
): ThreadTimelineRowTitle {
  const duration = formatSummaryDuration(row.durationMs);
  const parts = buildTurnSummaryParts({
    duration,
    status: applyOngoingLabelPreference(row.status, context),
    summaryCount: row.summaryCount,
  });
  return titleFromRich({
    kind: "prefixed",
    prefix: parts.prefix,
    content: parts.emphasis,
    metadata: null,
  });
}

export function getThreadTimelineRowTitle(
  row: TimelineRow,
  context: ThreadTimelineTitleContext,
): ThreadTimelineRowTitle {
  switch (row.kind) {
    case "message":
      return getTimelineMessageRowTitle(row.message);
    case "assistant-step-summary":
      return getAssistantStepSummaryRowTitle(row);
    case "tool-bundle":
      return getToolBundleRowTitle(row, context);
    case "turn-summary":
      return getTurnSummaryRowTitle(row, context);
    default:
      return assertNever(row);
  }
}
