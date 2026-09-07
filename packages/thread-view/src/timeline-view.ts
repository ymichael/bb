import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineConversationRow,
  TimelineDelegationWorkRow,
  TimelineFileChangeWorkRow,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSystemRow,
  TimelineTurnRow,
  TimelineWorkRow,
} from "@bb/server-contract";
import { assertNever } from "./assert-never.js";
import {
  getFileChangeAction,
  type FileChangeAction,
} from "./file-change-summary.js";
import { plural } from "./format-helpers.js";
import {
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  timelineRowActivityIntents,
  type TimelineExplorationWorkRow,
} from "./timeline-activity-intents.js";

export interface TimelineViewDelegationWorkRow extends Omit<
  TimelineDelegationWorkRow,
  "childRows"
> {
  childRows: ThreadTimelineViewRow[];
  inClosedStep?: boolean;
}

type TimelineViewLeafWorkRow = Exclude<
  TimelineWorkRow,
  TimelineDelegationWorkRow
> & {
  inClosedStep?: boolean;
};

export type TimelineViewWorkRow =
  | TimelineViewLeafWorkRow
  | TimelineViewDelegationWorkRow;

export type TimelineQuestionViewWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "question" }
>;
export type TimelineImageViewViewWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "image-view" }
>;
export type TimelineViewWorkflowWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "workflow" }
>;

type TimelineViewSourceRow =
  | TimelineConversationRow
  | TimelineViewWorkRow
  | TimelineSystemRow;

export interface TimelineStepSummaryRow extends TimelineRowBase {
  kind: "step-summary";
  status: TimelineRowStatus;
  children: TimelineViewWorkRow[];
}

export interface TimelineBundleSummaryRow extends TimelineRowBase {
  kind: "bundle-summary";
  status: TimelineRowStatus;
  children: TimelineViewWorkRow[];
}

export type TimelineWorkSummaryRow =
  | TimelineStepSummaryRow
  | TimelineBundleSummaryRow;

export type TimelineWorkSummaryKind = TimelineWorkSummaryRow["kind"];

export interface TimelineViewTurnRow extends Omit<TimelineTurnRow, "children"> {
  children: ThreadTimelineViewRow[] | null;
}

export type ThreadTimelineViewRow =
  | TimelineViewSourceRow
  | TimelineWorkSummaryRow
  | TimelineViewTurnRow;

type TimelineExplorationKind = "files" | "searches" | "lists";

interface TimelineWorkSummaryCounts {
  commands: number;
  createdFiles: number;
  deletedFiles: number;
  delegations: number;
  editedFiles: number;
  extensions: number;
  fileChanges: number;
  files: number;
  lists: number;
  planUpdates: number;
  renamedFiles: number;
  searches: number;
  tools: number;
  webFetches: number;
  webSearches: number;
  imageViews: number;
  explorationKindOrder: readonly TimelineExplorationKind[];
}

type TimelineWorkSummaryCategory =
  | "commands"
  | "delegations"
  | "exploration"
  | "extensions"
  | "fileChanges"
  | "imageViews"
  | "planUpdates"
  | "tools"
  | "webResearch";

type TimelineWorkSummaryPhraseList = readonly string[];

interface TimelineWorkSummaryRange extends TimelineRowBase {
  status: TimelineRowStatus;
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
  row: TimelineExplorationWorkRow,
  counts: TimelineWorkSummaryCounts,
  exploredFileIdentities: Set<string>,
  noteExplorationKind: (kind: TimelineExplorationKind) => void,
): void {
  for (const intent of timelineRowActivityIntents(row)) {
    switch (intent.type) {
      case "read": {
        const identity = getExploredFileIdentity(intent);
        if (identity) {
          exploredFileIdentities.add(identity);
          noteExplorationKind("files");
        }
        break;
      }
      case "list_files":
        counts.lists += 1;
        noteExplorationKind("lists");
        break;
      case "search":
        counts.searches += 1;
        noteExplorationKind("searches");
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

function summarizeTimelineWork(
  rows: readonly TimelineViewWorkRow[],
): TimelineWorkSummaryCounts {
  const explorationKindOrder: TimelineExplorationKind[] = [];
  const seenExplorationKinds = new Set<TimelineExplorationKind>();
  const noteExplorationKind = (kind: TimelineExplorationKind) => {
    if (!seenExplorationKinds.has(kind)) {
      seenExplorationKinds.add(kind);
      explorationKindOrder.push(kind);
    }
  };

  const counts: TimelineWorkSummaryCounts = {
    commands: 0,
    createdFiles: 0,
    deletedFiles: 0,
    delegations: 0,
    editedFiles: 0,
    extensions: 0,
    fileChanges: 0,
    files: 0,
    lists: 0,
    planUpdates: 0,
    renamedFiles: 0,
    searches: 0,
    tools: 0,
    webFetches: 0,
    webSearches: 0,
    imageViews: 0,
    explorationKindOrder,
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
          countExplorationIntents(
            row,
            counts,
            exploredFileIdentities,
            noteExplorationKind,
          );
        } else {
          counts.commands += 1;
        }
        break;
      case "tool":
        counts.tools += 1;
        break;
      case "file-read":
      case "search":
        countExplorationIntents(
          row,
          counts,
          exploredFileIdentities,
          noteExplorationKind,
        );
        break;
      case "plan-steps":
        counts.planUpdates += 1;
        break;
      case "extension":
        counts.extensions += 1;
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
      case "image-view":
        counts.imageViews += 1;
        break;
      case "delegation":
        counts.delegations += 1;
        break;
      case "question":
      case "approval":
      case "workflow":
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

function explorationDetail(counts: TimelineWorkSummaryCounts): string | null {
  const parts = counts.explorationKindOrder
    .map((kind): string | null => {
      switch (kind) {
        case "files":
          return counts.files > 0 ? plural(counts.files, "file") : null;
        case "searches":
          return counts.searches > 0
            ? plural(counts.searches, "search", "searches")
            : null;
        case "lists":
          return counts.lists > 0 ? plural(counts.lists, "list") : null;
        default:
          return assertNever(kind);
      }
    })
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

function approvalStatusSummaryLabel(
  rows: readonly TimelineViewWorkRow[],
): string | null {
  let status: "waiting_for_approval" | "denied" | null = null;
  let commands = 0;
  let fileChanges = 0;
  let tools = 0;

  for (const row of rows) {
    let rowApprovalStatus: "waiting_for_approval" | "denied";
    switch (row.workKind) {
      case "command":
        if (row.approvalStatus === null) {
          return null;
        }
        rowApprovalStatus = row.approvalStatus;
        commands += 1;
        break;
      case "file-change":
        if (row.approvalStatus === null) {
          return null;
        }
        rowApprovalStatus = row.approvalStatus;
        fileChanges += 1;
        break;
      case "tool":
        if (row.approvalStatus === null) {
          return null;
        }
        rowApprovalStatus = row.approvalStatus;
        tools += 1;
        break;
      case "approval":
      case "question":
      case "delegation":
      case "extension":
      case "file-read":
      case "image-view":
      case "plan-steps":
      case "search":
      case "web-fetch":
      case "web-search":
      case "workflow":
        return null;
      default:
        assertNever(row);
    }

    if (status === null) {
      status = rowApprovalStatus;
    } else if (status !== rowApprovalStatus) {
      return null;
    }
  }

  if (status === null) {
    return null;
  }

  const details = [
    commands > 0 ? plural(commands, "command") : null,
    fileChanges > 0 ? plural(fileChanges, "file change") : null,
    tools > 0 ? plural(tools, "tool") : null,
  ].filter((detail): detail is string => detail !== null);
  const detail = details.join(", ");

  return status === "denied"
    ? `Denied ${detail}`
    : `Waiting for approval on ${detail}`;
}

function getTimelineWorkSummaryCategory(
  row: TimelineViewWorkRow,
): TimelineWorkSummaryCategory | null {
  switch (row.workKind) {
    case "command":
      return hasTimelineExplorationIntent(row) ? "exploration" : "commands";
    case "tool":
      return "tools";
    case "file-read":
    case "search":
      return "exploration";
    case "plan-steps":
      return "planUpdates";
    case "extension":
      return "extensions";
    case "file-change":
      return "fileChanges";
    case "web-fetch":
    case "web-search":
      return "webResearch";
    case "image-view":
      return "imageViews";
    case "delegation":
      return "delegations";
    case "approval":
    case "question":
    case "workflow":
      return null;
    default:
      return assertNever(row);
  }
}

function getOrderedSummaryCategories(
  rows: readonly TimelineViewWorkRow[],
): TimelineWorkSummaryCategory[] {
  const categories: TimelineWorkSummaryCategory[] = [];
  for (const row of rows) {
    const category = getTimelineWorkSummaryCategory(row);
    if (category && !categories.includes(category)) {
      categories.push(category);
    }
  }
  return categories;
}

const FILE_CHANGE_VERBS_PRESENT: Record<FileChangeAction, string> = {
  created: "Creating",
  deleted: "Deleting",
  edited: "Editing",
  renamed: "Renaming",
};

const FILE_CHANGE_VERBS_PAST: Record<FileChangeAction, string> = {
  created: "Created",
  deleted: "Deleted",
  edited: "Edited",
  renamed: "Renamed",
};

function fileChangeSummaryPhrase(
  counts: TimelineWorkSummaryCounts,
  active: boolean,
): string | null {
  const present: { action: FileChangeAction; count: number }[] = (
    [
      ["created", counts.createdFiles],
      ["deleted", counts.deletedFiles],
      ["edited", counts.editedFiles],
      ["renamed", counts.renamedFiles],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([action, count]) => ({ action, count }));

  if (present.length === 0) return null;

  if (present.length === 1) {
    const { action, count } = present[0]!;
    const verb = active
      ? FILE_CHANGE_VERBS_PRESENT[action]
      : FILE_CHANGE_VERBS_PAST[action];
    return `${verb} ${plural(count, "file")}`;
  }

  const total = present.reduce((sum, p) => sum + p.count, 0);
  const verb = active ? "Editing" : "Edited";
  return `${verb} ${plural(total, "file")}`;
}

function completedSummaryPhrase(
  category: TimelineWorkSummaryCategory,
  counts: TimelineWorkSummaryCounts,
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
    case "imageViews":
      return imageViewSummaryPhrase(counts, false);
    case "delegations":
      return counts.delegations > 0
        ? `Ran ${plural(counts.delegations, "subagent")}`
        : null;
    case "tools":
      return counts.tools > 0 ? `Ran ${plural(counts.tools, "tool")}` : null;
    case "planUpdates":
      return counts.planUpdates > 0
        ? `Updated plan ${plural(counts.planUpdates, "time")}`
        : null;
    case "extensions":
      return counts.extensions > 0
        ? `Ran ${plural(counts.extensions, "plugin step")}`
        : null;
    default:
      return assertNever(category);
  }
}

function activeSummaryPhrase(
  category: TimelineWorkSummaryCategory,
  counts: TimelineWorkSummaryCounts,
  exploration: string | null,
): string | null {
  switch (category) {
    case "exploration":
      return exploration ? `Exploring ${exploration}` : null;
    case "commands":
      return counts.commands > 0
        ? `Running ${plural(counts.commands, "command")}`
        : null;
    case "fileChanges":
      return fileChangeSummaryPhrase(counts, true);
    case "webResearch":
      return webResearchSummaryPhrase(counts, true);
    case "imageViews":
      return imageViewSummaryPhrase(counts, true);
    case "delegations":
      return counts.delegations > 0
        ? `Running ${plural(counts.delegations, "subagent")}`
        : null;
    case "tools":
      return counts.tools > 0
        ? `Running ${plural(counts.tools, "tool")}`
        : null;
    case "planUpdates":
      return counts.planUpdates > 0 ? "Updating plan" : null;
    case "extensions":
      return counts.extensions > 0
        ? `Running ${plural(counts.extensions, "plugin step")}`
        : null;
    default:
      return assertNever(category);
  }
}

function joinSummaryPhrases(phrases: TimelineWorkSummaryPhraseList): string {
  return phrases
    .map((phrase, index) => (index === 0 ? phrase : lowerFirst(phrase)))
    .join(", ");
}

function webResearchSummaryPhrase(
  counts: TimelineWorkSummaryCounts,
  active: boolean,
): string | null {
  const parts: string[] = [];
  if (counts.webSearches > 0) {
    parts.push(plural(counts.webSearches, "search query", "search queries"));
  }
  if (counts.webFetches > 0) {
    parts.push(plural(counts.webFetches, "web page"));
  }
  if (parts.length === 0) return null;
  const verb = active ? "Researching" : "Researched";
  return `${verb} ${parts.join(", ")}`;
}

function imageViewSummaryPhrase(
  counts: TimelineWorkSummaryCounts,
  active: boolean,
): string | null {
  if (counts.imageViews === 0) return null;
  const verb = active ? "Viewing" : "Viewed";
  return `${verb} ${plural(counts.imageViews, "image")}`;
}

interface TimelineWorkSummaryLabelParts {
  verb: string;
  rest: string;
}

export function buildTimelineWorkSummaryLabelParts(
  row: TimelineWorkSummaryRow,
  options: { active: boolean } = { active: false },
): TimelineWorkSummaryLabelParts {
  const approvalSummaryLabel = approvalStatusSummaryLabel(row.children);
  if (approvalSummaryLabel !== null) {
    return splitVerbAndRest(approvalSummaryLabel);
  }

  const counts = summarizeTimelineWork(row.children);
  const active = options.active;
  const exploration = explorationDetail(counts);

  const phrases = getOrderedSummaryCategories(row.children)
    .map((category) =>
      active
        ? activeSummaryPhrase(category, counts, exploration)
        : completedSummaryPhrase(category, counts, exploration),
    )
    .filter((phrase): phrase is string => phrase !== null);

  if (phrases.length === 0) {
    return { verb: active ? "Working" : "Worked", rest: "" };
  }

  return splitVerbAndRest(joinSummaryPhrases(phrases));
}

export function buildTimelineWorkSummaryLabel(
  row: TimelineWorkSummaryRow,
  options: { active: boolean } = { active: false },
): string {
  const { verb, rest } = buildTimelineWorkSummaryLabelParts(row, options);
  return rest.length === 0 ? verb : `${verb} ${rest}`;
}

function splitVerbAndRest(label: string): TimelineWorkSummaryLabelParts {
  const spaceIndex = label.indexOf(" ");
  if (spaceIndex === -1) {
    return { verb: label, rest: "" };
  }
  return {
    verb: label.slice(0, spaceIndex),
    rest: label.slice(spaceIndex + 1),
  };
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
): TimelineWorkSummaryRange {
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
    id: [first.threadId, turnId ?? "thread", "work-summary", first.id].join(
      ":",
    ),
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
  return (
    row.kind === "work" &&
    row.workKind !== "approval" &&
    row.workKind !== "question" &&
    row.workKind !== "workflow"
  );
}

function isTimelineStepBoundary(row: ThreadTimelineViewRow): boolean {
  if (row.kind !== "conversation") return false;
  if (row.role === "user" && row.turnRequest.status === "pending") {
    return false;
  }
  return true;
}

function rowConcept(row: TimelineViewWorkRow): TimelineWorkSummaryCategory {
  switch (row.workKind) {
    case "command":
      return hasTimelineExplorationIntent(row) ? "exploration" : "commands";
    case "tool":
      return "tools";
    case "file-read":
    case "search":
      return "exploration";
    case "plan-steps":
      return "planUpdates";
    case "extension":
      return "extensions";
    case "file-change":
      return "fileChanges";
    case "delegation":
      return "delegations";
    case "web-search":
    case "web-fetch":
      return "webResearch";
    case "image-view":
      return "imageViews";
    case "approval":
    case "question":
    case "workflow":
      return "tools";
    default:
      return assertNever(row);
  }
}

function dedupeBundleChildIntents(
  children: TimelineViewWorkRow[],
): TimelineViewWorkRow[] {
  let lastEmittedKey: string | null = null;
  const out: TimelineViewWorkRow[] = [];
  for (const child of children) {
    if (child.workKind === "file-read" || child.workKind === "search") {
      const [intent] = timelineRowActivityIntents(child);
      const key = intent
        ? getTimelineActivityIntentDetailDedupeKey(intent)
        : null;
      if (key !== null && key === lastEmittedKey) {
        continue;
      }
      lastEmittedKey = key;
      out.push(child);
      continue;
    }
    if (child.workKind !== "command" || child.activityIntents.length === 0) {
      lastEmittedKey = null;
      out.push(child);
      continue;
    }
    const wasExploration = hasTimelineExplorationIntent(child);
    const filtered: TimelineActivityIntent[] = [];
    for (const intent of child.activityIntents) {
      if (intent.type === "unknown") {
        filtered.push(intent);
        continue;
      }
      const key = getTimelineActivityIntentDetailDedupeKey(intent);
      if (key !== null && key === lastEmittedKey) {
        continue;
      }
      filtered.push(intent);
      lastEmittedKey = key;
    }
    if (filtered.length === child.activityIntents.length) {
      out.push(child);
      continue;
    }
    if (
      wasExploration &&
      !filtered.some((intent) => intent.type !== "unknown")
    ) {
      continue;
    }
    out.push({ ...child, activityIntents: filtered });
  }
  return out;
}

function buildStepSummaryRow(
  children: TimelineViewWorkRow[],
): TimelineStepSummaryRow {
  const dedupedChildren = dedupeBundleChildIntents(children);
  return {
    ...summarizeRange(dedupedChildren),
    kind: "step-summary",
    children: dedupedChildren,
  };
}

function buildBundleSummaryRow(
  children: TimelineViewWorkRow[],
): TimelineBundleSummaryRow {
  const dedupedChildren = dedupeBundleChildIntents(children);
  return {
    ...summarizeRange(dedupedChildren),
    kind: "bundle-summary",
    children: dedupedChildren,
  };
}

function closeOpenStepAtBoundary(
  work: TimelineViewWorkRow[],
): ThreadTimelineViewRow[] {
  if (work.length === 0) return [];
  if (work.length === 1) {
    return [{ ...work[0]!, inClosedStep: true }];
  }
  return [buildStepSummaryRow(work)];
}

function flushOpenStepAsBundles(
  work: TimelineViewWorkRow[],
): ThreadTimelineViewRow[] {
  if (work.length === 0) return [];

  interface Group {
    concept: TimelineWorkSummaryCategory;
    rows: TimelineViewWorkRow[];
  }

  const groups: Group[] = [];
  for (const row of work) {
    const concept = rowConcept(row);
    const last = groups[groups.length - 1];
    if (last && last.concept === concept) {
      last.rows.push(row);
    } else {
      groups.push({ concept, rows: [row] });
    }
  }

  const out: ThreadTimelineViewRow[] = [];
  for (const group of groups) {
    if (group.rows.length === 1) {
      out.push(group.rows[0]!);
    } else {
      out.push(buildBundleSummaryRow(group.rows));
    }
  }
  return out;
}

type TimelineViewRowsCache = WeakMap<
  readonly TimelineRow[],
  ThreadTimelineViewRow[]
>;

export function createTimelineViewRowsCache(): TimelineViewRowsCache {
  return new WeakMap();
}

function toTimelineViewWorkRow(
  row: TimelineWorkRow,
  cache: TimelineViewRowsCache,
): TimelineViewWorkRow {
  if (row.workKind !== "delegation") {
    return row;
  }

  const closedScope = row.status !== "pending";
  return {
    ...row,
    childRows: buildTimelineViewRows(row.childRows, { cache, closedScope }),
  };
}

function toTimelineViewRow(
  row: TimelineRow,
  cache: TimelineViewRowsCache,
): ThreadTimelineViewRow {
  switch (row.kind) {
    case "conversation":
    case "system":
      return row;
    case "work":
      return toTimelineViewWorkRow(row, cache);
    case "turn":
      return {
        ...row,
        children: row.children
          ? buildTimelineViewRows(row.children, {
              cache,
              closedScope: true,
            })
          : null,
      };
    default:
      return assertNever(row);
  }
}

export interface BuildTimelineViewRowsOptions {
  closedScope?: boolean;
  cache?: TimelineViewRowsCache;
}

export function buildTimelineViewRows(
  rows: readonly TimelineRow[],
  options: BuildTimelineViewRowsOptions = {},
): ThreadTimelineViewRow[] {
  const cache = options.cache;
  if (cache) {
    const cached = cache.get(rows);
    if (cached) return cached;
  }
  const childCache = cache ?? createTimelineViewRowsCache();
  const viewRows = rows.map((row) => toTimelineViewRow(row, childCache));
  const result: ThreadTimelineViewRow[] = [];
  let openStep: TimelineViewWorkRow[] = [];

  for (const row of viewRows) {
    if (isSummarizableWorkRow(row)) {
      openStep.push(row);
      continue;
    }
    if (isTimelineStepBoundary(row)) {
      result.push(...closeOpenStepAtBoundary(openStep));
      openStep = [];
      result.push(row);
      continue;
    }
    result.push(...flushOpenStepAsBundles(openStep));
    openStep = [];
    result.push(row);
  }
  if (options.closedScope) {
    result.push(...closeOpenStepAtBoundary(openStep));
  } else {
    result.push(...flushOpenStepAsBundles(openStep));
  }
  if (cache) {
    cache.set(rows, result);
  }
  return result;
}
