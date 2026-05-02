import { useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import type { ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { TimelineRow, TimelineTurnRow } from "@bb/server-contract";
import {
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  buildTimelineViewRows,
  type BuildTimelineRowTitleOptions,
  type ThreadTimelineViewRow,
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
import { TimelineTitleView } from "./TimelineTitleView.js";
import { WorkRowBody } from "./TimelineRowDetails.js";
import {
  useTimelineExpansionState,
  type TimelineExpansionState,
} from "./useTimelineExpansionState.js";
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
  compactActivityIntents: boolean;
  expansion: TimelineExpansionState;
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

interface TimelineRowViewProps extends TimelineRendererContext {
  isTail: boolean;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
}

interface TimelineStaticRowProps {
  children: ReactNode;
  className?: string;
}

interface TimelineExpandableBodyProps extends TimelineRendererContext {
  row: ThreadTimelineViewRow;
}

interface TimelineSystemDetailBlockProps {
  detail: string;
  tone: "default" | "danger";
}

interface TimelineExpansionIds {
  autoExpandedRowIds: ReadonlySet<string>;
  rowIds: ReadonlySet<string>;
}

interface CollectTimelineExpansionIdsArgs {
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

interface ConversationRowProps {
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  row: TimelineConversationViewRow;
}

interface TurnRowBodyProps extends TimelineRendererContext {
  row: TimelineViewTurnRow;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled timeline row: ${String(value)}`);
}

function isRuntimeScopeActive(status: ThreadRuntimeDisplayStatus): boolean {
  return status === "active" || status === "host-reconnecting";
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

function collectTimelineExpansionIds({
  rows,
  scopeActive,
  turnSummaryRowsById,
}: CollectTimelineExpansionIdsArgs): TimelineExpansionIds {
  const rowIds = new Set<string>();
  const autoExpandedRowIds = new Set<string>();

  const visitRows = (
    currentRows: readonly ThreadTimelineViewRow[],
    currentScopeActive: boolean,
  ): void => {
    currentRows.forEach((row, index) => {
      const isTail = index === currentRows.length - 1;
      rowIds.add(row.id);
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
            ? buildTimelineViewRows(turnSummaryRowsById[row.id] ?? [])
            : null);
        if (turnChildRows) {
          visitRows(turnChildRows, row.status === "pending");
        }
      }
    });
  };

  visitRows(rows, scopeActive);
  return {
    autoExpandedRowIds,
    rowIds,
  };
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

function TimelineStaticRow({ children, className }: TimelineStaticRowProps) {
  return (
    <div className={cn("group w-full", className)}>
      <div className="px-2 py-0">{children}</div>
    </div>
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
  erroredTurnSummaryIds,
  expansion,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  row,
  themeType,
  turnSummaryRowsById,
}: TimelineExpandableBodyProps) {
  switch (row.kind) {
    case "activity-summary":
      return (
        <TimelineRowsList
          rows={row.children}
          scopeActive={false}
          compactActivityIntents={true}
          spacing="bundle"
          expansion={expansion}
          loadingTurnSummaryIds={loadingTurnSummaryIds}
          erroredTurnSummaryIds={erroredTurnSummaryIds}
          onLoadTurnSummaryRows={onLoadTurnSummaryRows}
          onOpenLocalFileLink={onOpenLocalFileLink}
          projectId={projectId}
          resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
          themeType={themeType}
          turnSummaryRowsById={turnSummaryRowsById}
        />
      );
    case "turn":
      return (
        <TurnRowBody
          row={row}
          compactActivityIntents={compactActivityIntents}
          expansion={expansion}
          loadingTurnSummaryIds={loadingTurnSummaryIds}
          erroredTurnSummaryIds={erroredTurnSummaryIds}
          onLoadTurnSummaryRows={onLoadTurnSummaryRows}
          onOpenLocalFileLink={onOpenLocalFileLink}
          projectId={projectId}
          resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
          themeType={themeType}
          turnSummaryRowsById={turnSummaryRowsById}
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
                  spacing="nested"
                  expansion={expansion}
                  loadingTurnSummaryIds={loadingTurnSummaryIds}
                  erroredTurnSummaryIds={erroredTurnSummaryIds}
                  onLoadTurnSummaryRows={onLoadTurnSummaryRows}
                  onOpenLocalFileLink={onOpenLocalFileLink}
                  projectId={projectId}
                  resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
                  themeType={themeType}
                  turnSummaryRowsById={turnSummaryRowsById}
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
  erroredTurnSummaryIds,
  expansion,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  row,
  themeType,
  turnSummaryRowsById,
}: TurnRowBodyProps) {
  const requestedTurnIdRef = useRef<string | null>(null);
  const loadedRows = turnSummaryRowsById[row.id];
  const hasInlineChildren = row.children !== null;
  const rows = hasInlineChildren
    ? row.children
    : loadedRows
      ? buildTimelineViewRows(loadedRows)
      : null;
  const isLoading = loadingTurnSummaryIds.has(row.id);
  const isError = erroredTurnSummaryIds.has(row.id);

  useEffect(() => {
    if (
      hasInlineChildren ||
      rows !== null ||
      isLoading ||
      isError ||
      requestedTurnIdRef.current === row.id
    ) {
      return;
    }
    requestedTurnIdRef.current = row.id;
    onLoadTurnSummaryRows({
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
    });
  }, [hasInlineChildren, isError, isLoading, onLoadTurnSummaryRows, row, rows]);

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
        spacing="nested"
        expansion={expansion}
        loadingTurnSummaryIds={loadingTurnSummaryIds}
        erroredTurnSummaryIds={erroredTurnSummaryIds}
        onLoadTurnSummaryRows={onLoadTurnSummaryRows}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        themeType={themeType}
        turnSummaryRowsById={turnSummaryRowsById}
      />
    );
  }
  return (
    <div className="text-sm text-muted-foreground">Loading turn details...</div>
  );
}

function TimelineRowView({
  compactActivityIntents,
  erroredTurnSummaryIds,
  expansion,
  isTail,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  row,
  scopeActive,
  themeType,
  turnSummaryRowsById,
}: TimelineRowViewProps) {
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
            <TimelineStaticRow key={entry.id}>
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

  if (!isRowExpandable(row)) {
    return (
      <TimelineStaticRow>
        <TimelineTitleView title={title} />
      </TimelineStaticRow>
    );
  }

  return (
    <ExpandableTimelineRow
      title={title}
      isExpanded={expansion.isExpanded(row.id)}
      onToggle={() => expansion.toggle(row.id)}
      renderBody={() => (
        <TimelineExpandableBody
          row={row}
          compactActivityIntents={compactActivityIntents}
          expansion={expansion}
          loadingTurnSummaryIds={loadingTurnSummaryIds}
          erroredTurnSummaryIds={erroredTurnSummaryIds}
          onLoadTurnSummaryRows={onLoadTurnSummaryRows}
          onOpenLocalFileLink={onOpenLocalFileLink}
          projectId={projectId}
          resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
          themeType={themeType}
          turnSummaryRowsById={turnSummaryRowsById}
        />
      )}
    />
  );
}

function TimelineRowsList({
  compactActivityIntents,
  erroredTurnSummaryIds,
  expansion,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  rows,
  scopeActive,
  spacing,
  themeType,
  turnSummaryRowsById,
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
        <div key={row.id}>
          <TimelineRowView
            row={row}
            isTail={index === rows.length - 1}
            scopeActive={scopeActive}
            compactActivityIntents={compactActivityIntents}
            expansion={expansion}
            loadingTurnSummaryIds={loadingTurnSummaryIds}
            erroredTurnSummaryIds={erroredTurnSummaryIds}
            onLoadTurnSummaryRows={onLoadTurnSummaryRows}
            onOpenLocalFileLink={onOpenLocalFileLink}
            projectId={projectId}
            resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
            themeType={themeType}
            turnSummaryRowsById={turnSummaryRowsById}
          />
        </div>
      ))}
    </div>
  );
}

export function ThreadTimelineRows(props: ThreadTimelineRowsProps) {
  const rows = useMemo(
    () => buildTimelineViewRows(props.timelineRows),
    [props.timelineRows],
  );
  const scopeActive = isRuntimeScopeActive(props.threadRuntimeDisplayStatus);
  const themeType = props.themeType ?? "light";
  const expansionIds = useMemo(
    () =>
      collectTimelineExpansionIds({
        rows,
        scopeActive,
        turnSummaryRowsById: props.turnSummaryRowsById,
      }),
    [rows, scopeActive, props.turnSummaryRowsById],
  );
  const expansion = useTimelineExpansionState(expansionIds);

  return (
    <TimelineRowsList
      rows={rows}
      scopeActive={scopeActive}
      compactActivityIntents={false}
      spacing="top-level"
      expansion={expansion}
      loadingTurnSummaryIds={props.loadingTurnSummaryIds}
      erroredTurnSummaryIds={props.erroredTurnSummaryIds}
      onLoadTurnSummaryRows={props.onLoadTurnSummaryRows}
      onOpenLocalFileLink={props.onOpenLocalFileLink}
      projectId={props.projectId}
      resolveUserAttachmentImageSrc={props.resolveUserAttachmentImageSrc}
      themeType={themeType}
      turnSummaryRowsById={props.turnSummaryRowsById}
    />
  );
}
