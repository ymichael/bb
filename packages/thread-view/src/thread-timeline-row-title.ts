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
import { buildTimelineAssistantStepSummaryLabel } from "./timeline-assistant-step-summary.js";
import { buildToolBundleSummaryParts } from "./timeline-tool-bundle-summary.js";
import { buildTurnSummaryParts } from "./timeline-turn-summary.js";
import { getDelegationSummaryParts } from "./timeline-render-helpers.js";

export interface ThreadTimelineRichTitle {
  prefix: string | null;
  content: string;
  metadata: string | null;
}

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
  const text = rich.prefix ? `${rich.prefix} ${rich.content}` : rich.content;
  return {
    plain: rich.metadata ? `${text} (${rich.metadata})` : text,
    rich,
  };
}

function titleFromPlain(plain: string): ThreadTimelineRowTitle {
  return titleFromRich({
    prefix: null,
    content: plain,
    metadata: null,
  });
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
      return titleFromPlain("Tool Call: exec_command");
    case "tool-call":
      return titleFromPlain(`Tool Call: ${message.toolName}`);
    case "file-edit":
      return titleFromPlain("File Edit");
    case "web-search":
      return titleFromPlain(`Searched ${message.queries[0] ?? "web search"}`);
    case "web-fetch":
      return titleFromPlain(`Fetched ${message.url}`);
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
