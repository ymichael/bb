import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type {
  EnvironmentWorkspaceDisplayKind,
  ReasoningLevel,
  ThreadChangeKind,
  ThreadLifecycleEvent,
  ThreadLifecycleNoopReason,
  ThreadOriginKind,
  ThreadSearchSourceKind,
  ThreadStatus,
  ThreadVisibility,
  WorkspaceProvisionType,
} from "@bb/domain";
import {
  evaluateThreadLifecycleEvent,
  resolveEnvironmentWorkspaceDisplayKind,
  threadSearchSourceKindSchema,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbQueryConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import {
  environments,
  pendingInteractions,
  projects,
  threadSearchSegments,
  threads,
} from "../schema.js";
import { createThreadId } from "../ids.js";
import {
  createOrderKeyBetween,
} from "./order-keys.js";

type ThreadWriteConnection = DbConnection | DbTransaction;

export const THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT = 20;
export const THREAD_SEARCH_LIMIT_PER_GROUP_MAX = 50;

const THREAD_SEARCH_MESSAGE_MATCHES_PER_THREAD = 1;
const THREAD_SEARCH_QUERY_TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;
const THREAD_SEARCH_HIGHLIGHT_RANGE_LIMIT = 8;
const THREAD_SEARCH_SNIPPET_MAX_CHARS = 160;
const THREAD_SEARCH_SNIPPET_LEAD_CHARS = 40;
const THREAD_SEARCH_SNIPPET_ELLIPSIS = "…";

type ThreadWhere = SQL | undefined;

function nonDeletedThreads(...where: ThreadWhere[]): ThreadWhere {
  return and(...where, isNull(threads.deletedAt));
}

function liveThreads(...where: ThreadWhere[]): ThreadWhere {
  return nonDeletedThreads(...where, isNull(threads.archivedAt));
}

function countThreadsWhere(
  db: ThreadWriteConnection,
  where: ThreadWhere,
): number {
  return db.select({ count: count() }).from(threads).where(where).get()?.count ?? 0;
}

function listThreadsWhere(
  db: ThreadWriteConnection,
  where: ThreadWhere,
): ThreadRow[] {
  return db.select().from(threads).where(where).all();
}

function hasThreadWhere(db: ThreadWriteConnection, where: ThreadWhere): boolean {
  return db.select({ id: threads.id }).from(threads).where(where).get() !== undefined;
}

export interface ThreadSearchHighlightRange {
  start: number;
  end: number;
}

export interface ThreadSearchMatch {
  sourceKind: ThreadSearchSourceKind;
  text: string;
  highlightRanges: ThreadSearchHighlightRange[];
  sourceSeq: number | null;
}

export interface ThreadSearchResult {
  thread: ThreadWithPendingInteractionState;
  matches: ThreadSearchMatch[];
}

export interface ThreadSearchResultGroup {
  total: number;
  results: ThreadSearchResult[];
}

export interface ThreadSearchResults {
  active: ThreadSearchResultGroup;
  archived: ThreadSearchResultGroup;
}

export interface SearchThreadsWithPendingInteractionStateArgs {
  query: string;
  limitPerGroup: number;
}

export interface UpsertThreadTitleSearchSegmentsArgs {
  threadId: string;
  title: string | null;
  titleFallback: string | null;
  updatedAt?: number;
}

export interface UpsertThreadSearchSegmentInput {
  threadId: string;
  sourceKind: ThreadSearchSourceKind;
  sourceKey: string;
  sourceSeq: number | null;
  text: string;
}

export interface UpsertThreadSearchSegmentsArgs {
  segments: readonly UpsertThreadSearchSegmentInput[];
  updatedAt?: number;
}

interface UpsertThreadSearchSegmentArgs extends UpsertThreadSearchSegmentInput {
  id: string;
  updatedAt: number;
}

interface ListThreadSearchMatchRowsArgs {
  anyTokenMatchQuery: string;
  limitPerGroup: number;
  tokenMatchQueries: readonly string[];
}

interface ThreadSearchMatchRow {
  archived: number;
  segmentOrder: number;
  sourceKind: string;
  sourceSeq: number | null;
  text: string;
  threadId: string;
  threadOrder: number;
  total: number;
}

interface HydrateThreadSearchGroupArgs {
  rows: readonly ThreadSearchMatchRow[];
  tokens: readonly string[];
}

interface ThreadSearchSnippet {
  highlightRanges: ThreadSearchHighlightRange[];
  text: string;
}

function buildThreadSearchSegmentId(args: {
  threadId: string;
  sourceKind: ThreadSearchSourceKind;
  sourceKey: string;
}): string {
  return `${args.threadId}:${args.sourceKind}:${args.sourceKey}`;
}

function deleteThreadSearchSegmentById(
  db: ThreadWriteConnection,
  id: string,
): void {
  db.delete(threadSearchSegments).where(eq(threadSearchSegments.id, id)).run();
}

function upsertThreadSearchSegment(
  db: ThreadWriteConnection,
  args: UpsertThreadSearchSegmentArgs,
): void {
  const searchableText = args.text.trim();
  if (searchableText.length === 0) {
    deleteThreadSearchSegmentById(db, args.id);
    return;
  }

  db.insert(threadSearchSegments)
    .values({
      id: args.id,
      threadId: args.threadId,
      sourceKind: args.sourceKind,
      sourceKey: args.sourceKey,
      sourceSeq: args.sourceSeq,
      text: searchableText,
      createdAt: args.updatedAt,
      updatedAt: args.updatedAt,
    })
    .onConflictDoUpdate({
      target: threadSearchSegments.id,
      set: {
        sourceKind: args.sourceKind,
        sourceKey: args.sourceKey,
        sourceSeq: args.sourceSeq,
        text: searchableText,
        updatedAt: args.updatedAt,
      },
    })
    .run();
}

export function upsertThreadSearchSegments(
  db: ThreadWriteConnection,
  args: UpsertThreadSearchSegmentsArgs,
): void {
  const updatedAt = args.updatedAt ?? Date.now();
  for (const segment of args.segments) {
    upsertThreadSearchSegment(db, {
      ...segment,
      id: buildThreadSearchSegmentId(segment),
      updatedAt,
    });
  }
}

function upsertThreadTitleSearchSegments(
  db: ThreadWriteConnection,
  args: UpsertThreadTitleSearchSegmentsArgs,
): void {
  upsertThreadSearchSegments(db, {
    updatedAt: args.updatedAt,
    segments: [
      {
        threadId: args.threadId,
        sourceKind: "title",
        sourceKey: "title",
        sourceSeq: null,
        text: args.title ?? "",
      },
      {
        threadId: args.threadId,
        sourceKind: "title_fallback",
        sourceKey: "title_fallback",
        sourceSeq: null,
        text: args.titleFallback ?? "",
      },
    ],
  });
}

export interface CreateThreadInput {
  projectId: string;
  environmentId?: string | null;
  providerId: string;
  title?: string | null;
  titleFallback?: string | null;
  sectionId?: string | null;
  status?: ThreadStatus;
  parentThreadId?: string | null;
  sourceThreadId?: string | null;
  originKind?: ThreadOriginKind | null;
  originPluginId?: string | null;
  visibility?: ThreadVisibility;
}

export function createThread(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateThreadInput,
) {
  const visibility = input.visibility ?? "visible";
  const now = Date.now();
  const id = createThreadId();
  const originKind = input.originKind ?? null;
  const thread = db.transaction(
    (tx) => {
      const createdThread = tx
        .insert(threads)
        .values({
          id,
          projectId: input.projectId,
          environmentId: input.environmentId ?? null,
          providerId: input.providerId,
          title: input.title ?? null,
          titleFallback: input.titleFallback ?? null,
          sectionId: input.sectionId ?? null,
          status: input.status ?? "starting",
          parentThreadId:
            originKind === null ? input.parentThreadId ?? null : null,
          sourceThreadId:
            input.sourceThreadId ??
            (originKind === null ? null : input.parentThreadId ?? null),
          originKind,
          originPluginId: input.originPluginId ?? null,
          visibility,
          lastReadAt: now,
          latestAttentionAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      upsertThreadTitleSearchSegments(tx, {
        threadId: createdThread.id,
        title: createdThread.title,
        titleFallback: createdThread.titleFallback,
        updatedAt: now,
      });
      return createdThread;
    },
    { behavior: "immediate" },
  );
  notifier.notifyThread(id, ["thread-created"], {
    projectId: input.projectId,
  });
  notifier.notifyProject(input.projectId, ["threads-changed"]);
  return thread;
}

export function getThread(db: ThreadWriteConnection, id: string) {
  return db.select().from(threads).where(eq(threads.id, id)).get() ?? null;
}

export interface ThreadMentionRow {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
}

export function listThreadMentionRowsByIds(
  db: DbQueryConnection,
  threadIds: readonly string[],
): ThreadMentionRow[] {
  if (threadIds.length === 0) {
    return [];
  }
  return db
    .select({
      id: threads.id,
      projectId: threads.projectId,
      title: threads.title,
      titleFallback: threads.titleFallback,
    })
    .from(threads)
    .innerJoin(projects, eq(projects.id, threads.projectId))
    .where(
      and(
        inArray(threads.id, [...threadIds]),
        isNull(threads.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .all();
}

export interface ListThreadsOptions {
  projectId?: string;
  archived?: boolean;
  sectionId?: string;
  unsectioned?: boolean;
  parentThreadId?: string;
  hasParent?: boolean;
  sourceThreadId?: string;
  originKind?: ThreadOriginKind;
  originPluginId?: string;
  limit?: number;
  offset?: number;
  includeHidden?: boolean;
}

type ThreadRow = typeof threads.$inferSelect;

export interface ListThreadsForProjectsOptions {
  projectIds: readonly string[];
  archived?: boolean;
}

export interface PinThreadArgs {
  pinnedAt?: number;
  threadId: string;
}

export interface UnpinThreadArgs {
  threadId: string;
}

export interface ReorderPinnedThreadArgs {
  db: DbConnection;
  nextThreadId: string | null;
  notifier: DbNotifier;
  previousThreadId: string | null;
  threadId: string;
}

interface ResolvePinnedThreadNeighborArgs {
  movedThreadId: string;
  neighborThreadId: string | null;
  pinnedThreads: readonly ThreadRow[];
}

interface PinThreadMutationResult {
  changed: boolean;
  thread: ThreadRow;
}

type PinnedThreadRootCandidate = Pick<
  ThreadRow,
  "id" | "parentThreadId"
>;

interface FilterVisiblePinnedThreadRootsArgs<
  TThread extends PinnedThreadRootCandidate,
> {
  pinnedThreads: readonly TThread[];
}

export interface ReorderPinnedThreadSuccess {
  kind: "reordered";
  threads: ThreadRow[];
}

export interface ReorderPinnedThreadUnchanged {
  kind: "unchanged";
  threads: ThreadRow[];
}

export interface ReorderPinnedThreadNotFound {
  kind: "not_found";
}

export interface ReorderPinnedThreadNotPinned {
  kind: "not_pinned";
}

export interface ReorderPinnedThreadStaleNeighbor {
  kind: "stale_neighbor";
}

export interface ReorderPinnedThreadInvalidNeighborOrder {
  kind: "invalid_neighbor_order";
}

export type ReorderPinnedThreadResult =
  | ReorderPinnedThreadSuccess
  | ReorderPinnedThreadUnchanged
  | ReorderPinnedThreadNotFound
  | ReorderPinnedThreadNotPinned
  | ReorderPinnedThreadStaleNeighbor
  | ReorderPinnedThreadInvalidNeighborOrder;

function pinnedThreadWhere() {
  return nonDeletedThreads(
    eq(threads.visibility, "visible"),
    isNotNull(threads.pinnedAt),
    isNotNull(threads.pinSortKey),
  );
}

function getFirstPinnedThread(db: DbQueryConnection): ThreadRow | null {
  return (
    db
      .select()
      .from(threads)
      .where(pinnedThreadWhere())
      .orderBy(asc(threads.pinSortKey), asc(threads.id))
      .limit(1)
      .get() ?? null
  );
}

function filterVisiblePinnedThreadRoots<
  TThread extends PinnedThreadRootCandidate,
>({
  pinnedThreads,
}: FilterVisiblePinnedThreadRootsArgs<TThread>): TThread[] {
  const pinnedThreadIds = new Set(pinnedThreads.map((thread) => thread.id));
  return pinnedThreads.filter(
    (thread) =>
      thread.parentThreadId === null ||
      !pinnedThreadIds.has(thread.parentThreadId),
  );
}

export function listActiveVisiblePinnedThreadRoots(
  db: DbQueryConnection,
): ThreadRow[] {
  const pinnedThreads = db
    .select()
    .from(threads)
    .where(liveThreads(pinnedThreadWhere()))
    .orderBy(asc(threads.pinSortKey), asc(threads.id))
    .all();

  return filterVisiblePinnedThreadRoots({ pinnedThreads });
}

function threadWithPendingInteractionBaseQuery(db: DbConnection) {
  return db
    .select({
      ...getTableColumns(threads),
      environmentBranchName: environments.branchName,
      environmentHostId: environments.hostId,
      environmentIsWorktree: environments.isWorktree,
      environmentName: environments.name,
      environmentWorkspaceProvisionType: environments.workspaceProvisionType,
      hasPendingInteraction: sql<number>`EXISTS (SELECT 1 FROM ${pendingInteractions} WHERE ${pendingInteractions.threadId} = ${threads.id} AND ${pendingInteractions.status} = 'pending')`,
    })
    .from(threads)
    .leftJoin(environments, eq(threads.environmentId, environments.id));
}

export function listActiveVisiblePinnedThreadRootsWithPendingInteractionState(
  db: DbConnection,
): ThreadWithPendingInteractionState[] {
  const pinnedThreads = threadWithPendingInteractionBaseQuery(db)
    .where(liveThreads(pinnedThreadWhere()))
    .orderBy(asc(threads.pinSortKey), asc(threads.id))
    .all()
    .map(toThreadWithPendingInteractionState);

  return filterVisiblePinnedThreadRoots({ pinnedThreads });
}

function resolvePinnedThreadNeighbor(
  args: ResolvePinnedThreadNeighborArgs,
): ThreadRow | null | false {
  if (args.neighborThreadId === null) {
    return null;
  }
  if (args.neighborThreadId === args.movedThreadId) {
    return false;
  }

  return (
    args.pinnedThreads.find((thread) => thread.id === args.neighborThreadId) ??
    false
  );
}

export interface ThreadWithPendingInteractionState extends ThreadRow {
  environmentBranchName: string | null;
  environmentHostId: string | null;
  environmentName: string | null;
  hasPendingInteraction: boolean;
  environmentWorkspaceDisplayKind: EnvironmentWorkspaceDisplayKind;
}

interface ThreadWithPendingInteractionStateRow extends ThreadRow {
  environmentBranchName: string | null;
  environmentHostId: string | null;
  environmentIsWorktree: boolean | null;
  environmentName: string | null;
  environmentWorkspaceProvisionType: WorkspaceProvisionType | null;
  hasPendingInteraction: number;
}

export interface CountLiveThreadsInEnvironmentArgs {
  environmentId: string;
  excludeThreadId?: string;
}

export interface ListLiveThreadsInEnvironmentArgs {
  environmentId: string;
}

export interface HasRevivableArchivedThreadInEnvironmentArgs {
  environmentId: string;
}

export interface CountNonDeletedAssignedChildThreadsArgs {
  parentThreadId: string;
}

export interface ListUnarchivedHiddenSourceThreadsArgs {
  sourceThreadId: string;
}

export interface ListUnarchivedAssignedChildThreadsArgs {
  parentThreadId: string;
}


export interface ListNonDeletedChildThreadsArgs {
  parentThreadId: string;
}

export interface MarkThreadDeletedArgs {
  deletedAt?: number;
  threadId: string;
}

export interface MarkThreadAttentionRequestedArgs {
  threadId: string;
}

export interface ListThreadEnvironmentAssignmentsOnHostArgs {
  hostId: string;
  threadIds: readonly string[];
}

export interface ListHostThreadIdsArgs {
  hostId: string;
}

export interface ListActiveHostThreadsArgs {
  hostId: string;
}

export interface ThreadEnvironmentAssignmentRow {
  environmentId: string;
  threadId: string;
}

export interface HasPendingThreadShutdownInEnvironmentArgs {
  environmentId: string;
}

const NON_TERMINAL_THREAD_STATUSES: readonly ThreadStatus[] = [
  "starting",
  "idle",
  "active",
];

interface StatusTransition {
  currentStatus: ThreadStatus;
  newStatus: ThreadStatus;
  parentThreadId: string | null;
}

function statusTransitionNeedsAttention(args: StatusTransition): boolean {
  if (args.currentStatus === "active" && args.newStatus === "idle") {
    return args.parentThreadId === null;
  }

  if (args.newStatus !== "error") {
    return false;
  }

  return (
    args.currentStatus === "active" || args.currentStatus === "starting"
  );
}

function buildListThreadsFilters(options: ListThreadsOptions) {
  return [
    options.projectId ? eq(threads.projectId, options.projectId) : undefined,
    options.sectionId ? eq(threads.sectionId, options.sectionId) : undefined,
    options.unsectioned ? isNull(threads.sectionId) : undefined,
    nonDeletedThreads(),
    options.includeHidden ? undefined : eq(threads.visibility, "visible"),
    options.parentThreadId
      ? eq(threads.parentThreadId, options.parentThreadId)
      : undefined,
    options.sourceThreadId
      ? eq(threads.sourceThreadId, options.sourceThreadId)
      : undefined,
    options.originKind
      ? eq(threads.originKind, options.originKind)
      : undefined,
    options.originPluginId
      ? eq(threads.originPluginId, options.originPluginId)
      : undefined,
    options.archived === true
      ? isNotNull(threads.archivedAt)
      : options.archived === false
        ? isNull(threads.archivedAt)
        : undefined,
    options.hasParent === true
      ? isNotNull(threads.parentThreadId)
      : options.hasParent === false
        ? isNull(threads.parentThreadId)
        : undefined,
  ].filter((value) => value !== undefined);
}

function buildListThreadsForProjectsFilters(
  options: ListThreadsForProjectsOptions,
) {
  return [
    inArray(threads.projectId, [...options.projectIds]),
    eq(threads.visibility, "visible"),
    nonDeletedThreads(),
    options.archived === true
      ? isNotNull(threads.archivedAt)
      : options.archived === false
        ? isNull(threads.archivedAt)
        : undefined,
  ].filter((value) => value !== undefined);
}

function buildActiveProjectThreadOrderBy() {
  return [
    asc(threads.projectId),
    ...buildPinnedThreadOrderBy(),
    desc(threads.createdAt),
    desc(threads.id),
  ];
}

function buildPinnedThreadOrderBy() {
  return [
    asc(sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN 0 ELSE 1 END`),
    asc(sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN ${threads.pinSortKey} END`),
    asc(sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN ${threads.id} END`),
  ];
}

function buildListThreadsOrderBy(options: ListThreadsOptions) {
  if (options.archived === true) {
    return [desc(threads.archivedAt), desc(threads.id)];
  }
  return buildActiveProjectThreadOrderBy();
}

function toThreadWithPendingInteractionState(
  row: ThreadWithPendingInteractionStateRow,
): ThreadWithPendingInteractionState {
  const {
    environmentIsWorktree,
    environmentWorkspaceProvisionType,
    environmentBranchName,
    environmentHostId,
    environmentName,
    hasPendingInteraction,
    ...thread
  } = row;
  return {
    ...thread,
    environmentBranchName,
    environmentHostId,
    environmentName,
    environmentWorkspaceDisplayKind: resolveEnvironmentWorkspaceDisplayKind({
      environment: {
        isWorktree: environmentIsWorktree,
        workspaceProvisionType: environmentWorkspaceProvisionType,
      },
    }),
    hasPendingInteraction: hasPendingInteraction > 0,
  };
}

function listThreadSearchQueryTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const match of query.matchAll(THREAD_SEARCH_QUERY_TOKEN_PATTERN)) {
    const token = match[0].trim();
    if (token.length > 0) {
      tokens.push(token);
    }
  }
  return tokens;
}

function buildThreadSearchTokenMatchQuery(token: string): string {
  return `"${token.replaceAll('"', '""')}"*`;
}

function listThreadSearchTokenMatchQueries(
  tokens: readonly string[],
): string[] {
  return [...new Set(tokens.map(buildThreadSearchTokenMatchQuery))];
}

function buildThreadSearchAnyTokenMatchQuery(
  tokenMatchQueries: readonly string[],
): string | null {
  if (tokenMatchQueries.length === 0) {
    return null;
  }
  return tokenMatchQueries.join(" OR ");
}

function mergeHighlightRanges(
  ranges: readonly ThreadSearchHighlightRange[],
): ThreadSearchHighlightRange[] {
  const merged: ThreadSearchHighlightRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged.slice(0, THREAD_SEARCH_HIGHLIGHT_RANGE_LIMIT);
}

function findHighlightRanges(args: {
  text: string;
  tokens: readonly string[];
}): ThreadSearchHighlightRange[] {
  const ranges: ThreadSearchHighlightRange[] = [];
  const normalizedText = normalizeThreadSearchHighlightText(args.text);
  const uniqueTokens = [
    ...new Set(
      args.tokens
        .map((token) => normalizeThreadSearchText(token))
        .filter((token) => token.length > 0),
    ),
  ];

  for (const token of uniqueTokens) {
    let offset = 0;
    while (offset < normalizedText.text.length) {
      const start = normalizedText.text.indexOf(token, offset);
      if (start === -1) {
        break;
      }
      const end = start + token.length;
      ranges.push({
        start: normalizedText.originalStarts[start] ?? 0,
        end: normalizedText.originalEnds[end - 1] ?? args.text.length,
      });
      offset = start + token.length;
    }
  }

  return mergeHighlightRanges(
    ranges.sort((left, right) => left.start - right.start || left.end - right.end),
  );
}

function normalizeThreadSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase();
}

function normalizeThreadSearchHighlightText(text: string): {
  originalEnds: number[];
  originalStarts: number[];
  text: string;
} {
  let normalizedText = "";
  const originalStarts: number[] = [];
  const originalEnds: number[] = [];

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const value = String.fromCodePoint(codePoint);
    const end = index + value.length;
    const normalizedValue = normalizeThreadSearchText(value);
    for (
      let normalizedIndex = 0;
      normalizedIndex < normalizedValue.length;
      normalizedIndex += 1
    ) {
      normalizedText += normalizedValue[normalizedIndex];
      originalStarts.push(index);
      originalEnds.push(end);
    }
    index = end;
  }

  return {
    originalEnds,
    originalStarts,
    text: normalizedText,
  };
}

function isThreadSearchTitleSourceKind(
  sourceKind: ThreadSearchSourceKind,
): boolean {
  return sourceKind === "title" || sourceKind === "title_fallback";
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

function buildThreadSearchSnippet(args: {
  text: string;
  tokens: readonly string[];
}): ThreadSearchSnippet {
  const highlightRanges = findHighlightRanges(args);
  const text = args.text;
  if (text.length <= THREAD_SEARCH_SNIPPET_MAX_CHARS) {
    return { highlightRanges, text };
  }

  const firstRange = highlightRanges[0];
  const anchorStart = firstRange?.start ?? 0;
  const anchorEnd = firstRange?.end ?? 0;
  let start = Math.min(
    Math.max(0, anchorStart - THREAD_SEARCH_SNIPPET_LEAD_CHARS),
    Math.max(0, text.length - THREAD_SEARCH_SNIPPET_MAX_CHARS),
  );
  let end = Math.min(text.length, start + THREAD_SEARCH_SNIPPET_MAX_CHARS);

  if (start > 0) {
    const boundary = text.slice(start, anchorStart).search(/\s/u);
    if (boundary !== -1) {
      start += boundary + 1;
    }
  }
  if (end < text.length) {
    const tailStart = Math.max(anchorEnd, start);
    const boundary = text.slice(tailStart, end).search(/\s\S*$/u);
    if (
      boundary > 0 &&
      end - (tailStart + boundary) <= THREAD_SEARCH_SNIPPET_LEAD_CHARS
    ) {
      end = tailStart + boundary;
    }
  }
  if (start > 0 && start < text.length && isLowSurrogate(text, start)) {
    start += 1;
  }
  if (end > start && end < text.length && isHighSurrogate(text, end - 1)) {
    end -= 1;
  }

  const prefix = start > 0 ? THREAD_SEARCH_SNIPPET_ELLIPSIS : "";
  const suffix = end < text.length ? THREAD_SEARCH_SNIPPET_ELLIPSIS : "";
  const rebasedRanges: ThreadSearchHighlightRange[] = [];
  for (const range of highlightRanges) {
    const rangeStart = Math.max(range.start, start) - start + prefix.length;
    const rangeEnd = Math.min(range.end, end) - start + prefix.length;
    if (rangeEnd > rangeStart) {
      rebasedRanges.push({ start: rangeStart, end: rangeEnd });
    }
  }

  return {
    highlightRanges: rebasedRanges,
    text: `${prefix}${text.slice(start, end)}${suffix}`,
  };
}

function listThreadSearchMatchRows(
  db: DbConnection,
  args: ListThreadSearchMatchRowsArgs,
): ThreadSearchMatchRow[] {
  const tokenMatchSelects = args.tokenMatchQueries.map(
    (matchQuery, tokenIndex) => sql`
      SELECT
        s.thread_id AS threadId,
        ${tokenIndex} AS tokenIndex,
        MIN(thread_search_segments_fts.rank) AS tokenRank
      FROM thread_search_segments_fts
      JOIN thread_search_segments AS s ON s.rowid = thread_search_segments_fts.rowid
      WHERE thread_search_segments_fts MATCH ${matchQuery}
      GROUP BY s.thread_id
    `,
  );
  const isTitleSegment = sql`thread_search_segments.source_kind IN ('title', 'title_fallback')`;

  return db.all<ThreadSearchMatchRow>(sql`
    WITH token_matches AS (
      ${sql.join(tokenMatchSelects, sql` UNION ALL `)}
    ),
    ranked_threads AS (
      SELECT
        token_matches.threadId AS threadId,
        MIN(token_matches.tokenRank) AS bestRank,
        MAX(t.updated_at) AS threadUpdatedAt,
        MAX(t.archived_at IS NOT NULL) AS archived
      FROM token_matches
      JOIN threads AS t ON t.id = token_matches.threadId
      WHERE t.deleted_at IS NULL
        AND t.visibility = 'visible'
      GROUP BY threadId
      HAVING COUNT(DISTINCT token_matches.tokenIndex) = ${args.tokenMatchQueries.length}
    ),
    ordered_threads AS (
      SELECT
        threadId,
        archived,
        ROW_NUMBER() OVER (
          PARTITION BY archived
          ORDER BY bestRank ASC, threadUpdatedAt DESC, threadId DESC
        ) AS threadOrder,
        COUNT(*) OVER (PARTITION BY archived) AS total
      FROM ranked_threads
    ),
    limited_threads AS (
      SELECT threadId, archived, threadOrder, total
      FROM ordered_threads
      WHERE threadOrder <= ${args.limitPerGroup}
    ),
    ranked_segments AS (
      SELECT
        limited_threads.archived AS archived,
        limited_threads.threadOrder AS threadOrder,
        limited_threads.total AS total,
        ROW_NUMBER() OVER (
          PARTITION BY thread_search_segments.thread_id, ${isTitleSegment}
          ORDER BY
            thread_search_segments_fts.rank ASC,
            COALESCE(thread_search_segments.source_seq, -1) ASC,
            thread_search_segments.id ASC
        ) AS segmentOrder,
        ${isTitleSegment} AS isTitle,
        thread_search_segments.source_kind AS sourceKind,
        thread_search_segments.source_seq AS sourceSeq,
        thread_search_segments.text AS text,
        thread_search_segments.thread_id AS threadId
      FROM thread_search_segments_fts
      JOIN thread_search_segments
        ON thread_search_segments.rowid = thread_search_segments_fts.rowid
      JOIN limited_threads
        ON limited_threads.threadId = thread_search_segments.thread_id
      WHERE thread_search_segments_fts MATCH ${args.anyTokenMatchQuery}
    )
    SELECT
      archived,
      threadOrder,
      total,
      segmentOrder,
      sourceKind,
      sourceSeq,
      text,
      threadId
    FROM ranked_segments
    WHERE isTitle = 1
      OR segmentOrder <= ${THREAD_SEARCH_MESSAGE_MATCHES_PER_THREAD}
    ORDER BY archived ASC, threadOrder ASC, isTitle DESC, segmentOrder ASC
  `);
}

function hydrateThreadSearchGroup(
  db: DbConnection,
  args: HydrateThreadSearchGroupArgs,
): ThreadSearchResultGroup {
  const firstRow = args.rows[0];
  if (firstRow === undefined) {
    return { total: 0, results: [] };
  }

  const threadIds: string[] = [];
  const seenThreadIds = new Set<string>();
  const matchesByThreadId = new Map<string, ThreadSearchMatch[]>();
  for (const row of args.rows) {
    if (!seenThreadIds.has(row.threadId)) {
      seenThreadIds.add(row.threadId);
      threadIds.push(row.threadId);
    }
    const matches = matchesByThreadId.get(row.threadId) ?? [];
    const sourceKind = threadSearchSourceKindSchema.parse(row.sourceKind);
    const snippet = isThreadSearchTitleSourceKind(sourceKind)
      ? {
          text: row.text,
          highlightRanges: findHighlightRanges({
            text: row.text,
            tokens: args.tokens,
          }),
        }
      : buildThreadSearchSnippet({ text: row.text, tokens: args.tokens });
    matches.push({
      sourceKind,
      text: snippet.text,
      highlightRanges: snippet.highlightRanges,
      sourceSeq: row.sourceSeq,
    });
    matchesByThreadId.set(row.threadId, matches);
  }

  const threadsById = new Map(
    threadWithPendingInteractionBaseQuery(db)
      .where(nonDeletedThreads(inArray(threads.id, threadIds)))
      .all()
      .map(toThreadWithPendingInteractionState)
      .map((thread) => [thread.id, thread]),
  );

  const results: ThreadSearchResult[] = [];
  for (const threadId of threadIds) {
    const thread = threadsById.get(threadId);
    const matches = matchesByThreadId.get(threadId);
    if (thread === undefined || matches === undefined) {
      continue;
    }
    results.push({ thread, matches });
  }

  return { total: firstRow.total, results };
}

export function searchThreadsWithPendingInteractionState(
  db: DbConnection,
  args: SearchThreadsWithPendingInteractionStateArgs,
): ThreadSearchResults {
  const tokens = listThreadSearchQueryTokens(args.query);
  const tokenMatchQueries = listThreadSearchTokenMatchQueries(tokens);
  const anyTokenMatchQuery = buildThreadSearchAnyTokenMatchQuery(tokenMatchQueries);
  if (anyTokenMatchQuery === null) {
    return {
      active: { total: 0, results: [] },
      archived: { total: 0, results: [] },
    };
  }
  const limitPerGroup = Math.min(
    Math.max(args.limitPerGroup, 1),
    THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
  );

  const rows = listThreadSearchMatchRows(db, {
    anyTokenMatchQuery,
    limitPerGroup,
    tokenMatchQueries,
  });

  return {
    active: hydrateThreadSearchGroup(db, {
      tokens,
      rows: rows.filter((row) => row.archived === 0),
    }),
    archived: hydrateThreadSearchGroup(db, {
      tokens,
      rows: rows.filter((row) => row.archived === 1),
    }),
  };
}

/** How `countThreads` buckets its result; omitted asks for the total only. */
export type CountThreadsGroupBy = "host" | "provider" | "project";

export interface CountThreadsOptions {
  status?: ThreadStatus;
  hostId?: string;
  providerId?: string;
  projectId?: string;
  /**
   * `{ kind: "root" }` counts threads with no parent, `{ kind: "id" }` counts
   * one parent's children, and omitting the option does not filter on
   * parentage. Three states, three shapes — a nullable string would have made
   * "no parent" and "no filter" the same value.
   */
  parent?: { kind: "root" } | { kind: "id"; parentThreadId: string };
  groupBy?: CountThreadsGroupBy;
  /** Archived rows are excluded unless this is true; deleted rows always are. */
  includeArchived?: boolean;
  /** Hidden rows are excluded unless this is true. */
  includeHidden?: boolean;
}

export interface ThreadCountGroupRow {
  /** The host/provider/project id, or null for threads that have none. */
  key: string | null;
  count: number;
}

export interface CountThreadsResult {
  total: number;
  /** Present exactly when `groupBy` was asked for. */
  groups?: ThreadCountGroupRow[];
}

/**
 * `SELECT count(*)` over threads, optionally grouped. Backs `bb thread count`,
 * which answers "how many" in the database instead of paging threads into
 * memory to count them. The host filter and the `host` grouping both need the
 * environment row, so they join it; every other shape reads `threads` alone.
 * (Limiters do not use this: reconciling several pools needs the rows, which
 * is `listRunningThreads`' job.)
 */
export function countThreads(
  db: DbQueryConnection,
  options: CountThreadsOptions,
): CountThreadsResult {
  const needsEnvironmentJoin =
    options.hostId !== undefined || options.groupBy === "host";
  const filters = [
    nonDeletedThreads(),
    options.includeArchived === true ? undefined : isNull(threads.archivedAt),
    options.includeHidden === true
      ? undefined
      : eq(threads.visibility, "visible"),
    options.status !== undefined ? eq(threads.status, options.status) : undefined,
    options.providerId !== undefined
      ? eq(threads.providerId, options.providerId)
      : undefined,
    options.projectId !== undefined
      ? eq(threads.projectId, options.projectId)
      : undefined,
    options.parent === undefined
      ? undefined
      : options.parent.kind === "root"
        ? isNull(threads.parentThreadId)
        : eq(threads.parentThreadId, options.parent.parentThreadId),
    options.hostId !== undefined
      ? eq(environments.hostId, options.hostId)
      : undefined,
  ].filter((value) => value !== undefined);

  const groupColumn =
    options.groupBy === "host"
      ? environments.hostId
      : options.groupBy === "provider"
        ? threads.providerId
        : options.groupBy === "project"
          ? threads.projectId
          : null;

  if (groupColumn === null) {
    const base = db.select({ value: count() }).from(threads).$dynamic();
    const joined = needsEnvironmentJoin
      ? base.leftJoin(environments, eq(environments.id, threads.environmentId))
      : base;
    return { total: joined.where(and(...filters)).get()?.value ?? 0 };
  }

  const base = db
    .select({ key: groupColumn, value: count() })
    .from(threads)
    .$dynamic();
  const joined = needsEnvironmentJoin
    ? base.leftJoin(environments, eq(environments.id, threads.environmentId))
    : base;
  const rows = joined
    .where(and(...filters))
    .groupBy(groupColumn)
    .all();
  const groups = rows.map((row) => ({
    key: row.key ?? null,
    count: row.value,
  }));
  return {
    total: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
  };
}

/**
 * The statuses that occupy capacity. A `starting` thread is provisioning or
 * cold-starting and a `active` one is executing a turn; both hold a real slot
 * on a real machine. `idle` deliberately does not — an idle thread has a
 * session but is consuming nothing — and `pending`, `stopping` and `error` are
 * not running work either.
 */
const OCCUPYING_THREAD_STATUSES: readonly ThreadStatus[] = [
  "starting",
  "active",
];

/**
 * One thread currently occupying capacity: its id, and the machine that id is
 * occupying.
 */
export interface RunningThreadRow {
  id: string;
  /** The machine it runs on, or null while no environment has been chosen. */
  hostId: string | null;
}

/**
 * Every thread currently occupying capacity.
 *
 * `countThreads` answers "how many", which holds one pool but cannot say which
 * threads make it up — so a limiter over several pools (all hosts, one host)
 * had to issue a count per pool and could not reconcile them. The rows answer
 * every such question at once, and the set is bounded by what is actually
 * running: a handful of rows, not a page of threads.
 *
 * The row is deliberately just `{ id, hostId }`. `hostId` is here because a
 * per-host pool cannot be derived from an id without a query per row; anything
 * else a caller needs it fetches by id, which keeps this from accreting a
 * projection of the threads table.
 *
 * Archived and deleted rows are excluded because neither runs: archival stops
 * a thread, and a soft-deleted row is gone. Hidden threads are NOT excluded —
 * visibility is a UI fact and a hidden thread burns a slot like any other, so
 * hiding it here would under-report real occupancy.
 *
 * `threads_archived_status_idx` (archived_at, status) serves this directly:
 * `archived_at IS NULL` is the leading equality and the status set is the
 * range that follows.
 */
export function listRunningThreads(
  db: DbQueryConnection,
): RunningThreadRow[] {
  return db
    .select({
      id: threads.id,
      hostId: environments.hostId,
    })
    .from(threads)
    .leftJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        liveThreads(),
        inArray(threads.status, [...OCCUPYING_THREAD_STATUSES]),
      ),
    )
    .orderBy(asc(threads.id))
    .all()
    .map((row) => ({ ...row, hostId: row.hostId ?? null }));
}

export function listThreads(db: DbConnection, options: ListThreadsOptions) {
  let query = db
    .select()
    .from(threads)
    .where(and(...buildListThreadsFilters(options)))
    .orderBy(...buildListThreadsOrderBy(options))
    .$dynamic();
  if (options.limit !== undefined) {
    query = query.limit(options.limit);
  }
  if (options.offset !== undefined) {
    query = query.offset(options.offset);
  }
  return query.all();
}

export function listThreadsWithPendingInteractionState(
  db: DbConnection,
  options: ListThreadsOptions,
): ThreadWithPendingInteractionState[] {
  let query = threadWithPendingInteractionBaseQuery(db)
    .where(and(...buildListThreadsFilters(options)))
    .orderBy(...buildListThreadsOrderBy(options))
    .$dynamic();
  if (options.limit !== undefined) {
    query = query.limit(options.limit);
  }
  if (options.offset !== undefined) {
    query = query.offset(options.offset);
  }
  const rows = query.all();

  return rows.map(toThreadWithPendingInteractionState);
}

export function hasActiveThreadAttention(db: DbConnection): boolean {
  const unreadThread = or(
    isNull(threads.lastReadAt),
    lt(threads.lastReadAt, threads.latestAttentionAt),
  );

  const row = db
    .select({ id: threads.id })
    .from(threads)
    .leftJoin(
      pendingInteractions,
      and(
        eq(pendingInteractions.threadId, threads.id),
        eq(pendingInteractions.status, "pending"),
      ),
    )
    .where(
      liveThreads(
        eq(threads.visibility, "visible"),
        or(unreadThread, isNotNull(pendingInteractions.id)),
      ),
    )
    .limit(1)
    .get();

  return row !== undefined;
}

export function listThreadsWithPendingInteractionStateForProjects(
  db: DbConnection,
  options: ListThreadsForProjectsOptions,
): ThreadWithPendingInteractionState[] {
  if (options.projectIds.length === 0) {
    return [];
  }

  const rows = threadWithPendingInteractionBaseQuery(db)
    .where(and(...buildListThreadsForProjectsFilters(options)))
    .orderBy(...buildListThreadsOrderBy(options))
    .all();

  return rows.map(toThreadWithPendingInteractionState);
}

export function countLiveThreadsInEnvironment(
  db: ThreadWriteConnection,
  args: CountLiveThreadsInEnvironmentArgs,
): number {
  return countThreadsWhere(
    db,
    liveThreads(
      eq(threads.environmentId, args.environmentId),
      args.excludeThreadId ? ne(threads.id, args.excludeThreadId) : undefined,
    ),
  );
}

export function hasRevivableArchivedThreadInEnvironment(
  db: ThreadWriteConnection,
  args: HasRevivableArchivedThreadInEnvironmentArgs,
): boolean {
  return hasThreadWhere(
    db,
    nonDeletedThreads(
      eq(threads.environmentId, args.environmentId),
      isNotNull(threads.archivedAt),
    ),
  );
}

export function listLiveThreadsInEnvironment(
  db: ThreadWriteConnection,
  args: ListLiveThreadsInEnvironmentArgs,
): ThreadRow[] {
  return db
    .select()
    .from(threads)
    .where(liveThreads(eq(threads.environmentId, args.environmentId)))
    .orderBy(desc(threads.createdAt))
    .all();
}

export function countNonDeletedAssignedChildThreads(
  db: DbConnection,
  args: CountNonDeletedAssignedChildThreadsArgs,
): number {
  return countThreadsWhere(
    db,
    nonDeletedThreads(eq(threads.parentThreadId, args.parentThreadId)),
  );
}

export function listUnarchivedAssignedChildThreads(
  db: ThreadWriteConnection,
  args: ListUnarchivedAssignedChildThreadsArgs,
): ThreadRow[] {
  return listThreadsWhere(
    db,
    liveThreads(eq(threads.parentThreadId, args.parentThreadId)),
  );
}


export function listUnarchivedHiddenSourceThreads(
  db: ThreadWriteConnection,
  args: ListUnarchivedHiddenSourceThreadsArgs,
): ThreadRow[] {
  return listThreadsWhere(
    db,
    liveThreads(
      eq(threads.sourceThreadId, args.sourceThreadId),
      eq(threads.visibility, "hidden"),
    ),
  );
}

export function listNonDeletedChildThreads(
  db: ThreadWriteConnection,
  args: ListNonDeletedChildThreadsArgs,
): ThreadRow[] {
  return listThreadsWhere(
    db,
    nonDeletedThreads(eq(threads.parentThreadId, args.parentThreadId)),
  );
}

export function listThreadEnvironmentAssignmentsOnHost(
  db: DbConnection,
  args: ListThreadEnvironmentAssignmentsOnHostArgs,
): ThreadEnvironmentAssignmentRow[] {
  if (args.threadIds.length === 0) {
    return [];
  }

  return db
    .select({
      threadId: threads.id,
      environmentId: environments.id,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        inArray(threads.id, [...args.threadIds]),
        eq(environments.hostId, args.hostId),
      ),
    )
    .all();
}

export interface HasLiveThreadAtHostPathArgs {
  hostId: string;
  path: string;
}

export function hasLiveThreadAtHostPath(
  db: DbConnection,
  args: HasLiveThreadAtHostPathArgs,
): boolean {
  const row = db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, args.hostId),
        eq(environments.path, args.path),
        liveThreads(
          inArray(threads.status, [...NON_TERMINAL_THREAD_STATUSES]),
        ),
      ),
    )
    .get();

  return row !== undefined;
}

export function listHostThreadIds(
  db: DbConnection,
  args: ListHostThreadIdsArgs,
): string[] {
  return db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(eq(environments.hostId, args.hostId))
    .all()
    .map((row) => row.id);
}

export function listActiveHostThreads(
  db: DbConnection,
  args: ListActiveHostThreadsArgs,
): ThreadRow[] {
  return db
    .select(getTableColumns(threads))
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      nonDeletedThreads(
        eq(environments.hostId, args.hostId),
        eq(threads.status, "active"),
      ),
    )
    .all();
}

export function hasPendingThreadShutdownInEnvironment(
  db: DbConnection,
  args: HasPendingThreadShutdownInEnvironmentArgs,
): boolean {
  const row = db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, args.environmentId),
        eq(threads.status, "stopping"),
      ),
    )
    .get();

  return row !== undefined;
}

export function pinThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  args: PinThreadArgs,
) {
  const result = db.transaction(
    (tx): PinThreadMutationResult | null => {
      const existing =
        tx.select().from(threads).where(eq(threads.id, args.threadId)).get() ??
        null;
      if (!existing || existing.deletedAt !== null) {
        return null;
      }
      if (existing.pinnedAt !== null && existing.pinSortKey !== null) {
        return { changed: false, thread: existing };
      }

      const firstPinnedThread = getFirstPinnedThread(tx);
      const pinSortKey = createOrderKeyBetween({
        previousKey: null,
        nextKey: firstPinnedThread?.pinSortKey ?? null,
      });
      const now = Date.now();
      const updated = tx
        .update(threads)
        .set({
          pinnedAt: args.pinnedAt ?? now,
          pinSortKey,
          updatedAt: now,
        })
        .where(nonDeletedThreads(eq(threads.id, args.threadId)))
        .returning()
        .get();
      return updated ? { changed: true, thread: updated } : null;
    },
    { behavior: "immediate" },
  );

  if (result?.changed) {
    notifier.notifyThread(args.threadId, ["pin-state-changed"], {
      projectId: result.thread.projectId,
    });
  }
  return result?.thread ?? null;
}

export function unpinThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  args: UnpinThreadArgs,
) {
  const result = db.transaction(
    (tx): PinThreadMutationResult | null => {
      const existing =
        tx.select().from(threads).where(eq(threads.id, args.threadId)).get() ??
        null;
      if (!existing || existing.deletedAt !== null) {
        return null;
      }
      if (existing.pinnedAt === null && existing.pinSortKey === null) {
        return { changed: false, thread: existing };
      }

      const updated = tx
        .update(threads)
        .set({
          pinnedAt: null,
          pinSortKey: null,
          updatedAt: Date.now(),
        })
        .where(nonDeletedThreads(eq(threads.id, args.threadId)))
        .returning()
        .get();
      return updated ? { changed: true, thread: updated } : null;
    },
    { behavior: "immediate" },
  );

  if (result?.changed) {
    notifier.notifyThread(args.threadId, ["pin-state-changed"], {
      projectId: result.thread.projectId,
    });
  }
  return result?.thread ?? null;
}

export function reorderPinnedThread({
  db,
  nextThreadId,
  notifier,
  previousThreadId,
  threadId,
}: ReorderPinnedThreadArgs): ReorderPinnedThreadResult {
  const result = db.transaction(
    (tx): ReorderPinnedThreadResult => {
      const movedThread =
        tx.select().from(threads).where(eq(threads.id, threadId)).get() ?? null;
      if (!movedThread || movedThread.deletedAt !== null) {
        return { kind: "not_found" };
      }
      if (movedThread.pinnedAt === null || movedThread.pinSortKey === null) {
        return { kind: "not_pinned" };
      }

      const currentThreads = listActiveVisiblePinnedThreadRoots(tx);
      const currentIndex = currentThreads.findIndex(
        (thread) => thread.id === threadId,
      );
      if (currentIndex === -1) {
        return { kind: "stale_neighbor" };
      }
      const previousThread = resolvePinnedThreadNeighbor({
        movedThreadId: threadId,
        neighborThreadId: previousThreadId,
        pinnedThreads: currentThreads,
      });
      const nextThread = resolvePinnedThreadNeighbor({
        movedThreadId: threadId,
        neighborThreadId: nextThreadId,
        pinnedThreads: currentThreads,
      });
      if (previousThread === false || nextThread === false) {
        return { kind: "stale_neighbor" };
      }
      if (
        previousThread?.pinSortKey === null ||
        nextThread?.pinSortKey === null
      ) {
        return { kind: "stale_neighbor" };
      }
      if (
        previousThread !== null &&
        nextThread !== null &&
        previousThread.pinSortKey >= nextThread.pinSortKey
      ) {
        return { kind: "invalid_neighbor_order" };
      }

      const currentPreviousThreadId =
        currentThreads[currentIndex - 1]?.id ?? null;
      const currentNextThreadId = currentThreads[currentIndex + 1]?.id ?? null;
      if (
        currentPreviousThreadId === previousThreadId &&
        currentNextThreadId === nextThreadId
      ) {
        return {
          kind: "unchanged",
          threads: currentThreads,
        };
      }

      const pinSortKey = createOrderKeyBetween({
        previousKey: previousThread?.pinSortKey ?? null,
        nextKey: nextThread?.pinSortKey ?? null,
      });
      const updated = tx
        .update(threads)
        .set({ pinSortKey, updatedAt: Date.now() })
        .where(and(eq(threads.id, threadId), pinnedThreadWhere()))
        .returning({ id: threads.id })
        .get();
      if (!updated) {
        return { kind: "stale_neighbor" };
      }

      return {
        kind: "reordered",
        threads: listActiveVisiblePinnedThreadRoots(tx),
      };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "reordered") {
    const reorderedThread = result.threads.find(
      (thread) => thread.id === threadId,
    );
    if (reorderedThread) {
      notifier.notifyThread(threadId, ["pin-state-changed"], {
        projectId: reorderedThread.projectId,
      });
    }
  }
  return result;
}

export interface UpdateThreadInput {
  environmentId?: string | null;
  sectionId?: string | null;
  lastReadAt?: number | null;
  parentThreadId?: string | null;
  title?: string | null;
  visibility?: ThreadVisibility;
}

export function updateThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateThreadInput,
) {
  const now = Date.now();
  const existing = db.select().from(threads).where(eq(threads.id, id)).get();
  if (!existing) {
    return null;
  }
  const changes: ThreadChangeKind[] = [];
  if ("title" in input || "sectionId" in input) changes.push("title-changed");
  if ("lastReadAt" in input) changes.push("read-state-changed");
  if (
    "visibility" in input &&
    input.visibility !== existing.visibility
  ) {
    changes.push("title-changed");
  }
  if (
    "parentThreadId" in input &&
    input.parentThreadId !== existing.parentThreadId
  ) {
    changes.push("parent-changed");
  }
  if (
    "environmentId" in input &&
    input.environmentId !== existing.environmentId
  ) {
    changes.push("environment-changed");
  }

  const set: Partial<typeof threads.$inferInsert> = { updatedAt: now };
  if ("title" in input) set.title = input.title;
  if ("sectionId" in input) {
    set.sectionId = input.sectionId;
  }
  if ("environmentId" in input) set.environmentId = input.environmentId;
  if ("lastReadAt" in input) {
    set.lastReadAt = input.lastReadAt;
  }
  if ("parentThreadId" in input) set.parentThreadId = input.parentThreadId;
  if ("visibility" in input) set.visibility = input.visibility;

  const updated = db
    .update(threads)
    .set(set)
    .where(eq(threads.id, id))
    .returning()
    .get();
  if (updated && "title" in input) {
    upsertThreadTitleSearchSegments(db, {
      threadId: updated.id,
      title: updated.title,
      titleFallback: updated.titleFallback,
      updatedAt: now,
    });
  }
  if (updated && changes.length > 0) {
    notifier.notifyThread(id, changes, {
      projectId: existing.projectId,
    });
  }
  return updated ?? null;
}

export interface ThreadExecutionOverride {
  modelOverride: string | null;
  reasoningLevelOverride: ReasoningLevel | null;
}

export function getThreadExecutionOverride(
  db: ThreadWriteConnection,
  id: string,
): ThreadExecutionOverride | null {
  const row = db
    .select({
      modelOverride: threads.modelOverride,
      reasoningLevelOverride: threads.reasoningLevelOverride,
    })
    .from(threads)
    .where(eq(threads.id, id))
    .get();
  return row ?? null;
}

export interface SetThreadExecutionOverrideInput {
  threadId: string;
  modelOverride?: string | null;
  reasoningLevelOverride?: ReasoningLevel | null;
}

export function setThreadExecutionOverride(
  db: ThreadWriteConnection,
  input: SetThreadExecutionOverrideInput,
) {
  const set: Partial<typeof threads.$inferInsert> = { updatedAt: Date.now() };
  if ("modelOverride" in input) {
    set.modelOverride = input.modelOverride;
  }
  if ("reasoningLevelOverride" in input) {
    set.reasoningLevelOverride = input.reasoningLevelOverride;
  }
  const updated = db
    .update(threads)
    .set(set)
    .where(eq(threads.id, input.threadId))
    .returning()
    .get();
  return updated ?? null;
}

export interface SetThreadPendingStartContextInput {
  threadId: string;
  /** JSON-encoded context, or null to clear it as the thread leaves `pending`. */
  pendingStartContext: string | null;
}

/**
 * Records (or clears) how a `pending` thread will be established.
 *
 * Deliberately not folded into the lifecycle transition that leaves `pending`:
 * creation writes the context unconditionally BEFORE the first dispatch
 * attempt — an attempt that queues is not a transition at all — and clearing
 * it is a separate fact from the status change: a thread that fails to start
 * still wants its status moved without losing the context a later attempt
 * would start from.
 */
export function setThreadPendingStartContext(
  db: ThreadWriteConnection,
  input: SetThreadPendingStartContextInput,
) {
  return (
    db
      .update(threads)
      .set({
        pendingStartContext: input.pendingStartContext,
        updatedAt: Date.now(),
      })
      .where(eq(threads.id, input.threadId))
      .returning()
      .get() ?? null
  );
}

/** The stored JSON; null once the thread was admitted, or never was pending. */
export function getThreadPendingStartContext(
  db: DbQueryConnection,
  threadId: string,
): string | null {
  return (
    db
      .select({ pendingStartContext: threads.pendingStartContext })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get()?.pendingStartContext ?? null
  );
}

export function markThreadAttentionRequested(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  args: MarkThreadAttentionRequestedArgs,
) {
  const existing = db
    .select()
    .from(threads)
    .where(eq(threads.id, args.threadId))
    .get();
  if (!existing) {
    return null;
  }

  const now = Date.now();
  if (now <= existing.latestAttentionAt) {
    return existing;
  }

  const updated = db
    .update(threads)
    .set({
      latestAttentionAt: now,
      updatedAt: now,
    })
    .where(eq(threads.id, args.threadId))
    .returning()
    .get();
  if (updated) {
    notifier.notifyThread(args.threadId, ["read-state-changed"], {
      projectId: existing.projectId,
    });
  }
  return updated ?? null;
}

export function deleteThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  id: string,
) {
  const existing = db.select().from(threads).where(eq(threads.id, id)).get();
  if (!existing) return false;
  db.delete(threads).where(eq(threads.id, id)).run();
  notifier.notifyThread(id, ["thread-deleted"], {
    projectId: existing.projectId,
  });
  notifier.notifyProject(existing.projectId, ["threads-changed"]);
  return true;
}

export function markThreadDeleted(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  args: MarkThreadDeletedArgs,
) {
  const updated = db
    .update(threads)
    .set({
      deletedAt: args.deletedAt ?? Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(threads.id, args.threadId))
    .returning()
    .get();

  if (updated) {
    notifier.notifyThread(args.threadId, ["thread-deleted"], {
      projectId: updated.projectId,
    });
    notifier.notifyProject(updated.projectId, ["threads-changed"]);
  }

  return updated ?? null;
}

export function archiveThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  id: string,
) {
  const now = Date.now();
  const updated = db
    .update(threads)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(threads.id, id))
    .returning()
    .get();
  if (updated) {
    notifier.notifyThread(id, ["archived-changed"], {
      projectId: updated.projectId,
    });
  }
  return updated ?? null;
}

export function unarchiveThread(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const now = Date.now();
  const updated = db
    .update(threads)
    .set({ archivedAt: null, updatedAt: now })
    .where(eq(threads.id, id))
    .returning()
    .get();
  if (updated) {
    notifier.notifyThread(id, ["archived-changed"], {
      projectId: updated.projectId,
    });
  }
  return updated ?? null;
}

export type ApplyThreadLifecycleEventNoopReason =
  | ThreadLifecycleNoopReason
  | "not-found"
  | "cas-conflict";

export type ApplyThreadLifecycleEventOutcome =
  | { applied: true; thread: ThreadRow }
  | {
      applied: false;
      detail: string;
      reason: ApplyThreadLifecycleEventNoopReason;
    };

export interface ApplyThreadLifecycleEventArgs {
  event: ThreadLifecycleEvent;
  threadId: string;
}

interface ThreadLifecycleEventNotAppliedErrorArgs {
  detail: string;
  reason: ApplyThreadLifecycleEventNoopReason;
}

export class ThreadLifecycleEventNotAppliedError extends Error {
  readonly detail: string;
  readonly reason: ApplyThreadLifecycleEventNoopReason;

  constructor(args: ThreadLifecycleEventNotAppliedErrorArgs) {
    super(`Thread lifecycle event not applied (${args.reason}): ${args.detail}`);
    this.name = "ThreadLifecycleEventNotAppliedError";
    this.detail = args.detail;
    this.reason = args.reason;
  }
}

export function requireThreadLifecycleEventApplied(
  outcome: ApplyThreadLifecycleEventOutcome,
) {
  if (!outcome.applied) {
    throw new ThreadLifecycleEventNotAppliedError(outcome);
  }
  return outcome.thread;
}

export function applyThreadLifecycleEventInTransaction(
  db: DbTransaction,
  args: ApplyThreadLifecycleEventArgs,
): ApplyThreadLifecycleEventOutcome {
  const thread = db
    .select()
    .from(threads)
    .where(eq(threads.id, args.threadId))
    .get();
  if (!thread) {
    return {
      applied: false,
      detail: `thread not found: ${args.threadId}`,
      reason: "not-found",
    };
  }

  const evaluation = evaluateThreadLifecycleEvent({
    event: args.event,
    thread,
  });
  if ("noop" in evaluation) {
    return {
      applied: false,
      detail: evaluation.detail,
      reason: evaluation.noop,
    };
  }

  const now = Date.now();
  const set: Partial<typeof threads.$inferInsert> = {
    status: evaluation.to,
    updatedAt: now,
  };
  if (
    statusTransitionNeedsAttention({
      currentStatus: thread.status,
      newStatus: evaluation.to,
      parentThreadId: thread.parentThreadId,
    })
  ) {
    set.latestAttentionAt = now;
  }

  const updated = db
    .update(threads)
    .set(set)
    .where(
      and(eq(threads.id, args.threadId), eq(threads.status, thread.status)),
    )
    .returning()
    .get();
  if (!updated) {
    return {
      applied: false,
      detail: `status changed from ${thread.status} while applying ${args.event.type}`,
      reason: "cas-conflict",
    };
  }
  return { applied: true, thread: updated };
}

export function applyThreadLifecycleEvent(
  db: DbConnection,
  args: ApplyThreadLifecycleEventArgs,
): ApplyThreadLifecycleEventOutcome {
  return db.transaction(
    (tx) => applyThreadLifecycleEventInTransaction(tx, args),
    { behavior: "immediate" },
  );
}
