import type {
  TimelineCommandWorkRow,
  TimelineConversationRow,
  TimelineDelegationWorkRow,
  TimelineFileChangeWorkRow,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSystemRow,
  TimelineToolWorkRow,
  TimelineTurnRow,
  TimelineWorkRow,
} from "@bb/server-contract";
import { assertNever } from "./assert-never.js";
import { getFileChangeAction } from "./file-change-summary.js";
import { hasTimelineExplorationIntent } from "./timeline-activity-intents.js";

export interface TimelineViewDelegationWorkRow extends Omit<
  TimelineDelegationWorkRow,
  "childRows"
> {
  childRows: ThreadTimelineViewRow[];
}

export type TimelineViewWorkRow =
  | Exclude<TimelineWorkRow, TimelineDelegationWorkRow>
  | TimelineViewDelegationWorkRow;

export type TimelineViewSourceRow =
  | TimelineConversationRow
  | TimelineViewWorkRow
  | TimelineSystemRow;

export interface TimelineActivitySummaryRow extends TimelineRowBase {
  kind: "activity-summary";
  status: TimelineRowStatus;
  children: TimelineViewWorkRow[];
}

export interface TimelineViewTurnRow extends Omit<TimelineTurnRow, "children"> {
  children: ThreadTimelineViewRow[] | null;
}

export type ThreadTimelineViewRow =
  | TimelineViewSourceRow
  | TimelineActivitySummaryRow
  | TimelineViewTurnRow;

export interface TimelineActivitySummaryCounts {
  commands: number;
  createdFiles: number;
  deletedFiles: number;
  delegations: number;
  editedFiles: number;
  fileChanges: number;
  files: number;
  lists: number;
  renamedFiles: number;
  searches: number;
  tools: number;
  webFetches: number;
  webSearches: number;
}

type TimelineActivitySummaryCategory =
  | "commands"
  | "delegations"
  | "exploration"
  | "fileChanges"
  | "tools"
  | "webResearch";

interface TimelineActivitySummaryRange extends TimelineRowBase {
  status: TimelineRowStatus;
}

function plural(count: number, singular: string, pluralName?: string): string {
  return `${count} ${count === 1 ? singular : (pluralName ?? `${singular}s`)}`;
}

function lowerFirst(value: string): string {
  return value.length === 0
    ? value
    : `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

function getExploredFileIdentity(
  intent: TimelineCommandWorkRow["activityIntents"][number],
): string | null {
  switch (intent.type) {
    case "read":
      return intent.path ?? intent.name;
    case "list_files":
    case "search":
    case "unknown":
      return null;
    default:
      return assertNever(intent);
  }
}

function countExplorationIntents(
  row: TimelineCommandWorkRow | TimelineToolWorkRow,
  counts: TimelineActivitySummaryCounts,
  exploredFileIdentities: Set<string>,
): void {
  for (const intent of row.activityIntents) {
    switch (intent.type) {
      case "read": {
        const identity = getExploredFileIdentity(intent);
        if (identity) {
          exploredFileIdentities.add(identity);
        }
        break;
      }
      case "list_files":
        counts.lists += 1;
        break;
      case "search":
        counts.searches += 1;
        break;
      case "unknown":
        break;
      default:
        assertNever(intent);
    }
  }
}

function getFileChangeIdentity(row: TimelineFileChangeWorkRow): string {
  return row.change.movePath ?? row.change.path;
}

export function summarizeTimelineActivity(
  rows: readonly TimelineViewWorkRow[],
): TimelineActivitySummaryCounts {
  const counts: TimelineActivitySummaryCounts = {
    commands: 0,
    createdFiles: 0,
    deletedFiles: 0,
    delegations: 0,
    editedFiles: 0,
    fileChanges: 0,
    files: 0,
    lists: 0,
    renamedFiles: 0,
    searches: 0,
    tools: 0,
    webFetches: 0,
    webSearches: 0,
  };
  const exploredFileIdentities = new Set<string>();
  const createdFileIdentities = new Set<string>();
  const deletedFileIdentities = new Set<string>();
  const editedFileIdentities = new Set<string>();
  const renamedFileIdentities = new Set<string>();

  for (const row of rows) {
    switch (row.workKind) {
      case "command":
        if (hasTimelineExplorationIntent(row)) {
          countExplorationIntents(row, counts, exploredFileIdentities);
        } else {
          counts.commands += 1;
        }
        break;
      case "tool":
        if (hasTimelineExplorationIntent(row)) {
          countExplorationIntents(row, counts, exploredFileIdentities);
        } else {
          counts.tools += 1;
        }
        break;
      case "file-change":
        switch (getFileChangeAction(row.change)) {
          case "created":
            createdFileIdentities.add(getFileChangeIdentity(row));
            break;
          case "deleted":
            deletedFileIdentities.add(getFileChangeIdentity(row));
            break;
          case "edited":
            editedFileIdentities.add(getFileChangeIdentity(row));
            break;
          case "renamed":
            renamedFileIdentities.add(getFileChangeIdentity(row));
            break;
        }
        break;
      case "web-fetch":
        counts.webFetches += 1;
        break;
      case "web-search":
        counts.webSearches += Math.max(1, row.queries.length);
        break;
      case "delegation":
        counts.delegations += 1;
        break;
      case "approval":
        break;
      default:
        assertNever(row);
    }
  }

  counts.files = exploredFileIdentities.size;
  counts.createdFiles = createdFileIdentities.size;
  counts.deletedFiles = deletedFileIdentities.size;
  counts.editedFiles = editedFileIdentities.size;
  counts.renamedFiles = renamedFileIdentities.size;
  counts.fileChanges =
    counts.createdFiles +
    counts.deletedFiles +
    counts.editedFiles +
    counts.renamedFiles;
  return counts;
}

function explorationDetail(
  counts: TimelineActivitySummaryCounts,
): string | null {
  const parts = [
    counts.files > 0 ? plural(counts.files, "file") : null,
    counts.searches > 0 ? plural(counts.searches, "search", "searches") : null,
    counts.lists > 0 ? plural(counts.lists, "list") : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

function hasOnlyExploration(counts: TimelineActivitySummaryCounts): boolean {
  return (
    counts.commands === 0 &&
    counts.delegations === 0 &&
    counts.fileChanges === 0 &&
    counts.tools === 0 &&
    counts.webFetches === 0 &&
    counts.webSearches === 0 &&
    (counts.files > 0 || counts.searches > 0 || counts.lists > 0)
  );
}

function hasOnlyCommands(counts: TimelineActivitySummaryCounts): boolean {
  return (
    counts.commands > 0 &&
    counts.delegations === 0 &&
    counts.fileChanges === 0 &&
    counts.files === 0 &&
    counts.lists === 0 &&
    counts.searches === 0 &&
    counts.tools === 0 &&
    counts.webFetches === 0 &&
    counts.webSearches === 0
  );
}

function hasOnlyDelegations(counts: TimelineActivitySummaryCounts): boolean {
  return (
    counts.delegations > 0 &&
    counts.commands === 0 &&
    counts.fileChanges === 0 &&
    counts.files === 0 &&
    counts.lists === 0 &&
    counts.searches === 0 &&
    counts.tools === 0 &&
    counts.webFetches === 0 &&
    counts.webSearches === 0
  );
}

function hasOnlyWebResearch(counts: TimelineActivitySummaryCounts): boolean {
  return (
    counts.commands === 0 &&
    counts.delegations === 0 &&
    counts.fileChanges === 0 &&
    counts.files === 0 &&
    counts.lists === 0 &&
    counts.searches === 0 &&
    counts.tools === 0 &&
    (counts.webFetches > 0 || counts.webSearches > 0)
  );
}

function hasOnlyFileChanges(counts: TimelineActivitySummaryCounts): boolean {
  return (
    counts.fileChanges > 0 &&
    counts.commands === 0 &&
    counts.delegations === 0 &&
    counts.files === 0 &&
    counts.lists === 0 &&
    counts.searches === 0 &&
    counts.tools === 0 &&
    counts.webFetches === 0 &&
    counts.webSearches === 0
  );
}

function getTimelineActivitySummaryCategory(
  row: TimelineViewWorkRow,
): TimelineActivitySummaryCategory | null {
  switch (row.workKind) {
    case "command":
      return hasTimelineExplorationIntent(row) ? "exploration" : "commands";
    case "tool":
      return hasTimelineExplorationIntent(row) ? "exploration" : "tools";
    case "file-change":
      return "fileChanges";
    case "web-fetch":
    case "web-search":
      return "webResearch";
    case "delegation":
      return "delegations";
    case "approval":
      return null;
    default:
      return assertNever(row);
  }
}

function getOrderedSummaryCategories(
  rows: readonly TimelineViewWorkRow[],
): TimelineActivitySummaryCategory[] {
  const categories: TimelineActivitySummaryCategory[] = [];
  for (const row of rows) {
    const category = getTimelineActivitySummaryCategory(row);
    if (category && !categories.includes(category)) {
      categories.push(category);
    }
  }
  return categories;
}

function fileChangeSummaryPhrase(
  counts: TimelineActivitySummaryCounts,
  active: boolean,
): string | null {
  const parts = [
    counts.createdFiles > 0
      ? `${active ? "Creating" : "Created"} ${plural(
          counts.createdFiles,
          "file",
        )}`
      : null,
    counts.deletedFiles > 0
      ? `${active ? "Deleting" : "Deleted"} ${plural(
          counts.deletedFiles,
          "file",
        )}`
      : null,
    counts.renamedFiles > 0
      ? `${active ? "Renaming" : "Renamed"} ${plural(
          counts.renamedFiles,
          "file",
        )}`
      : null,
    counts.editedFiles > 0
      ? `${active ? "Editing" : "Edited"} ${plural(
          counts.editedFiles,
          "file",
        )}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0
    ? null
    : parts
        .map((part, index) => (index === 0 ? part : lowerFirst(part)))
        .join(", ");
}

function completedSummaryPhrase(
  category: TimelineActivitySummaryCategory,
  counts: TimelineActivitySummaryCounts,
  exploration: string | null,
): string | null {
  switch (category) {
    case "exploration":
      return exploration ? `Explored ${exploration}` : null;
    case "commands":
      return counts.commands > 0
        ? `Ran ${plural(counts.commands, "command")}`
        : null;
    case "fileChanges":
      return fileChangeSummaryPhrase(counts, false);
    case "webResearch":
      return webResearchSummaryPhrase(counts, false);
    case "delegations":
      return counts.delegations > 0
        ? `Ran ${plural(counts.delegations, "subagent")}`
        : null;
    case "tools":
      return counts.tools > 0 ? `Ran ${plural(counts.tools, "tool")}` : null;
    default:
      return assertNever(category);
  }
}

function webResearchSummaryPhrase(
  counts: TimelineActivitySummaryCounts,
  active: boolean,
): string | null {
  const parts: string[] = [];
  if (counts.webSearches > 0) {
    parts.push(
      `${active ? "Running" : "Ran"} ${plural(
        counts.webSearches,
        "web search",
        "web searches",
      )}`,
    );
  }
  if (counts.webFetches > 0) {
    const verb =
      parts.length === 0
        ? active
          ? "Fetching"
          : "Fetched"
        : active
          ? "fetching"
          : "fetched";
    parts.push(`${verb} ${plural(counts.webFetches, "web page")}`);
  }

  return parts.length === 0 ? null : parts.join(", ");
}

export function buildTimelineActivitySummaryLabel(
  row: TimelineActivitySummaryRow,
): string {
  const counts = summarizeTimelineActivity(row.children);
  const active = row.status === "pending";
  const exploration = explorationDetail(counts);

  if (active) {
    if (exploration && hasOnlyExploration(counts)) {
      return `Exploring ${exploration}`;
    }
    if (hasOnlyCommands(counts)) {
      return `Running ${plural(counts.commands, "command")}`;
    }
    if (hasOnlyDelegations(counts)) {
      return `Running ${plural(counts.delegations, "subagent")}`;
    }
    if (hasOnlyWebResearch(counts)) {
      return (
        webResearchSummaryPhrase(counts, true) ??
        `Working on ${plural(row.children.length, "item")}`
      );
    }
    if (hasOnlyFileChanges(counts)) {
      return (
        fileChangeSummaryPhrase(counts, true) ??
        `Working on ${plural(row.children.length, "item")}`
      );
    }
    return `Working on ${plural(row.children.length, "item")}`;
  }

  const phrases = getOrderedSummaryCategories(row.children)
    .map((category) => completedSummaryPhrase(category, counts, exploration))
    .filter((phrase): phrase is string => phrase !== null);

  if (phrases.length === 0) {
    return `Worked on ${plural(row.children.length, "item")}`;
  }

  return phrases
    .map((phrase, index) => (index === 0 ? phrase : lowerFirst(phrase)))
    .join(", ");
}

function mergeTimelineStatus(
  left: TimelineRowStatus,
  right: TimelineRowStatus,
): TimelineRowStatus {
  if (left === "error" || right === "error") {
    return "error";
  }
  if (left === "pending" || right === "pending") {
    return "pending";
  }
  if (left === "interrupted" || right === "interrupted") {
    return "interrupted";
  }
  return "completed";
}

function summarizeRange(
  children: readonly TimelineViewWorkRow[],
): TimelineActivitySummaryRange {
  const first = children[0];
  if (!first) {
    throw new Error("Cannot summarize an empty timeline activity run");
  }

  let sourceSeqStart = first.sourceSeqStart;
  let sourceSeqEnd = first.sourceSeqEnd;
  let startedAt = first.startedAt;
  let createdAt = first.createdAt;
  let turnId = first.turnId;
  let status = first.status;

  for (const child of children) {
    sourceSeqStart = Math.min(sourceSeqStart, child.sourceSeqStart);
    sourceSeqEnd = Math.max(sourceSeqEnd, child.sourceSeqEnd);
    startedAt = Math.min(startedAt, child.startedAt);
    createdAt = Math.max(createdAt, child.createdAt);
    status = mergeTimelineStatus(status, child.status);
    if (turnId !== child.turnId) {
      turnId = null;
    }
  }

  return {
    id: [
      first.threadId,
      turnId ?? "thread",
      "activity-summary",
      String(sourceSeqStart),
      String(sourceSeqEnd),
    ].join(":"),
    threadId: first.threadId,
    turnId,
    sourceSeqStart,
    sourceSeqEnd,
    startedAt,
    createdAt,
    status,
  };
}

function isSummarizableWorkRow(
  row: ThreadTimelineViewRow,
): row is TimelineViewWorkRow {
  return row.kind === "work" && row.workKind !== "approval";
}

function shouldSummarizeRun(rows: readonly TimelineViewWorkRow[]): boolean {
  if (rows.length > 1) {
    return true;
  }
  const only = rows[0];
  if (!only) {
    return false;
  }
  if (
    (only.workKind === "command" || only.workKind === "tool") &&
    hasTimelineExplorationIntent(only)
  ) {
    return true;
  }
  return only.workKind === "web-search" || only.workKind === "web-fetch";
}

function buildActivitySummaryRow(
  children: TimelineViewWorkRow[],
): TimelineActivitySummaryRow {
  return {
    ...summarizeRange(children),
    kind: "activity-summary",
    children,
  };
}

function toTimelineViewWorkRow(row: TimelineWorkRow): TimelineViewWorkRow {
  if (row.workKind !== "delegation") {
    return row;
  }

  return {
    ...row,
    childRows: buildTimelineViewRows(row.childRows),
  };
}

function toTimelineViewRow(row: TimelineRow): ThreadTimelineViewRow {
  switch (row.kind) {
    case "conversation":
    case "system":
      return row;
    case "work":
      return toTimelineViewWorkRow(row);
    case "turn":
      return {
        ...row,
        children: row.children ? buildTimelineViewRows(row.children) : null,
      };
    default:
      return assertNever(row);
  }
}

export function buildTimelineViewRows(
  rows: readonly TimelineRow[],
): ThreadTimelineViewRow[] {
  const viewRows = rows.map(toTimelineViewRow);
  const groupedRows: ThreadTimelineViewRow[] = [];
  let run: TimelineViewWorkRow[] = [];

  const flushRun = (): void => {
    if (run.length === 0) {
      return;
    }
    if (shouldSummarizeRun(run)) {
      groupedRows.push(buildActivitySummaryRow(run));
    } else {
      groupedRows.push(...run);
    }
    run = [];
  };

  for (const row of viewRows) {
    if (!isSummarizableWorkRow(row)) {
      flushRun();
      groupedRows.push(row);
      continue;
    }
    run.push(row);
  }

  flushRun();
  return groupedRows;
}
