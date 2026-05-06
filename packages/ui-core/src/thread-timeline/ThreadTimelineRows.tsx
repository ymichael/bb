import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { TimelineRow, TimelineTurnRow } from "@bb/server-contract";
import {
  assertNever,
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  buildTimelineViewRows,
  createTimelineViewRowsCache,
  findActiveLatestBundleId,
  findTimelineFrontierRow,
  hasTimelineExplorationIntent,
  type BuildTimelineRowTitleOptions,
  type BuildTimelineViewRowsOptions,
  type ThreadTimelineViewRow,
  type TimelineActivityIntentTitle,
  type TimelineTitle,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
} from "@bb/thread-view";
import { cn } from "../primitives/cn.js";
import { isRunningThreadRuntimeDisplayStatus } from "../thread-runtime-status.js";
import type {
  ThreadTimelineLocalFileLinkHandler,
  ThreadTimelineTheme,
  UserAttachmentImageSrcResolver,
} from "./types.js";
import { ConversationMessageContent } from "./ConversationMessageContent.js";
import { ExpandableTimelineRow } from "./ExpandableTimelineRow.js";
import {
  TimelineStaticRowHeader,
  type TimelineRowHorizontalPadding,
} from "./TimelineRowHeader.js";
import {
  TimelineTitleView,
  type TimelineTitleActionResolver,
} from "./TimelineTitleView.js";
import { WorkRowBody } from "./TimelineRowDetails.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import { Button } from "../primitives/ui/button.js";
import {
  joinSignatureParts,
  timelineRowRenderSignature,
  timelineRowsSignature,
} from "./timelineRowSignatures.js";

export interface ThreadTimelineRowsProps {
  /**
   * Starts every expandable row open for story/test visual audit surfaces.
   * Product timeline views should rely on runtime-driven auto expansion.
   */
  defaultExpandAllRows?: boolean;
  erroredTurnSummaryIds: ReadonlySet<string>;
  loadingTurnSummaryIds: ReadonlySet<string>;
  onLoadTurnSummaryRows: (entry: TimelineTurnRow) => void;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onTitleAction?: TimelineTitleActionResolver;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  themeType?: ThreadTimelineTheme;
  timelineRows: TimelineRow[];
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
  turnSummaryRowsIdentity: string;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
}

interface TimelineRendererContextValue {
  autoExpandedRowIds: ReadonlySet<string>;
  getViewRows: GetTimelineViewRows;
  loadingTurnSummaryIds: ReadonlySet<string>;
  erroredTurnSummaryIds: ReadonlySet<string>;
  onLoadTurnSummaryRows: (entry: TimelineTurnRow) => void;
  onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler | undefined;
  onTitleAction: TimelineTitleActionResolver | undefined;
  projectId: string | undefined;
  resolveUserAttachmentImageSrc: UserAttachmentImageSrcResolver | undefined;
  themeType: ThreadTimelineTheme;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
}

interface TimelineRowsListProps {
  compactActivityIntents: boolean;
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
  spacing: TimelineRowsListSpacing;
}


interface TimelineRowWrapperClassNameArgs {
  row: ThreadTimelineViewRow;
  spacing: TimelineRowsListSpacing;
}

interface TimelineRowViewProps {
  activeLatestBundleId: string | null;
  compactActivityIntents: boolean;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
  spacing: TimelineRowsListSpacing;
}

interface TimelineExpandableRowViewProps {
  compactActivityIntents: boolean;
  title: TimelineTitle;
  horizontalPadding: TimelineRowHorizontalPadding;
  row: Exclude<ThreadTimelineViewRow, { kind: "conversation" }>;
}

interface TimelineStaticRowProps {
  children: ReactNode;
  className?: string;
  horizontalPadding?: TimelineRowHorizontalPadding;
}

interface TimelineExpandableBodyProps {
  compactActivityIntents: boolean;
  row: ThreadTimelineViewRow;
}

interface TimelineSystemDetailBlockProps {
  detail: string;
  streaming: boolean;
  tone: "default" | "danger";
}

interface RequestLazyTurnRowsArgs {
  onLoadTurnSummaryRows: (entry: TimelineTurnRow) => void;
  row: TimelineViewTurnRow;
}

interface CollectTimelineAutoExpandedRowIdsArgs {
  defaultExpandAllRows: boolean;
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
}

interface ActiveSummaryTreatmentArgs {
  activeLatestBundleId: string | null;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
}

interface TimelineRowTitleRenderStateArgs extends ActiveSummaryTreatmentArgs {
  compactActivityIntents: boolean;
  spacing: TimelineRowsListSpacing;
}

interface TimelineRowTitleOptionsArgs extends ActiveSummaryTreatmentArgs {}

interface TimelineRowTitleRenderStateCache {
  key: string;
  state: TimelineRowTitleRenderState;
}

type TimelineConversationViewRow = Extract<
  ThreadTimelineViewRow,
  { kind: "conversation" }
>;

type TimelineRowTitleRenderState =
  | {
      kind: "compact-activity-intents";
      titles: readonly TimelineActivityIntentTitle[];
    }
  | {
      kind: "row-title";
      title: TimelineTitle;
    };

type TimelineRowsListSpacing = "top-level" | "nested" | "bundle";
type TimelineRawRows = readonly TimelineRow[];
type GetTimelineViewRows = (
  rows: TimelineRawRows,
  options?: BuildTimelineViewRowsOptions,
) => ThreadTimelineViewRow[];

interface ConversationRowProps {
  row: TimelineConversationViewRow;
}

interface TurnRowBodyProps {
  compactActivityIntents: boolean;
  row: TimelineViewTurnRow;
}

const TimelineRendererContext =
  createContext<TimelineRendererContextValue | null>(null);

function useTimelineRendererContext(): TimelineRendererContextValue {
  const context = useContext(TimelineRendererContext);
  if (!context) {
    throw new Error("Thread timeline renderer context is missing");
  }
  return context;
}

function timelineRowTitleRenderStateKey({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  scopeActive,
}: TimelineRowTitleRenderStateArgs): string {
  return joinSignatureParts([
    timelineRowRenderSignature(row),
    compactActivityIntents,
    scopeActive,
    activeLatestBundleId === row.id,
  ]);
}

function buildTimelineRowTitleRenderState({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  scopeActive,
  spacing,
}: TimelineRowTitleRenderStateArgs): TimelineRowTitleRenderState {
  if (compactActivityIntents && shouldRenderCompactActivityIntentRows(row)) {
    const titles = buildTimelineActivityIntentTitles(row);
    if (titles.length > 0) {
      return {
        kind: "compact-activity-intents",
        titles,
      };
    }
  }

  const title = buildTimelineRowTitle(
    row,
    timelineRowTitleOptions({
      activeLatestBundleId,
      row,
      scopeActive,
    }),
  );
  return {
    kind: "row-title",
    title,
  };
}

function useTimelineRowTitleRenderState(
  args: TimelineRowTitleRenderStateArgs,
): TimelineRowTitleRenderState {
  const cacheRef = useRef<TimelineRowTitleRenderStateCache | null>(null);
  const key = timelineRowTitleRenderStateKey(args);
  const cached = cacheRef.current;
  if (cached?.key === key) {
    return cached.state;
  }

  const state = buildTimelineRowTitleRenderState(args);
  cacheRef.current = {
    key,
    state,
  };
  return state;
}

function areTimelineRowViewPropsEqual(
  previous: TimelineRowViewProps,
  next: TimelineRowViewProps,
): boolean {
  return (
    previous.compactActivityIntents === next.compactActivityIntents &&
    previous.scopeActive === next.scopeActive &&
    previous.spacing === next.spacing &&
    previous.activeLatestBundleId === next.activeLatestBundleId &&
    // The view-row cache keys by the raw rows array, so unchanged query data
    // preserves row object identity and can skip recursive signature work.
    (previous.row === next.row ||
      timelineRowRenderSignature(previous.row) ===
        timelineRowRenderSignature(next.row))
  );
}

function areTimelineExpandableRowViewPropsEqual(
  previous: TimelineExpandableRowViewProps,
  next: TimelineExpandableRowViewProps,
): boolean {
  return (
    previous.compactActivityIntents === next.compactActivityIntents &&
    previous.title === next.title &&
    previous.horizontalPadding === next.horizontalPadding &&
    // The view-row cache keys by the raw rows array, so unchanged query data
    // preserves row object identity and can skip recursive signature work.
    (previous.row === next.row ||
      timelineRowRenderSignature(previous.row) ===
        timelineRowRenderSignature(next.row))
  );
}

function areReadonlySetsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function useStableReadonlySet(values: ReadonlySet<string>): ReadonlySet<string> {
  const valuesRef = useRef(values);
  if (!areReadonlySetsEqual(valuesRef.current, values)) {
    valuesRef.current = values;
  }
  return valuesRef.current;
}

function toLazyTurnRequest(row: TimelineViewTurnRow): TimelineTurnRow {
  return {
    id: row.id,
    threadId: row.threadId,
    turnId: row.turnId,
    sourceSeqStart: row.sourceSeqStart,
    sourceSeqEnd: row.sourceSeqEnd,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
    kind: "turn",
    status: row.status,
    summaryCount: row.summaryCount,
    completedAt: row.completedAt,
    children: null,
  };
}

function requestLazyTurnRows({
  onLoadTurnSummaryRows,
  row,
}: RequestLazyTurnRowsArgs): void {
  onLoadTurnSummaryRows(toLazyTurnRequest(row));
}

function useTimelineViewRowsCache(): GetTimelineViewRows {
  // Each `rawRows` reference is consumed under exactly one scope: the
  // top-level prop ("open" — pending work may still arrive) or a lazily
  // loaded turn-detail array ("closed" — the turn is complete and won't
  // grow). Caching by identity is correct because the per-array scope is
  // stable; passing a different `closedScope` for the same `rawRows`
  // reference would be a bug. The cache also covers nested recursion —
  // delegation `childRows` and lazy turn `children` — so a streaming update
  // that replaces the top-level rows array doesn't reproject every untouched
  // delegation subtree.
  const cacheRef = useRef(createTimelineViewRowsCache());
  return useCallback<GetTimelineViewRows>(
    (rawRows, options) =>
      buildTimelineViewRows(rawRows, { ...options, cache: cacheRef.current }),
    [],
  );
}

function isWorkRowExpandable(row: TimelineViewWorkRow): boolean {
  switch (row.workKind) {
    case "web-search":
    case "web-fetch":
    case "approval":
      return false;
    case "command":
    case "tool":
      return !hasTimelineExplorationIntent(row);
    case "file-change":
      return true;
    case "delegation":
      return row.childRows.length > 0 || row.output.trim().length > 0;
    default:
      return assertNever(row);
  }
}

function isRowExpandable(row: ThreadTimelineViewRow): boolean {
  switch (row.kind) {
    case "conversation":
      return false;
    case "system":
      return row.detail !== null && row.detail.trim().length > 0;
    case "bundle-summary":
    case "step-summary":
      return row.children.length > 0;
    case "turn":
      return true;
    case "work":
      return isWorkRowExpandable(row);
    default:
      return assertNever(row);
  }
}

function shouldRenderCompactActivityIntentRows(
  row: ThreadTimelineViewRow,
): row is Extract<TimelineViewWorkRow, { workKind: "command" | "tool" }> {
  return (
    row.kind === "work" &&
    (row.workKind === "command" || row.workKind === "tool") &&
    row.approvalStatus === null
  );
}

/**
 * Bundle and step summaries whose children are all non-expandable get the
 * base max-height cap with overflow fades. Summaries that contain any
 * expandable child do not — capping then would put the child's own scroll
 * body inside a scrolling parent, which is poor UX. The expandability test
 * reuses `isWorkRowExpandable` so the cap rule and the per-row expand
 * affordance can never disagree.
 */
function isNonExpandableSummary(
  children: readonly TimelineViewWorkRow[],
): boolean {
  return children.length > 0 && children.every((child) => !isWorkRowExpandable(child));
}

function isActiveLatestBundleSummary({
  activeLatestBundleId,
  row,
  scopeActive,
}: ActiveSummaryTreatmentArgs): boolean {
  return (
    row.kind === "bundle-summary" &&
    scopeActive &&
    row.id === activeLatestBundleId
  );
}

// Auto-expand rule (single rule, applied uniformly):
//
//   In an active container, find the trailing row that the agent produced
//   (skipping over user-role conversation rows — initial messages,
//   follow-ups, accepted or pending steers — since those are inputs to
//   the agent rather than events on the activity timeline). If that
//   frontier row is expandable, auto-expand it. If it isn't expandable
//   (assistant text, denied web fetch, system row without detail, ...),
//   nothing in the container auto-expands. We do not search backward past
//   a non-expandable frontier.
//
// Active containers are the timeline's top-level row list (when the thread
// is active) and the childRows of pending delegations *inside an active
// container*. A completed delegation closes its scope, so a pending
// sub-delegation buried inside a completed parent does NOT auto-expand —
// the active scope must propagate from the top-level thread runtime down
// through every enclosing container. The rule does not apply to
// bundle-summary, step-summary, or turn-summary children — those represent
// grouped or archived work whose interior is not the current frontier.
//
// `defaultExpandAllRows` is a test/story override that bypasses the rule
// and expands every expandable row in every container.
function visitForAutoExpand(
  rows: readonly ThreadTimelineViewRow[],
  scopeActive: boolean,
  ids: Set<string>,
): void {
  if (!scopeActive) {
    return;
  }
  const frontier = findTimelineFrontierRow(rows);
  if (frontier && isRowExpandable(frontier)) {
    ids.add(frontier.id);
  }
  for (const row of rows) {
    if (
      row.kind === "work" &&
      row.workKind === "delegation" &&
      row.status === "pending"
    ) {
      visitForAutoExpand(row.childRows, true, ids);
    }
  }
}

function expandAllExpandableRows(
  rows: readonly ThreadTimelineViewRow[],
  ids: Set<string>,
): void {
  for (const row of rows) {
    if (isRowExpandable(row)) {
      ids.add(row.id);
    }
    if (row.kind === "bundle-summary" || row.kind === "step-summary") {
      expandAllExpandableRows(row.children, ids);
    } else if (row.kind === "work" && row.workKind === "delegation") {
      expandAllExpandableRows(row.childRows, ids);
    } else if (row.kind === "turn" && row.children) {
      expandAllExpandableRows(row.children, ids);
    }
  }
}

function collectTimelineAutoExpandedRowIds({
  defaultExpandAllRows,
  rows,
  scopeActive,
}: CollectTimelineAutoExpandedRowIdsArgs): ReadonlySet<string> {
  const ids = new Set<string>();
  if (defaultExpandAllRows) {
    expandAllExpandableRows(rows, ids);
    return ids;
  }
  visitForAutoExpand(rows, scopeActive, ids);
  return ids;
}

function timelineRowTitleOptions({
  activeLatestBundleId,
  row,
  scopeActive,
}: TimelineRowTitleOptionsArgs): BuildTimelineRowTitleOptions {
  const useActiveBundleLabel = isActiveLatestBundleSummary({
    activeLatestBundleId,
    row,
    scopeActive,
  });
  return {
    summaryStyle: useActiveBundleLabel ? "bundle" : "background",
    workStyle:
      row.kind === "work" && row.inClosedStep ? "summary" : "default",
    isActiveLatestBundle: useActiveBundleLabel,
  };
}

function timelineRowHorizontalPadding(
  spacing: TimelineRowsListSpacing,
): TimelineRowHorizontalPadding {
  switch (spacing) {
    case "top-level":
    case "nested":
      return "default";
    case "bundle":
      return "flush";
  }
}

function TimelineStaticRow({
  children,
  className,
  horizontalPadding = "default",
}: TimelineStaticRowProps) {
  return (
    <TimelineStaticRowHeader
      horizontalPadding={horizontalPadding}
      className={className}
    >
      {children}
    </TimelineStaticRowHeader>
  );
}

function timelineRowsListGapClassName(
  spacing: TimelineRowsListSpacing,
): string {
  switch (spacing) {
    case "top-level":
      return "gap-1";
    case "nested":
      return "gap-0.5";
    case "bundle":
      return "gap-0";
  }
}

function timelineRowWrapperClassName({
  row,
  spacing,
}: TimelineRowWrapperClassNameArgs): string | undefined {
  if (spacing !== "top-level") {
    return undefined;
  }
  if (row.kind === "conversation" && row.role === "user") {
    return undefined;
  }
  return "pb-2";
}

function ConversationRow({ row }: ConversationRowProps) {
  const {
    onOpenLocalFileLink,
    projectId,
    resolveUserAttachmentImageSrc,
  } = useTimelineRendererContext();
  return (
    <ConversationMessageContent
      attachments={row.attachments}
      onOpenLocalFileLink={onOpenLocalFileLink}
      projectId={projectId}
      resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
      role={row.role}
      text={row.text}
      userRequest={row.userRequest}
    />
  );
}

function TimelineSystemDetailBlock({
  detail,
  streaming,
  tone,
}: TimelineSystemDetailBlockProps) {
  return (
    <TimelineDetailScroll
      size="base"
      streaming={streaming}
      contentKey={detail}
      className={cn(
        "rounded-md border",
        tone === "danger"
          ? "border-destructive/30 bg-destructive/5"
          : "border-border/60 bg-background/40",
      )}
    >
      <pre
        className={cn(
          "whitespace-pre px-3 py-2 font-mono text-xs leading-5",
          tone === "danger" ? "text-destructive/90" : "text-muted-foreground",
        )}
      >
        {detail}
      </pre>
    </TimelineDetailScroll>
  );
}

function TimelineExpandableBody({
  compactActivityIntents,
  row,
}: TimelineExpandableBodyProps) {
  const {
    onOpenLocalFileLink,
    projectId,
    resolveUserAttachmentImageSrc,
    themeType,
  } = useTimelineRendererContext();

  switch (row.kind) {
    case "bundle-summary":
    case "step-summary": {
      const list = (
        <TimelineRowsList
          rows={row.children}
          scopeActive={false}
          compactActivityIntents={true}
          spacing="bundle"
        />
      );
      // Summaries whose children are themselves expandable (commands, tools
      // without exploration intents, file-changes, delegations, or any mix
      // including those) leave the cap off — capping would force a child's
      // own scroll body to live inside a parent scroll, and nested
      // scrollbars are bad UX. Only summaries whose children are all flat
      // and non-expandable (exploration intent listings, web search/fetch)
      // keep the base cap with overflow fades.
      if (!isNonExpandableSummary(row.children)) {
        return list;
      }
      return (
        <TimelineDetailScroll
          size="summary"
          streaming={row.status === "pending"}
          contentKey={timelineRowsSignature(row.children)}
        >
          {list}
        </TimelineDetailScroll>
      );
    }
    case "turn":
      return (
        <TurnRowBody
          row={row}
          compactActivityIntents={compactActivityIntents}
        />
      );
    case "work":
      if (row.workKind === "delegation") {
        return (
          <TimelineDetailScroll
            size="delegation"
            streaming={row.status === "pending"}
            contentKey={`${timelineRowsSignature(row.childRows)}|${row.output.length}`}
            className="rounded-md border border-border/60 bg-background/40"
          >
            {row.childRows.length > 0 ? (
              <div className="px-1 py-1">
                <TimelineRowsList
                  rows={row.childRows}
                  scopeActive={row.status === "pending"}
                  compactActivityIntents={false}
                  spacing="nested"
                />
              </div>
            ) : null}
            {row.output.trim().length > 0 ? (
              <div className="px-2 py-2">
                <ConversationMessageContent
                  attachments={null}
                  onOpenLocalFileLink={onOpenLocalFileLink}
                  projectId={projectId}
                  resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
                  role="assistant"
                  text={row.output}
                  userRequest={null}
                />
              </div>
            ) : null}
          </TimelineDetailScroll>
        );
      }
      return <WorkRowBody row={row} themeType={themeType} />;
    case "system":
      return row.detail ? (
        <TimelineSystemDetailBlock
          detail={row.detail}
          streaming={row.status === "pending"}
          tone={
            row.systemKind === "error" || row.status === "error"
              ? "danger"
              : "default"
          }
        />
      ) : null;
    case "conversation":
      return null;
    default:
      return assertNever(row);
  }
}

function TurnRowBody({
  compactActivityIntents,
  row,
}: TurnRowBodyProps) {
  const {
    getViewRows,
    loadingTurnSummaryIds,
    erroredTurnSummaryIds,
    onLoadTurnSummaryRows,
    turnSummaryRowsById,
  } = useTimelineRendererContext();
  const loadedRows = turnSummaryRowsById[row.id];
  const hasInlineChildren = row.children !== null;
  const hasLoadedRows = loadedRows !== undefined;
  const rows = hasInlineChildren
    ? row.children
    : loadedRows
      ? // Lazy turn-detail children belong to a completed turn — flag the
        // scope as closed so trailing work in the children collapses into a
        // step-summary at end-of-input, matching the inline-children path.
        getViewRows(loadedRows, { closedScope: true })
      : null;
  const isLoading = loadingTurnSummaryIds.has(row.id);
  const isError = erroredTurnSummaryIds.has(row.id);
  const handleRetry = useCallback((): void => {
    requestLazyTurnRows({
      onLoadTurnSummaryRows,
      row,
    });
  }, [onLoadTurnSummaryRows, row]);

  useEffect(() => {
    if (hasInlineChildren || hasLoadedRows || isLoading || isError) {
      return;
    }
    requestLazyTurnRows({
      onLoadTurnSummaryRows,
      row,
    });
  }, [
    hasLoadedRows,
    hasInlineChildren,
    isError,
    isLoading,
    onLoadTurnSummaryRows,
    row,
  ]);

  if (isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <span>Failed to load turn details.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRetry}
          className="h-7 border-destructive/30 px-2 text-destructive hover:text-destructive"
        >
          <RotateCcw />
          Retry
        </Button>
      </div>
    );
  }
  if (rows) {
    return (
      <TimelineRowsList
        rows={rows}
        scopeActive={false}
        compactActivityIntents={compactActivityIntents}
        spacing="nested"
      />
    );
  }
  return (
    <div className="text-sm text-muted-foreground">Loading turn details...</div>
  );
}

function TimelineRowView({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  scopeActive,
  spacing,
}: TimelineRowViewProps) {
  const { onTitleAction } = useTimelineRendererContext();
  const horizontalPadding = timelineRowHorizontalPadding(spacing);
  const titleState = useTimelineRowTitleRenderState({
    activeLatestBundleId,
    compactActivityIntents,
    row,
    scopeActive,
    spacing,
  });

  if (row.kind === "conversation") {
    return <ConversationRow row={row} />;
  }
  if (titleState.kind === "compact-activity-intents") {
    return (
      <>
        {titleState.titles.map((entry) => (
          <TimelineStaticRow
            key={entry.id}
            horizontalPadding={horizontalPadding}
          >
            <TimelineTitleView
              title={entry.title}
              onTitleAction={onTitleAction}
            />
          </TimelineStaticRow>
        ))}
      </>
    );
  }

  if (!isRowExpandable(row)) {
    return (
      <TimelineStaticRow horizontalPadding={horizontalPadding}>
        <TimelineTitleView
          title={titleState.title}
          onTitleAction={onTitleAction}
        />
      </TimelineStaticRow>
    );
  }

  return (
    <MemoizedTimelineExpandableRowView
      row={row}
      title={titleState.title}
      horizontalPadding={horizontalPadding}
      compactActivityIntents={compactActivityIntents}
    />
  );
}

const MemoizedTimelineRowView = memo(
  TimelineRowView,
  areTimelineRowViewPropsEqual,
);

function TimelineExpandableRowView({
  compactActivityIntents,
  title,
  horizontalPadding,
  row,
}: TimelineExpandableRowViewProps) {
  const {
    autoExpandedRowIds,
    loadingTurnSummaryIds,
    erroredTurnSummaryIds,
    onLoadTurnSummaryRows,
    onTitleAction,
    turnSummaryRowsById,
  } = useTimelineRendererContext();

  const handleBeforeExpand = useCallback((): void => {
    if (
      row.kind === "turn" &&
      row.children === null &&
      !turnSummaryRowsById[row.id] &&
      !loadingTurnSummaryIds.has(row.id) &&
      !erroredTurnSummaryIds.has(row.id)
    ) {
      requestLazyTurnRows({
        onLoadTurnSummaryRows,
        row,
      });
    }
  }, [
    erroredTurnSummaryIds,
    loadingTurnSummaryIds,
    onLoadTurnSummaryRows,
    row,
    turnSummaryRowsById,
  ]);
  const renderBody = useCallback(
    () => (
      <TimelineExpandableBody
        row={row}
        compactActivityIntents={compactActivityIntents}
      />
    ),
    [compactActivityIntents, row],
  );

  return (
    <ExpandableTimelineRow
      title={title}
      horizontalPadding={horizontalPadding}
      autoExpanded={autoExpandedRowIds.has(row.id)}
      onBeforeExpand={handleBeforeExpand}
      onTitleAction={onTitleAction}
      renderBody={renderBody}
    />
  );
}

const MemoizedTimelineExpandableRowView = memo(
  TimelineExpandableRowView,
  areTimelineExpandableRowViewPropsEqual,
);

function TimelineRowsList({
  compactActivityIntents,
  rows,
  scopeActive,
  spacing,
}: TimelineRowsListProps) {
  const activeLatestBundleId = useMemo(
    () => findActiveLatestBundleId(rows),
    [rows],
  );
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        timelineRowsListGapClassName(spacing),
      )}
      data-timeline-row-list={spacing}
    >
      {rows.map((row) => (
        <div
          key={row.id}
          className={timelineRowWrapperClassName({ row, spacing })}
        >
          <MemoizedTimelineRowView
            activeLatestBundleId={activeLatestBundleId}
            row={row}
            scopeActive={scopeActive}
            spacing={spacing}
            compactActivityIntents={compactActivityIntents}
          />
        </div>
      ))}
    </div>
  );
}

function ThreadTimelineRowsComponent(props: ThreadTimelineRowsProps) {
  return (
    <ThreadTimelineRowsForIdentity
      key={props.turnSummaryRowsIdentity}
      {...props}
    />
  );
}

function ThreadTimelineRowsForIdentity(props: ThreadTimelineRowsProps) {
  const getViewRows = useTimelineViewRowsCache();
  const rows = useMemo(
    () => getViewRows(props.timelineRows),
    [getViewRows, props.timelineRows],
  );
  const scopeActive = isRunningThreadRuntimeDisplayStatus(
    props.threadRuntimeDisplayStatus,
  );
  const themeType = props.themeType ?? "light";
  const computedAutoExpandedRowIds = useMemo(
    () =>
      collectTimelineAutoExpandedRowIds({
        defaultExpandAllRows: props.defaultExpandAllRows ?? false,
        rows,
        scopeActive,
      }),
    [props.defaultExpandAllRows, rows, scopeActive],
  );
  const autoExpandedRowIds = useStableReadonlySet(computedAutoExpandedRowIds);
  const loadingTurnSummaryIds = useStableReadonlySet(
    props.loadingTurnSummaryIds,
  );
  const erroredTurnSummaryIds = useStableReadonlySet(
    props.erroredTurnSummaryIds,
  );
  const requestedTurnSummaryRowIdsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const rowId of erroredTurnSummaryIds) {
      requestedTurnSummaryRowIdsRef.current.delete(rowId);
    }
  }, [erroredTurnSummaryIds]);
  const handleLoadTurnSummaryRows = useCallback(
    (entry: TimelineTurnRow): void => {
      if (requestedTurnSummaryRowIdsRef.current.has(entry.id)) {
        return;
      }
      requestedTurnSummaryRowIdsRef.current.add(entry.id);
      props.onLoadTurnSummaryRows(entry);
    },
    [props.onLoadTurnSummaryRows],
  );
  const rendererContextValue = useMemo<TimelineRendererContextValue>(
    () => ({
      autoExpandedRowIds,
      getViewRows,
      loadingTurnSummaryIds,
      erroredTurnSummaryIds,
      onLoadTurnSummaryRows: handleLoadTurnSummaryRows,
      onOpenLocalFileLink: props.onOpenLocalFileLink,
      onTitleAction: props.onTitleAction,
      projectId: props.projectId,
      resolveUserAttachmentImageSrc: props.resolveUserAttachmentImageSrc,
      themeType,
      turnSummaryRowsById: props.turnSummaryRowsById,
    }),
    [
      autoExpandedRowIds,
      erroredTurnSummaryIds,
      getViewRows,
      handleLoadTurnSummaryRows,
      loadingTurnSummaryIds,
      props.onOpenLocalFileLink,
      props.onTitleAction,
      props.projectId,
      props.resolveUserAttachmentImageSrc,
      props.turnSummaryRowsById,
      themeType,
    ],
  );

  return (
    <TimelineRendererContext.Provider value={rendererContextValue}>
      <TimelineRowsList
        rows={rows}
        scopeActive={scopeActive}
        compactActivityIntents={false}
        spacing="top-level"
      />
    </TimelineRendererContext.Provider>
  );
}

export const ThreadTimelineRows = memo(ThreadTimelineRowsComponent);
ThreadTimelineRows.displayName = "ThreadTimelineRows";
