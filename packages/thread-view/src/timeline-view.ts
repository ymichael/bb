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
  TimelineToolWorkRow,
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
} from "./timeline-activity-intents.js";

export interface TimelineViewDelegationWorkRow extends Omit<
  TimelineDelegationWorkRow,
  "childRows"
> {
  childRows: ThreadTimelineViewRow[];
  /**
   * Set to `true` for the sole leaf of an already-closed step (assistant
   * message boundary follows). Multi-item closed steps wrap in `step-summary`;
   * single-item closed steps stay bare and use this flag so the renderer can
   * apply muted "closed-step" treatment. Absent or `false` means the row is in
   * an open or active step.
   *
   * View-only — set by `closeOpenStepAtBoundary` during `buildTimelineViewRows`,
   * never persisted on the wire.
   */
  inClosedStep?: boolean;
}

export type TimelineViewLeafWorkRow = Exclude<
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

export type TimelineViewSourceRow =
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

export type TimelineExplorationKind = "files" | "searches" | "lists";

export interface TimelineWorkSummaryCounts {
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
  /** First-seen order of exploration kinds across the bundle's children. */
  explorationKindOrder: readonly TimelineExplorationKind[];
}

type TimelineWorkSummaryCategory =
  | "commands"
  | "delegations"
  | "exploration"
  | "fileChanges"
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
  row: TimelineCommandWorkRow | TimelineToolWorkRow,
  counts: TimelineWorkSummaryCounts,
  exploredFileIdentities: Set<string>,
  noteExplorationKind: (kind: TimelineExplorationKind) => void,
): void {
  for (const intent of row.activityIntents) {
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

export function summarizeTimelineWork(
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
    fileChanges: 0,
    files: 0,
    lists: 0,
    renamedFiles: 0,
    searches: 0,
    tools: 0,
    webFetches: 0,
    webSearches: 0,
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
        if (hasTimelineExplorationIntent(row)) {
          countExplorationIntents(
            row,
            counts,
            exploredFileIdentities,
            noteExplorationKind,
          );
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
      case "question":
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
  counts: TimelineWorkSummaryCounts,
): string | null {
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
      case "web-fetch":
      case "web-search":
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
      return hasTimelineExplorationIntent(row) ? "exploration" : "tools";
    case "file-change":
      return "fileChanges";
    case "web-fetch":
    case "web-search":
      return "webResearch";
    case "delegation":
      return "delegations";
    case "approval":
    case "question":
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

  // Single action kind — verb matches the action.
  if (present.length === 1) {
    const { action, count } = present[0]!;
    const verb = active
      ? FILE_CHANGE_VERBS_PRESENT[action]
      : FILE_CHANGE_VERBS_PAST[action];
    return `${verb} ${plural(count, "file")}`;
  }

  // Mixed — collapse under the umbrella "Edited" verb with the total count.
  // Avoids the awkward verb-soup of "Editing 4 files, deleting 1 file" and
  // sidesteps the parallel-verb emphasis problem in the title splitter.
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
    case "delegations":
      return counts.delegations > 0
        ? `Running ${plural(counts.delegations, "subagent")}`
        : null;
    case "tools":
      return counts.tools > 0
        ? `Running ${plural(counts.tools, "tool")}`
        : null;
    default:
      return assertNever(category);
  }
}

function joinSummaryPhrases(
  phrases: TimelineWorkSummaryPhraseList,
): string {
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
    parts.push(
      plural(counts.webSearches, "search query", "search queries"),
    );
  }
  if (counts.webFetches > 0) {
    parts.push(plural(counts.webFetches, "web page"));
  }
  if (parts.length === 0) return null;
  const verb = active ? "Researching" : "Researched";
  return `${verb} ${parts.join(", ")}`;
}

/**
 * The summary label split into its leading verb and the rest of the phrase.
 * Renderers can independently shimmer/em the verb without splitting strings.
 * `rest` is empty when the phrase is a single word like "Working" / "Worked".
 */
export interface TimelineWorkSummaryLabelParts {
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
    id: [
      first.threadId,
      turnId ?? "thread",
      "work-summary",
      first.id,
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
  return (
    row.kind === "work" &&
    row.workKind !== "approval" &&
    row.workKind !== "question"
  );
}

/**
 * A "step boundary" is a row that closes the current open assistant step.
 * Assistant messages and accepted user messages count; pending steers are
 * tail rows that sit outside the open step and do NOT close it.
 */
export function isTimelineStepBoundary(row: ThreadTimelineViewRow): boolean {
  if (row.kind !== "conversation") return false;
  if (row.role === "user" && row.userRequest.status === "pending") {
    return false;
  }
  return true;
}


/**
 * Concept identifier used for bundling. Same-concept consecutive leaves in an
 * open step form a bundle. The step-summary phrase aggregates these concepts.
 */
function rowConcept(row: TimelineViewWorkRow): TimelineWorkSummaryCategory {
  switch (row.workKind) {
    case "command":
    case "tool":
      return hasTimelineExplorationIntent(row)
        ? "exploration"
        : row.workKind === "command"
          ? "commands"
          : "tools";
    case "file-change":
      return "fileChanges";
    case "delegation":
      return "delegations";
    case "web-search":
    case "web-fetch":
      return "webResearch";
    case "approval":
    case "question":
      // Approval and question rows aren't summarizable; these branches are unreachable in
      // practice because callers filter via isSummarizableWorkRow.
      return "tools";
    default:
      return assertNever(row);
  }
}

/**
 * Drop activity intents whose dedupe key matches the previous *emitted* intent
 * across the bundle's child sequence. Within each child this collapses runs of
 * the same intent (e.g. a tool that emits two consecutive `Read foo` intents);
 * across children it collapses sibling rows whose lone intent matches the
 * previous row's last intent (e.g. `Read foo` then `Read foo` rendered as one
 * line). Non-exploration children break the chain so a `Read foo` row that
 * follows a delegation or file-edit isn't suppressed.
 *
 * Children whose activity intents were originally exploration content but are
 * fully suppressed by the dedupe pass are dropped from the returned list — if
 * we kept them with empty `activityIntents`, downstream code would treat them
 * as plain command/tool rows and render them as "Ran ..." entries.
 */
function dedupeBundleChildIntents(
  children: TimelineViewWorkRow[],
): TimelineViewWorkRow[] {
  let lastEmittedKey: string | null = null;
  const out: TimelineViewWorkRow[] = [];
  for (const child of children) {
    if (
      (child.workKind !== "command" && child.workKind !== "tool") ||
      child.activityIntents.length === 0
    ) {
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
    if (wasExploration && !filtered.some((intent) => intent.type !== "unknown")) {
      // Every visible intent was a duplicate of a sibling's; the row would
      // render as a bare command/tool, which is misleading. Drop it.
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

/**
 * Closes an open step at an assistant-message boundary. A multi-item step
 * collapses into one step-summary; a single-item step keeps the leaf bare
 * (Q1) and tags it with `inClosedStep` so the renderer applies the closed-
 * step muted treatment without a wrapper row.
 */
function closeOpenStepAtBoundary(
  work: TimelineViewWorkRow[],
): ThreadTimelineViewRow[] {
  if (work.length === 0) return [];
  if (work.length === 1) {
    return [{ ...work[0]!, inClosedStep: true }];
  }
  return [buildStepSummaryRow(work)];
}

/**
 * Flushes an open step that hasn't been closed by a boundary. Same-concept
 * consecutive leaves group into bundles; the bundle whose concept is the
 * step's most recent activity is `active-latest`. Single leaves stay as leaves.
 */
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

/**
 * Identity cache for `buildTimelineViewRows`. Each `rows` reference is
 * consumed under one scope (top-level or lazy turn detail) — so identity is a
 * sufficient key. Callers create one cache per render and reuse it across the
 * top-level call and any recursive child-row builds (delegation `childRows`,
 * lazy turn `children`).
 */
export type TimelineViewRowsCache = WeakMap<
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

  // A delegation that's no longer pending is a closed scope: no more child
  // work is going to arrive, so the trailing run of children should collapse
  // into a step-summary (mirrors the lazy-turn-detail handling). Pending
  // delegations stay open so the live frontier keeps showing as bundles +
  // leaves.
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
        // Lazy turn details represent a completed turn; trailing work inside
        // them collapses to a step-summary at end-of-children.
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
  /**
   * When `true`, the rows are part of a closed scope (e.g. lazy detail children
   * of a completed turn) and the trailing step has no chance of more work
   * arriving. The end-of-input flush collapses the trailing open step into a
   * step-summary instead of leaving its bundles + leaves visible.
   */
  closedScope?: boolean;
  /**
   * Identity cache reused across recursive child-row builds. Without it, every
   * top-level rebuild reprojects every delegation `childRows` and lazy turn
   * `children` from scratch. Reuse the same cache across nested calls in a
   * single render.
   */
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
      // Assistant or accepted-user message closes the previous step into a
      // step-summary (multi-item) or keeps the lone leaf as-is (single-item).
      result.push(...closeOpenStepAtBoundary(openStep));
      openStep = [];
      result.push(row);
      continue;
    }
    // Other non-boundary rows (pending steer, system, turn, approval) flush
    // the open step as bundles + leaves without merging into a step-summary.
    result.push(...flushOpenStepAsBundles(openStep));
    openStep = [];
    result.push(row);
  }
  // End of input: closed scopes collapse trailing work into a step-summary;
  // open scopes keep bundles + leaves visible so active work stays expanded.
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
