import type { ViewToolCallSummary, ViewToolParsedIntent } from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { fileNameFromPath } from "./file-change-summary.js";

interface DelegationSummaryInput {
  subagentType?: string;
  description?: string;
  command?: string;
  toolName: string;
}

export interface DelegationSummaryParts {
  label: string;
  metadata?: string;
}

export interface ExploringCounts {
  filesRead: number;
  searches: number;
  lists: number;
}

export interface ExploringRenderOptions {
  readPathStyle?: "basename" | "full";
}

const DEFAULT_EXPLORING_RENDER_OPTIONS: ExploringRenderOptions = {
  readPathStyle: "full",
};

function formatSearchDetail(
  intent: Extract<ViewToolParsedIntent, { type: "search" }>,
): string {
  const query = intent.query;
  if (query && intent.path) return `${query} in ${intent.path}`;
  if (query) return query;
  return intent.cmd;
}

function getReadDisplayName(
  intent: Extract<ViewToolParsedIntent, { type: "read" }>,
  options: ExploringRenderOptions,
): string {
  if (intent.path) {
    return options.readPathStyle === "basename"
      ? fileNameFromPath(intent.path)
      : intent.path;
  }
  return intent.name ?? intent.cmd;
}

export function getDelegationSummaryParts(
  message: DelegationSummaryInput,
): DelegationSummaryParts {
  if (message.description) {
    return {
      label: message.description,
      ...(message.subagentType ? { metadata: message.subagentType } : {}),
    };
  }
  if (message.command) {
    return {
      label: message.command,
      ...(message.subagentType ? { metadata: message.subagentType } : {}),
    };
  }
  if (message.subagentType) {
    return { label: message.subagentType };
  }
  return { label: message.toolName };
}

export function formatDelegationSummary(
  message: DelegationSummaryInput,
): string {
  const parts = getDelegationSummaryParts(message);
  return parts.metadata ? `${parts.label} (${parts.metadata})` : parts.label;
}

export function formatExploringIntentLine(
  intent: ViewToolParsedIntent,
  options: ExploringRenderOptions = DEFAULT_EXPLORING_RENDER_OPTIONS,
): string {
  switch (intent.type) {
    case "read":
      return `Read ${getReadDisplayName(intent, options)}`;
    case "list_files":
      return `List ${intent.path ?? intent.cmd}`;
    case "search":
      return `Search ${formatSearchDetail(intent)}`;
    case "unknown":
      return `Run ${intent.cmd}`;
    default:
      return assertNever(intent);
  }
}

function isReadIntent(
  intent: ViewToolParsedIntent,
): intent is Extract<ViewToolParsedIntent, { type: "read" }> {
  return intent.type === "read";
}

function isReadOnlyCall(call: ViewToolCallSummary): boolean {
  return call.parsedCmd.length > 0 && call.parsedCmd.every(isReadIntent);
}

export function buildExploringDetailLines(
  calls: ViewToolCallSummary[],
  options: ExploringRenderOptions = DEFAULT_EXPLORING_RENDER_OPTIONS,
): string[] {
  const detailLines: string[] = [];
  let index = 0;

  while (index < calls.length) {
    const call = calls[index];
    if (!call) break;

    if (isReadOnlyCall(call)) {
      const seen = new Set<string>();
      while (
        index < calls.length &&
        calls[index] &&
        isReadOnlyCall(calls[index])
      ) {
        const current = calls[index];
        if (!current) break;
        for (const intent of current.parsedCmd) {
          if (intent.type !== "read") continue;
          const label = getReadDisplayName(intent, options);
          if (seen.has(label)) continue;
          seen.add(label);
          detailLines.push(`Read ${label}`);
        }
        index += 1;
      }
      continue;
    }

    if (call.parsedCmd.length === 0) {
      if (call.command) detailLines.push(call.command);
      index += 1;
      continue;
    }

    for (const intent of call.parsedCmd) {
      detailLines.push(formatExploringIntentLine(intent, options));
    }
    index += 1;
  }

  return detailLines;
}

export function summarizeExploringCounts(
  calls: ViewToolCallSummary[],
): ExploringCounts {
  const readNames = new Set<string>();
  let searches = 0;
  let lists = 0;

  for (const call of calls) {
    for (const intent of call.parsedCmd) {
      switch (intent.type) {
        case "read":
          readNames.add(
            getReadDisplayName(intent, DEFAULT_EXPLORING_RENDER_OPTIONS),
          );
          break;
        case "search":
          searches += 1;
          break;
        case "list_files":
          lists += 1;
          break;
        case "unknown":
          break;
        default:
          assertNever(intent);
      }
    }
  }

  return {
    filesRead: readNames.size,
    searches,
    lists,
  };
}

export function formatExploringCountsLabel(counts: ExploringCounts): string {
  const parts: string[] = [];
  if (counts.filesRead > 0) {
    parts.push(`${counts.filesRead} file${counts.filesRead === 1 ? "" : "s"}`);
  }
  if (counts.searches > 0) {
    parts.push(`${counts.searches} search${counts.searches === 1 ? "" : "es"}`);
  }
  if (counts.lists > 0) {
    parts.push(`${counts.lists} list${counts.lists === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}
