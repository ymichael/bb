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
import type { ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { TimelineRow, TimelineTurnRow } from "@bb/server-contract";
import {
  assertNever,
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  buildTimelineViewRows,
  createTimelineViewRowsCache,
  findActiveLatestBundleId,
  type BuildTimelineRowTitleOptions,
  type BuildTimelineViewRowsOptions,
  type ThreadTimelineViewRow,
  type TimelineActivityIntentTitle,
  type TimelineTitle,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
} from "@bb/thread-view";
import { cn } from "@/lib/utils";
import {
  collectTimelineAutoExpandedRowIds,
  isNonExpandableSummary,
  isRowExpandable,
} from "./timeline-auto-expand.js";
import { isRunningThreadRuntimeDisplayStatus } from "./thread-runtime-status.js";
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
  type TimelineTitleLinkResolver,
} from "./TimelineTitleView.js";
import { WorkRowBody } from "./TimelineRowDetails.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import { Button } from "../../ui/button.js";
import { AutoHeightContainer } from "../../ui/height-transition.js";
import { Icon } from "@/components/ui/icon.js";
import {
  joinSignatureParts,
  timelineRowRenderSignature,
  timelineRowsSignature,
} from "./timelineRowSignatures.js";

export interface ThreadTimelineRowsProps {
  erroredTurnSummaryIds: ReadonlySet<string>;
  /**
   * Row ids to start expanded on first render. Non-recursive: an id only
   * applies to the row it names — bundle/step/turn children are unaffected.
   * Used by stories and audit surfaces to seed an open body without faking
   * a running runtime status.
   */
  initialExpanded?: ReadonlySet<string>;
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
  /**
   * Workspace root path the agent ran in (`environment.path`). Forwarded to
   * file-change rows so they can strip the prefix from `change.path` and
   * render repo-relative paths in the diff card header. Pass `undefined`
   * only when the environment hasn't loaded yet.
   */
  workspaceRootPath: string | undefined;
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
  resolveSegmentLinkHref: TimelineTitleLinkResolver | undefined;
  resolveUserAttachmentImageSrc: UserAttachmentImageSrcResolver | undefined;
  themeType: ThreadTimelineTheme;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
  workspaceRootPath: string | undefined;
}

interface TimelineRowsListProps {
  compactActivityIntents: boolean;
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
  spacing: TimelineRowsListSpacing;
  className?: string;
}

interface TimelineRowViewProps {
  activeLatestBundleId: string | null;
  compactActivityIntents: boolean;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
  spacing: TimelineRowsListSpacing;
}

interface TimelineExpandableRowViewProps {
  activeLatestBundleId: string | null;
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
  activeLatestBundleId: string | null;
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

const NESTED_ROWS_GROUP_LINE_CLASS =
  "relative my-1 pl-3 pr-2 before:pointer-events-none before:absolute before:bottom-1 before:left-1.5 before:top-0 before:w-px before:bg-foreground/15 before:content-['']";

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
    previous.activeLatestBundleId === next.activeLatestBundleId &&
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

function useStableReadonlySet(
  values: ReadonlySet<string>,
): ReadonlySet<string> {
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

function shouldRenderCompactActivityIntentRows(
  row: ThreadTimelineViewRow,
): row is Extract<TimelineViewWorkRow, { workKind: "command" | "tool" }> {
  return (
    row.kind === "work" &&
    (row.workKind === "command" || row.workKind === "tool") &&
    row.approvalStatus === null
  );
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
  // Bundle summaries always render with the bundle (verb + rest) split so the
  // verb can shimmer and the rest can carry em when the bundle is the
  // active-latest. Step summaries collapse to the flat muted single-segment
  // "background" style — they're a recap of finished work, not a frontier.
  return {
    summaryStyle: row.kind === "step-summary" ? "background" : "bundle",
    workStyle: row.kind === "work" && row.inClosedStep ? "summary" : "default",
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
      return "gap-4";
    case "nested":
      return "gap-3";
    case "bundle":
      return "gap-0";
  }
}

function ConversationRow({ row }: ConversationRowProps) {
  const { onOpenLocalFileLink, projectId, resolveUserAttachmentImageSrc } =
    useTimelineRendererContext();
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
  // Mirror the card chrome from TerminalOutputBlock so operation detail
  // bodies (provisioning transcripts, provider-unhandled payloads) read as
  // the same "output" surface as command output. Danger tone overlays the
  // destructive palette without changing the card shape.
  return (
    <TimelineDetailScroll
      size="base"
      streaming={streaming}
      contentKey={detail}
      className={cn(
        "overflow-hidden rounded-lg border bg-card",
        tone === "danger" ? "border-destructive/30" : "border-border",
      )}
    >
      <pre
        className={cn(
          "whitespace-pre px-4 py-3 font-mono text-xs leading-tight",
          tone === "danger" ? "text-destructive/90" : "text-foreground",
        )}
      >
        {detail}
      </pre>
    </TimelineDetailScroll>
  );
}

function TimelineExpandableBody({
  activeLatestBundleId,
  compactActivityIntents,
  row,
}: TimelineExpandableBodyProps) {
  const {
    onOpenLocalFileLink,
    projectId,
    resolveUserAttachmentImageSrc,
    themeType,
    workspaceRootPath,
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
      // Streaming follows the agent's frontier rather than the bundle's
      // reduced child status. A bundle that's still being appended to may
      // momentarily look "completed" between events (replays compress this
      // window to zero), so deriving sticky-bottom from `row.status` would
      // miss most updates. `activeLatestBundleId` is null once the timeline
      // settles past a non-bundle frontier, so streaming naturally shuts off.
      const isFrontier =
        row.kind === "bundle-summary" && row.id === activeLatestBundleId;
      return (
        <TimelineDetailScroll
          size="summary"
          streaming={isFrontier}
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
        const delegationActive = row.status === "pending";
        return (
          <TimelineDetailScroll
            size="delegation"
            streaming={delegationActive}
            contentKey={`${timelineRowsSignature(row.childRows)}|${row.output.length}`}
            className={NESTED_ROWS_GROUP_LINE_CLASS}
          >
            <div className="flex flex-col gap-3">
              {row.childRows.length > 0 ? (
                <TimelineRowsList
                  rows={row.childRows}
                  scopeActive={delegationActive}
                  compactActivityIntents={false}
                  spacing="nested"
                />
              ) : null}
              {row.output.trim().length > 0 ? (
                <ConversationMessageContent
                  attachments={null}
                  onOpenLocalFileLink={onOpenLocalFileLink}
                  projectId={projectId}
                  resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
                  role="assistant"
                  text={row.output}
                  userRequest={null}
                />
              ) : null}
            </div>
          </TimelineDetailScroll>
        );
      }
      return (
        <WorkRowBody
          row={row}
          themeType={themeType}
          workspaceRootPath={workspaceRootPath}
        />
      );
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

function TurnRowBody({ compactActivityIntents, row }: TurnRowBodyProps) {
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
          <Icon name="RotateCcw" />
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
        className={NESTED_ROWS_GROUP_LINE_CLASS}
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
  const { onTitleAction, resolveSegmentLinkHref } =
    useTimelineRendererContext();
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
              resolveSegmentLinkHref={resolveSegmentLinkHref}
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
          resolveSegmentLinkHref={resolveSegmentLinkHref}
        />
      </TimelineStaticRow>
    );
  }

  return (
    <MemoizedTimelineExpandableRowView
      activeLatestBundleId={activeLatestBundleId}
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
  activeLatestBundleId,
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
    resolveSegmentLinkHref,
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
        activeLatestBundleId={activeLatestBundleId}
        row={row}
        compactActivityIntents={compactActivityIntents}
      />
    ),
    [activeLatestBundleId, compactActivityIntents, row],
  );

  return (
    <ExpandableTimelineRow
      title={title}
      horizontalPadding={horizontalPadding}
      autoExpanded={autoExpandedRowIds.has(row.id)}
      onBeforeExpand={handleBeforeExpand}
      onTitleAction={onTitleAction}
      resolveSegmentLinkHref={resolveSegmentLinkHref}
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
  className,
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
        className,
      )}
      data-timeline-row-list={spacing}
    >
      {rows.map((row) => (
        <MemoizedTimelineRowView
          key={row.id}
          activeLatestBundleId={activeLatestBundleId}
          row={row}
          scopeActive={scopeActive}
          spacing={spacing}
          compactActivityIntents={compactActivityIntents}
        />
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
  const computedAutoExpandedRowIds = useMemo(() => {
    const ids = new Set<string>(
      collectTimelineAutoExpandedRowIds({ rows, scopeActive }),
    );
    if (props.initialExpanded) {
      for (const id of props.initialExpanded) {
        ids.add(id);
      }
    }
    return ids;
  }, [rows, scopeActive, props.initialExpanded]);
  const autoExpandedRowIds = useStableReadonlySet(computedAutoExpandedRowIds);
  const loadingTurnSummaryIds = useStableReadonlySet(
    props.loadingTurnSummaryIds,
  );
  const erroredTurnSummaryIds = useStableReadonlySet(
    props.erroredTurnSummaryIds,
  );
  const onLoadTurnSummaryRows = props.onLoadTurnSummaryRows;
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
      onLoadTurnSummaryRows(entry);
    },
    [onLoadTurnSummaryRows],
  );
  const projectId = props.projectId;
  const resolveSegmentLinkHref = useMemo<
    TimelineTitleLinkResolver | undefined
  >(() => {
    if (projectId === undefined) {
      return undefined;
    }
    return (link) => {
      switch (link.kind) {
        case "thread":
          return `/projects/${projectId}/threads/${link.threadId}`;
        default:
          return assertNever(link.kind);
      }
    };
  }, [projectId]);
  const rendererContextValue = useMemo<TimelineRendererContextValue>(
    () => ({
      autoExpandedRowIds,
      getViewRows,
      loadingTurnSummaryIds,
      erroredTurnSummaryIds,
      onLoadTurnSummaryRows: handleLoadTurnSummaryRows,
      onOpenLocalFileLink: props.onOpenLocalFileLink,
      onTitleAction: props.onTitleAction,
      projectId,
      resolveSegmentLinkHref,
      resolveUserAttachmentImageSrc: props.resolveUserAttachmentImageSrc,
      themeType,
      turnSummaryRowsById: props.turnSummaryRowsById,
      workspaceRootPath: props.workspaceRootPath,
    }),
    [
      autoExpandedRowIds,
      erroredTurnSummaryIds,
      getViewRows,
      handleLoadTurnSummaryRows,
      loadingTurnSummaryIds,
      props.onOpenLocalFileLink,
      props.onTitleAction,
      projectId,
      resolveSegmentLinkHref,
      props.resolveUserAttachmentImageSrc,
      props.turnSummaryRowsById,
      props.workspaceRootPath,
      themeType,
    ],
  );

  return (
    <TimelineRendererContext.Provider value={rendererContextValue}>
      <AutoHeightContainer>
        <TimelineRowsList
          rows={rows}
          scopeActive={scopeActive}
          compactActivityIntents={false}
          spacing="top-level"
        />
      </AutoHeightContainer>
    </TimelineRendererContext.Provider>
  );
}

export const ThreadTimelineRows = memo(ThreadTimelineRowsComponent);
ThreadTimelineRows.displayName = "ThreadTimelineRows";
