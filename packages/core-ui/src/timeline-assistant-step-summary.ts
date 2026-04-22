import type {
  TimelineAssistantStepSummaryChildRow,
  TimelineGroupedRowStatus,
  TimelineToolBundleKind,
  TimelineToolBundleRow,
  ViewMessage,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { fileChangeIdentity } from "./file-change-summary.js";
import { isDelegationToolName, isShellToolName } from "./tool-call-parsing.js";
import { mergeGroupedRowStatus } from "./timeline-grouped-row-status.js";
import { formatToolBundleSummaryLabel } from "./timeline-tool-bundle-summary.js";

const SUMMARY_PART_LIMIT = 3;

const timelineAssistantStepSummaryPartKinds = [
  "exploration",
  "file-edits",
  "commands",
  "web-research",
  "delegations",
  "tools",
] as const;

type TimelineAssistantStepSummaryPartKind =
  (typeof timelineAssistantStepSummaryPartKinds)[number];

interface TimelineExplorationSummaryPart {
  kind: "exploration";
  row: TimelineToolBundleRow;
}

interface TimelineFileEditsSummaryPart {
  kind: "file-edits";
  row: TimelineToolBundleRow;
}

interface TimelineCommandsSummaryPart {
  kind: "commands";
  row: TimelineToolBundleRow;
}

interface TimelineWebResearchSummaryPart {
  kind: "web-research";
  row: TimelineToolBundleRow;
}

interface TimelineDelegationsSummaryPart {
  count: number;
  kind: "delegations";
}

interface TimelineToolsSummaryPart {
  count: number;
  kind: "tools";
}

type TimelineAssistantStepSummaryPart =
  | TimelineExplorationSummaryPart
  | TimelineFileEditsSummaryPart
  | TimelineCommandsSummaryPart
  | TimelineWebResearchSummaryPart
  | TimelineDelegationsSummaryPart
  | TimelineToolsSummaryPart;

interface TimelineAssistantStepSummaryAccumulator {
  delegationCount: number;
  fallbackItemCount: number;
  hasMeaningfulWork: boolean;
  partOrder: TimelineAssistantStepSummaryPartKind[];
  toolBundleRowsByKind: ToolBundleRowsByKind;
  toolsCount: number;
}

interface ToolBundleRowsByKind {
  commands: TimelineToolBundleRow[];
  exploration: TimelineToolBundleRow[];
  "file-edits": TimelineToolBundleRow[];
  "web-research": TimelineToolBundleRow[];
}

type MergedToolBundleRowBase = Omit<TimelineToolBundleRow, "summary">;

function getAssistantStepSummaryLabelStatus(
  status: TimelineGroupedRowStatus,
): TimelineGroupedRowStatus {
  return status === "pending" ? "completed" : status;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function createAccumulator(): TimelineAssistantStepSummaryAccumulator {
  return {
    delegationCount: 0,
    fallbackItemCount: 0,
    hasMeaningfulWork: false,
    partOrder: [],
    toolBundleRowsByKind: {
      commands: [],
      exploration: [],
      "file-edits": [],
      "web-research": [],
    },
    toolsCount: 0,
  };
}

function addPartOrder(
  accumulator: TimelineAssistantStepSummaryAccumulator,
  kind: TimelineAssistantStepSummaryPartKind,
): void {
  if (!accumulator.partOrder.includes(kind)) {
    accumulator.partOrder.push(kind);
  }
}

function countFallbackMessage(message: ViewMessage): boolean {
  switch (message.kind) {
    case "assistant-reasoning":
    case "assistant-text":
    case "debug/raw-event":
    case "user":
      return false;
    case "delegation":
    case "error":
    case "file-edit":
    case "operation":
    case "permission-grant-lifecycle":
    case "tasks":
    case "tool-call":
    case "tool-exploring":
    case "web-fetch":
    case "web-search":
      return true;
    default:
      return assertNever(message);
  }
}

function addMessageRow(
  accumulator: TimelineAssistantStepSummaryAccumulator,
  message: ViewMessage,
): void {
  if (countFallbackMessage(message)) {
    accumulator.fallbackItemCount += 1;
  }

  switch (message.kind) {
    case "delegation":
      accumulator.delegationCount += 1;
      accumulator.hasMeaningfulWork = true;
      addPartOrder(accumulator, "delegations");
      return;
    case "tool-call":
      if (isDelegationToolName(message.toolName)) {
        accumulator.delegationCount += 1;
        accumulator.hasMeaningfulWork = true;
        addPartOrder(accumulator, "delegations");
        return;
      }
      if (isShellToolName(message.toolName)) {
        return;
      }
      accumulator.toolsCount += 1;
      addPartOrder(accumulator, "tools");
      return;
    case "tasks":
    case "permission-grant-lifecycle":
      return;
    case "operation":
      return;
    case "error":
    case "assistant-reasoning":
    case "assistant-text":
    case "debug/raw-event":
    case "file-edit":
    case "tool-exploring":
    case "user":
    case "web-fetch":
    case "web-search":
      return;
    default:
      return assertNever(message);
  }
}

function addToolBundleRow(
  accumulator: TimelineAssistantStepSummaryAccumulator,
  row: TimelineToolBundleRow,
): void {
  accumulator.fallbackItemCount += row.rows.length;
  accumulator.hasMeaningfulWork = true;
  accumulator.toolBundleRowsByKind[row.bundleKind].push(row);
  addPartOrder(accumulator, row.bundleKind);
}

function buildSummaryPart(
  accumulator: TimelineAssistantStepSummaryAccumulator,
  kind: "delegations" | "tools",
): TimelineDelegationsSummaryPart | TimelineToolsSummaryPart | null {
  switch (kind) {
    case "delegations":
      return accumulator.delegationCount > 0
        ? {
            kind: "delegations",
            count: accumulator.delegationCount,
          }
        : null;
    case "tools":
      return accumulator.toolsCount > 0
        ? {
            kind: "tools",
            count: accumulator.toolsCount,
          }
        : null;
    default:
      return assertNever(kind);
  }
}

function countMergedFileEditBundleFiles(
  bundleRows: readonly TimelineToolBundleRow[],
): number {
  const filesChanged = new Set<string>();

  for (const row of bundleRows) {
    for (const entry of row.rows) {
      if (entry.message.kind !== "file-edit") {
        throw new Error("File edit bundle rows require file-edit messages");
      }

      for (const change of entry.message.changes) {
        filesChanged.add(fileChangeIdentity(change));
      }
    }
  }

  return filesChanged.size;
}

function buildMergedToolBundleRowBase(
  bundleRows: readonly TimelineToolBundleRow[],
): MergedToolBundleRowBase | null {
  if (bundleRows.length === 0) {
    return null;
  }
  const [firstRow] = bundleRows;
  if (!firstRow) {
    return null;
  }

  return {
    ...firstRow,
    createdAt: Math.max(...bundleRows.map((row) => row.createdAt)),
    durationMs: undefined,
    rows: bundleRows.flatMap((row) => row.rows),
    sourceSeqEnd: Math.max(...bundleRows.map((row) => row.sourceSeqEnd)),
    sourceSeqStart: Math.min(...bundleRows.map((row) => row.sourceSeqStart)),
    startedAt: Math.min(...bundleRows.map((row) => row.startedAt)),
    status: bundleRows.reduce(
      (current, row) => mergeGroupedRowStatus(current, row.status),
      firstRow.status,
    ),
  };
}

function mergeToolBundleSummary(
  bundleRows: readonly TimelineToolBundleRow[],
): TimelineToolBundleRow["summary"] | null {
  const firstRow = bundleRows[0];
  if (!firstRow) {
    return null;
  }

  switch (firstRow.bundleKind) {
    case "exploration":
      return {
        kind: "exploration",
        filesRead: bundleRows.reduce(
          (total, row) =>
            total +
            (row.summary.kind === "exploration" ? row.summary.filesRead : 0),
          0,
        ),
        searches: bundleRows.reduce(
          (total, row) =>
            total +
            (row.summary.kind === "exploration" ? row.summary.searches : 0),
          0,
        ),
        lists: bundleRows.reduce(
          (total, row) =>
            total + (row.summary.kind === "exploration" ? row.summary.lists : 0),
          0,
        ),
      };
    case "file-edits":
      return {
        kind: "file-edits",
        filesEdited: countMergedFileEditBundleFiles(bundleRows),
      };
    case "commands":
      return {
        kind: "commands",
        commands: bundleRows.reduce(
          (total, row) =>
            total + (row.summary.kind === "commands" ? row.summary.commands : 0),
          0,
        ),
      };
    case "web-research":
      return {
        kind: "web-research",
        webPagesRead: bundleRows.reduce(
          (total, row) =>
            total +
            (row.summary.kind === "web-research"
              ? row.summary.webPagesRead
              : 0),
          0,
        ),
        webSearches: bundleRows.reduce(
          (total, row) =>
            total +
            (row.summary.kind === "web-research"
              ? row.summary.webSearches
              : 0),
          0,
        ),
      };
    default:
      return assertNever(firstRow.bundleKind);
  }
}

function mergeToolBundleRows(
  bundleRows: readonly TimelineToolBundleRow[],
): TimelineToolBundleRow | null {
  const [firstRow] = bundleRows;
  if (!firstRow) {
    return null;
  }

  if (bundleRows.length === 1) {
    return firstRow;
  }

  const mergedBase = buildMergedToolBundleRowBase(bundleRows);
  if (!mergedBase) {
    return null;
  }

  const summary = mergeToolBundleSummary(bundleRows);
  if (!summary) {
    return null;
  }

  return {
    ...mergedBase,
    summary,
  };
}

function getToolBundleRowsByKind(
  toolBundleRowsByKind: ToolBundleRowsByKind,
  bundleKind: TimelineToolBundleKind,
): readonly TimelineToolBundleRow[] {
  return toolBundleRowsByKind[bundleKind];
}

export interface TimelineAssistantStepSummary {
  fallbackItemCount: number;
  hasMeaningfulWork: boolean;
  parts: TimelineAssistantStepSummaryPart[];
}

export function buildTimelineAssistantStepSummary(
  rows: readonly TimelineAssistantStepSummaryChildRow[],
): TimelineAssistantStepSummary {
  const accumulator = createAccumulator();
  for (const row of rows) {
    if (row.kind === "tool-bundle") {
      addToolBundleRow(accumulator, row);
      continue;
    }
    addMessageRow(accumulator, row.message);
  }

  return {
    fallbackItemCount: accumulator.fallbackItemCount,
    hasMeaningfulWork: accumulator.hasMeaningfulWork,
    parts: accumulator.partOrder
      .map((kind) => {
        switch (kind) {
          case "exploration":
            return mergeToolBundleRows(
              getToolBundleRowsByKind(
                accumulator.toolBundleRowsByKind,
                "exploration",
              ),
            );
          case "file-edits":
            return mergeToolBundleRows(
              getToolBundleRowsByKind(
                accumulator.toolBundleRowsByKind,
                "file-edits",
              ),
            );
          case "commands":
            return mergeToolBundleRows(
              getToolBundleRowsByKind(
                accumulator.toolBundleRowsByKind,
                "commands",
              ),
            );
          case "web-research":
            return mergeToolBundleRows(
              getToolBundleRowsByKind(
                accumulator.toolBundleRowsByKind,
                "web-research",
              ),
            );
          case "delegations":
          case "tools":
            return buildSummaryPart(accumulator, kind);
          default:
            return assertNever(kind);
        }
      })
      .map((value) => {
        if (!value) {
          return null;
        }
        if ("kind" in value && value.kind === "delegations") {
          return value;
        }
        if ("kind" in value && value.kind === "tools") {
          return value;
        }
        return {
          kind: value.bundleKind,
          row: value,
        } satisfies TimelineAssistantStepSummaryPart;
      })
      .filter((part): part is TimelineAssistantStepSummaryPart => part !== null),
  };
}

function formatSummaryPart(
  part: TimelineAssistantStepSummaryPart,
  capitalize: boolean,
): string {
  switch (part.kind) {
    case "exploration":
    case "file-edits":
    case "commands":
    case "web-research":
      return formatToolBundleSummaryLabel({
        capitalize,
        status: getAssistantStepSummaryLabelStatus(part.row.status),
        summary: part.row.summary,
      });
    case "delegations":
      return `${capitalize ? "Delegated to" : "delegated to"} ${pluralize(
        part.count,
        "subagent",
        "subagents",
      )}`;
    case "tools":
      return `${capitalize ? "Used" : "used"} ${pluralize(
        part.count,
        "tool",
        "tools",
      )}`;
    default:
      return assertNever(part);
  }
}

export function formatTimelineAssistantStepSummary(
  summary: TimelineAssistantStepSummary,
): string {
  const visibleParts = summary.hasMeaningfulWork
    ? summary.parts.filter((part) => part.kind !== "tools")
    : summary.parts;

  if (visibleParts.length === 0) {
    return `Worked on ${pluralize(
      summary.fallbackItemCount,
      "item",
      "items",
    )}`;
  }

  const visiblePartLabels = visibleParts
    .slice(0, SUMMARY_PART_LIMIT)
    .map((part, index) => formatSummaryPart(part, index === 0));
  const overflowCount = visibleParts.length - visiblePartLabels.length;

  if (overflowCount > 0) {
    return `${visiblePartLabels.join(", ")}, and ${overflowCount} more items`;
  }

  return visiblePartLabels.join(", ");
}

export function buildTimelineAssistantStepSummaryLabel(
  rows: readonly TimelineAssistantStepSummaryChildRow[],
): string {
  return formatTimelineAssistantStepSummary(
    buildTimelineAssistantStepSummary(rows),
  );
}
