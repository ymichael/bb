import { useCallback, useEffect, useMemo, useRef } from "react";
import type { MutableRefObject, ReactNode } from "react";
import type { ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { TimelineRow, TimelineTurnRow } from "@bb/server-contract";
import {
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  buildTimelineViewRows,
  type BuildTimelineRowTitleOptions,
  type ThreadTimelineViewRow,
  type TimelineTitle,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
} from "@bb/thread-view";
import { cn } from "../primitives/cn.js";
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
import { TimelineTitleView } from "./TimelineTitleView.js";
import { WorkRowBody } from "./TimelineRowDetails.js";
import { useStickyBottomScroll } from "./useStickyBottomScroll.js";

export interface ThreadTimelineRowsProps {
  erroredTurnSummaryIds: ReadonlySet<string>;
  loadingTurnSummaryIds: ReadonlySet<string>;
  onLoadTurnSummaryRows: (entry: TimelineTurnRow) => void;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  themeType?: ThreadTimelineTheme;
  timelineRows: TimelineRow[];
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
}

interface TimelineRendererContext {
  autoExpandedRowIds: ReadonlySet<string>;
  compactActivityIntents: boolean;
  getViewRows: GetTimelineViewRows;
  requestedTurnSummaryRowIdsRef: MutableRefObject<Set<string>>;
  loadingTurnSummaryIds: ReadonlySet<string>;
  erroredTurnSummaryIds: ReadonlySet<string>;
  onLoadTurnSummaryRows: (entry: TimelineTurnRow) => void;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  themeType: ThreadTimelineTheme;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
}

interface TimelineRowsListProps extends TimelineRendererContext {
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
  spacing: TimelineRowsListSpacing;
}

interface TimelineRowWrapperClassNameArgs {
  row: ThreadTimelineViewRow;
  spacing: TimelineRowsListSpacing;
}

interface TimelineRowViewProps extends TimelineRendererContext {
  isTail: boolean;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
  spacing: TimelineRowsListSpacing;
}

interface TimelineExpandableRowViewProps extends TimelineRendererContext {
  expandableTitle: TimelineTitle;
  horizontalPadding: TimelineRowHorizontalPadding;
  row: Exclude<ThreadTimelineViewRow, { kind: "conversation" }>;
}

interface TimelineStaticRowProps {
  children: ReactNode;
  className?: string;
  horizontalPadding?: TimelineRowHorizontalPadding;
}

interface TimelineExpandableBodyProps extends TimelineRendererContext {
  row: ThreadTimelineViewRow;
}

interface TimelineSystemDetailBlockProps {
  detail: string;
  tone: "default" | "danger";
}

interface RequestLazyTurnRowsArgs {
  onLoadTurnSummaryRows: (entry: TimelineTurnRow) => void;
  requestedTurnSummaryRowIdsRef: MutableRefObject<Set<string>>;
  row: TimelineViewTurnRow;
}

interface CollectTimelineAutoExpandedRowIdsArgs {
  getViewRows: GetTimelineViewRows;
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
}

interface RowActivityContext {
  isTail: boolean;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
}

type TimelineConversationViewRow = Extract<
  ThreadTimelineViewRow,
  { kind: "conversation" }
>;

type TimelineRowsListSpacing = "top-level" | "nested" | "bundle";
type TimelineRawRows = readonly TimelineRow[];
type GetTimelineViewRows = (rows: TimelineRawRows) => ThreadTimelineViewRow[];

interface ConversationRowProps {
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  row: TimelineConversationViewRow;
}

interface TurnRowBodyProps extends TimelineRendererContext {
  row: TimelineViewTurnRow;
}

interface UseTimelineViewRowsCacheResult {
  getViewRows: GetTimelineViewRows;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled timeline row: ${String(value)}`);
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
    durationMs: row.durationMs,
    children: null,
  };
}

function requestLazyTurnRows({
  onLoadTurnSummaryRows,
  requestedTurnSummaryRowIdsRef,
  row,
}: RequestLazyTurnRowsArgs): void {
  if (requestedTurnSummaryRowIdsRef.current.has(row.id)) {
    return;
  }
  requestedTurnSummaryRowIdsRef.current.add(row.id);
  onLoadTurnSummaryRows(toLazyTurnRequest(row));
}

function isRuntimeScopeActive(status: ThreadRuntimeDisplayStatus): boolean {
  return status === "active" || status === "host-reconnecting";
}

function useTimelineViewRowsCache(): UseTimelineViewRowsCacheResult {
  const cacheRef = useRef(new WeakMap<TimelineRawRows, ThreadTimelineViewRow[]>());
  const getViewRows = useCallback<GetTimelineViewRows>((rawRows) => {
    const cachedRows = cacheRef.current.get(rawRows);
    if (cachedRows) {
      return cachedRows;
    }

    const viewRows = buildTimelineViewRows(rawRows);
    cacheRef.current.set(rawRows, viewRows);
    return viewRows;
  }, []);

  return useMemo(
    () => ({
      getViewRows,
    }),
    [getViewRows],
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
    case "activity-summary":
      return row.children.length > 0;
    case "turn":
      return true;
    case "work":
      return isWorkRowExpandable(row);
    default:
      return assertNever(row);
  }
}

function rowHasPendingStatus(row: ThreadTimelineViewRow): boolean {
  switch (row.kind) {
    case "conversation":
      return false;
    case "system":
      return row.status === "pending";
    case "activity-summary":
    case "turn":
    case "work":
      return row.status === "pending";
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
    row.approvalStatus === null &&
    row.status !== "error" &&
    row.status !== "interrupted"
  );
}

function buildExpandableStructuredToolTitle(
  row: ThreadTimelineViewRow,
): TimelineTitle | null {
  if (
    row.kind !== "work" ||
    row.workKind !== "tool" ||
    row.status !== "error"
  ) {
    return null;
  }
  const titles = buildTimelineActivityIntentTitles(row);
  return titles.length === 1 ? (titles[0]?.title ?? null) : null;
}

function shouldAutoExpandRow({
  isTail,
  row,
  scopeActive,
}: RowActivityContext): boolean {
  if (!isRowExpandable(row)) {
    return false;
  }
  if (!scopeActive) {
    return false;
  }
  if (!rowHasPendingStatus(row)) {
    return false;
  }
  if (row.kind === "activity-summary") {
    return scopeActive && isTail;
  }
  return true;
}

function collectTimelineAutoExpandedRowIds({
  getViewRows,
  rows,
  scopeActive,
  turnSummaryRowsById,
}: CollectTimelineAutoExpandedRowIdsArgs): ReadonlySet<string> {
  const autoExpandedRowIds = new Set<string>();

  const visitRows = (
    currentRows: readonly ThreadTimelineViewRow[],
    currentScopeActive: boolean,
  ): void => {
    if (!currentScopeActive) {
      return;
    }

    currentRows.forEach((row, index) => {
      const isTail = index === currentRows.length - 1;
      if (shouldAutoExpandRow({ isTail, row, scopeActive: currentScopeActive })) {
        autoExpandedRowIds.add(row.id);
      }

      if (row.kind === "activity-summary") {
        visitRows(row.children, false);
      } else if (row.kind === "work" && row.workKind === "delegation") {
        visitRows(row.childRows, row.status === "pending");
      } else if (row.kind === "turn") {
        const turnChildRows =
          row.children ??
          (turnSummaryRowsById[row.id]
            ? getViewRows(turnSummaryRowsById[row.id] ?? [])
            : null);
        if (turnChildRows) {
          visitRows(turnChildRows, row.status === "pending");
        }
      }
    });
  };

  visitRows(rows, scopeActive);
  return autoExpandedRowIds;
}

function timelineRowTitleOptions({
  isTail,
  row,
  scopeActive,
}: RowActivityContext): BuildTimelineRowTitleOptions {
  const useActiveBundleLabel =
    row.kind === "activity-summary" && scopeActive && isTail;
  return {
    preferOngoingLabel: useActiveBundleLabel,
    summaryStyle: useActiveBundleLabel ? "bundle" : "background",
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

function ConversationRow({
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  row,
}: ConversationRowProps) {
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
  tone,
}: TimelineSystemDetailBlockProps) {
  const detailScroll = useStickyBottomScroll<HTMLPreElement>({
    contentKey: detail,
  });

  return (
    <pre
      ref={detailScroll.ref}
      onPointerDown={detailScroll.onPointerDown}
      onScroll={detailScroll.onScroll}
      onTouchMove={detailScroll.onTouchMove}
      onTouchStart={detailScroll.onTouchStart}
      onWheel={detailScroll.onWheel}
      className={cn(
        "max-h-96 overflow-auto whitespace-pre rounded-md border px-3 py-2 font-mono text-xs leading-5",
        tone === "danger"
          ? "border-destructive/30 bg-destructive/5 text-destructive/90"
          : "border-border/60 bg-background/40 text-muted-foreground",
      )}
    >
      {detail}
    </pre>
  );
}

function TimelineExpandableBody({
  compactActivityIntents,
  autoExpandedRowIds,
  erroredTurnSummaryIds,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  requestedTurnSummaryRowIdsRef,
  row,
  themeType,
  turnSummaryRowsById,
  getViewRows,
}: TimelineExpandableBodyProps) {
  switch (row.kind) {
    case "activity-summary":
      return (
        <TimelineRowsList
          rows={row.children}
          scopeActive={false}
          compactActivityIntents={true}
          autoExpandedRowIds={autoExpandedRowIds}
          spacing="bundle"
          requestedTurnSummaryRowIdsRef={requestedTurnSummaryRowIdsRef}
          loadingTurnSummaryIds={loadingTurnSummaryIds}
          erroredTurnSummaryIds={erroredTurnSummaryIds}
          onLoadTurnSummaryRows={onLoadTurnSummaryRows}
          onOpenLocalFileLink={onOpenLocalFileLink}
          projectId={projectId}
          resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
          themeType={themeType}
          turnSummaryRowsById={turnSummaryRowsById}
          getViewRows={getViewRows}
        />
      );
    case "turn":
      return (
        <TurnRowBody
          row={row}
          compactActivityIntents={compactActivityIntents}
          autoExpandedRowIds={autoExpandedRowIds}
          requestedTurnSummaryRowIdsRef={requestedTurnSummaryRowIdsRef}
          loadingTurnSummaryIds={loadingTurnSummaryIds}
          erroredTurnSummaryIds={erroredTurnSummaryIds}
          onLoadTurnSummaryRows={onLoadTurnSummaryRows}
          onOpenLocalFileLink={onOpenLocalFileLink}
          projectId={projectId}
          resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
          themeType={themeType}
          turnSummaryRowsById={turnSummaryRowsById}
          getViewRows={getViewRows}
        />
      );
    case "work":
      if (row.workKind === "delegation") {
        return (
          <div className="overflow-auto rounded-md border border-border/60 bg-background/40">
            {row.childRows.length > 0 ? (
              <div className="px-1 py-1">
                <TimelineRowsList
                  rows={row.childRows}
                  scopeActive={row.status === "pending"}
                  compactActivityIntents={false}
                  autoExpandedRowIds={autoExpandedRowIds}
                  spacing="nested"
                  requestedTurnSummaryRowIdsRef={requestedTurnSummaryRowIdsRef}
                  loadingTurnSummaryIds={loadingTurnSummaryIds}
                  erroredTurnSummaryIds={erroredTurnSummaryIds}
                  onLoadTurnSummaryRows={onLoadTurnSummaryRows}
                  onOpenLocalFileLink={onOpenLocalFileLink}
                  projectId={projectId}
                  resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
                  themeType={themeType}
                  turnSummaryRowsById={turnSummaryRowsById}
                  getViewRows={getViewRows}
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
          </div>
        );
      }
      return <WorkRowBody row={row} themeType={themeType} />;
    case "system":
      return row.detail ? (
        <TimelineSystemDetailBlock
          detail={row.detail}
          tone={row.systemKind === "error" ? "danger" : "default"}
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
  autoExpandedRowIds,
  erroredTurnSummaryIds,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  requestedTurnSummaryRowIdsRef,
  row,
  themeType,
  turnSummaryRowsById,
  getViewRows,
}: TurnRowBodyProps) {
  const loadedRows = turnSummaryRowsById[row.id];
  const hasInlineChildren = row.children !== null;
  const hasLoadedRows = loadedRows !== undefined;
  const rows = hasInlineChildren
    ? row.children
    : loadedRows
      ? getViewRows(loadedRows)
      : null;
  const isLoading = loadingTurnSummaryIds.has(row.id);
  const isError = erroredTurnSummaryIds.has(row.id);

  useEffect(() => {
    if (hasInlineChildren || hasLoadedRows || isLoading || isError) {
      return;
    }
    requestLazyTurnRows({
      onLoadTurnSummaryRows,
      requestedTurnSummaryRowIdsRef,
      row,
    });
  }, [
    hasLoadedRows,
    hasInlineChildren,
    isError,
    isLoading,
    onLoadTurnSummaryRows,
    requestedTurnSummaryRowIdsRef,
    row,
  ]);

  if (isError) {
    return (
      <div className="text-sm text-destructive">
        Failed to load turn details.
      </div>
    );
  }
  if (rows) {
    return (
      <TimelineRowsList
        rows={rows}
        scopeActive={row.status === "pending"}
        compactActivityIntents={compactActivityIntents}
        autoExpandedRowIds={autoExpandedRowIds}
        spacing="nested"
        requestedTurnSummaryRowIdsRef={requestedTurnSummaryRowIdsRef}
        loadingTurnSummaryIds={loadingTurnSummaryIds}
        erroredTurnSummaryIds={erroredTurnSummaryIds}
        onLoadTurnSummaryRows={onLoadTurnSummaryRows}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        themeType={themeType}
        turnSummaryRowsById={turnSummaryRowsById}
        getViewRows={getViewRows}
      />
    );
  }
  return (
    <div className="text-sm text-muted-foreground">Loading turn details...</div>
  );
}

function TimelineRowView({
  autoExpandedRowIds,
  compactActivityIntents,
  erroredTurnSummaryIds,
  isTail,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  requestedTurnSummaryRowIdsRef,
  row,
  scopeActive,
  spacing,
  themeType,
  turnSummaryRowsById,
  getViewRows,
}: TimelineRowViewProps) {
  const horizontalPadding = timelineRowHorizontalPadding(spacing);

  if (row.kind === "conversation") {
    return (
      <ConversationRow
        row={row}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
      />
    );
  }
  if (
    compactActivityIntents &&
    shouldRenderCompactActivityIntentRows(row)
  ) {
    const titles = buildTimelineActivityIntentTitles(row);
    if (titles.length > 0) {
      return (
        <>
          {titles.map((entry) => (
            <TimelineStaticRow
              key={entry.id}
              horizontalPadding={horizontalPadding}
            >
              <TimelineTitleView title={entry.title} />
            </TimelineStaticRow>
          ))}
        </>
      );
    }
  }

  const title = buildTimelineRowTitle(
    row,
    timelineRowTitleOptions({ isTail, row, scopeActive }),
  );
  const expandableTitle =
    compactActivityIntents && row.status === "error"
      ? (buildExpandableStructuredToolTitle(row) ?? title)
      : title;

  if (!isRowExpandable(row)) {
    return (
      <TimelineStaticRow horizontalPadding={horizontalPadding}>
        <TimelineTitleView title={title} />
      </TimelineStaticRow>
    );
  }

  return (
    <TimelineExpandableRowView
      row={row}
      expandableTitle={expandableTitle}
      horizontalPadding={horizontalPadding}
      autoExpandedRowIds={autoExpandedRowIds}
      compactActivityIntents={compactActivityIntents}
      requestedTurnSummaryRowIdsRef={requestedTurnSummaryRowIdsRef}
      loadingTurnSummaryIds={loadingTurnSummaryIds}
      erroredTurnSummaryIds={erroredTurnSummaryIds}
      onLoadTurnSummaryRows={onLoadTurnSummaryRows}
      onOpenLocalFileLink={onOpenLocalFileLink}
      projectId={projectId}
      resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
      themeType={themeType}
      turnSummaryRowsById={turnSummaryRowsById}
      getViewRows={getViewRows}
    />
  );
}

function TimelineExpandableRowView({
  autoExpandedRowIds,
  compactActivityIntents,
  erroredTurnSummaryIds,
  expandableTitle,
  horizontalPadding,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  requestedTurnSummaryRowIdsRef,
  row,
  themeType,
  turnSummaryRowsById,
  getViewRows,
}: TimelineExpandableRowViewProps) {
  const handleBeforeExpand = (): void => {
    if (
      row.kind === "turn" &&
      row.children === null &&
      !turnSummaryRowsById[row.id] &&
      !loadingTurnSummaryIds.has(row.id) &&
      !erroredTurnSummaryIds.has(row.id)
    ) {
      requestLazyTurnRows({
        onLoadTurnSummaryRows,
        requestedTurnSummaryRowIdsRef,
        row,
      });
    }
  };

  return (
    <ExpandableTimelineRow
      title={expandableTitle}
      horizontalPadding={horizontalPadding}
      autoExpanded={autoExpandedRowIds.has(row.id)}
      onBeforeExpand={handleBeforeExpand}
      renderBody={() => (
        <TimelineExpandableBody
          row={row}
          compactActivityIntents={compactActivityIntents}
          autoExpandedRowIds={autoExpandedRowIds}
          requestedTurnSummaryRowIdsRef={requestedTurnSummaryRowIdsRef}
          loadingTurnSummaryIds={loadingTurnSummaryIds}
          erroredTurnSummaryIds={erroredTurnSummaryIds}
          onLoadTurnSummaryRows={onLoadTurnSummaryRows}
          onOpenLocalFileLink={onOpenLocalFileLink}
          projectId={projectId}
          resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
          themeType={themeType}
          turnSummaryRowsById={turnSummaryRowsById}
          getViewRows={getViewRows}
        />
      )}
    />
  );
}

function TimelineRowsList({
  autoExpandedRowIds,
  compactActivityIntents,
  erroredTurnSummaryIds,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  requestedTurnSummaryRowIdsRef,
  rows,
  scopeActive,
  spacing,
  themeType,
  turnSummaryRowsById,
  getViewRows,
}: TimelineRowsListProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        timelineRowsListGapClassName(spacing),
      )}
      data-timeline-row-list={spacing}
    >
      {rows.map((row, index) => (
        <div
          key={row.id}
          className={timelineRowWrapperClassName({ row, spacing })}
        >
          <TimelineRowView
            row={row}
            isTail={index === rows.length - 1}
            scopeActive={scopeActive}
            spacing={spacing}
            autoExpandedRowIds={autoExpandedRowIds}
            compactActivityIntents={compactActivityIntents}
            requestedTurnSummaryRowIdsRef={requestedTurnSummaryRowIdsRef}
            loadingTurnSummaryIds={loadingTurnSummaryIds}
            erroredTurnSummaryIds={erroredTurnSummaryIds}
            onLoadTurnSummaryRows={onLoadTurnSummaryRows}
            onOpenLocalFileLink={onOpenLocalFileLink}
            projectId={projectId}
            resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
            themeType={themeType}
            turnSummaryRowsById={turnSummaryRowsById}
            getViewRows={getViewRows}
          />
        </div>
      ))}
    </div>
  );
}

export function ThreadTimelineRows(props: ThreadTimelineRowsProps) {
  const { getViewRows } = useTimelineViewRowsCache();
  const rows = useMemo(
    () => getViewRows(props.timelineRows),
    [getViewRows, props.timelineRows],
  );
  const scopeActive = isRuntimeScopeActive(props.threadRuntimeDisplayStatus);
  const themeType = props.themeType ?? "light";
  const autoExpandedRowIds = useMemo(
    () =>
      collectTimelineAutoExpandedRowIds({
        getViewRows,
        rows,
        scopeActive,
        turnSummaryRowsById: props.turnSummaryRowsById,
      }),
    [getViewRows, rows, scopeActive, props.turnSummaryRowsById],
  );
  const requestedTurnSummaryRowIdsRef = useRef(new Set<string>());

  return (
    <TimelineRowsList
      rows={rows}
      scopeActive={scopeActive}
      compactActivityIntents={false}
      spacing="top-level"
      autoExpandedRowIds={autoExpandedRowIds}
      requestedTurnSummaryRowIdsRef={requestedTurnSummaryRowIdsRef}
      loadingTurnSummaryIds={props.loadingTurnSummaryIds}
      erroredTurnSummaryIds={props.erroredTurnSummaryIds}
      onLoadTurnSummaryRows={props.onLoadTurnSummaryRows}
      onOpenLocalFileLink={props.onOpenLocalFileLink}
      projectId={props.projectId}
      resolveUserAttachmentImageSrc={props.resolveUserAttachmentImageSrc}
      themeType={themeType}
      turnSummaryRowsById={props.turnSummaryRowsById}
      getViewRows={getViewRows}
    />
  );
}
