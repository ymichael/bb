import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { MutableRefObject, ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { ThreadRuntimeDisplayStatus } from "@bb/domain";
import type {
  TimelineActivityIntent,
  TimelineRow,
  TimelineTurnRow,
} from "@bb/server-contract";
import {
  assertNever,
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  buildTimelineViewRows,
  type BuildTimelineRowTitleOptions,
  type ThreadTimelineViewRow,
  type TimelineActivityIntentTitle,
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
import {
  TimelineTitleView,
  type TimelineTitleActionResolver,
} from "./TimelineTitleView.js";
import { WorkRowBody } from "./TimelineRowDetails.js";
import { useStickyBottomScroll } from "./useStickyBottomScroll.js";
import { Button } from "../primitives/ui/button.js";

export interface ThreadTimelineRowsProps {
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
  turnSummaryRowsById: Record<string, TimelineRow[]>;
}

interface TimelineRendererContextValue {
  autoExpandedRowIds: ReadonlySet<string>;
  getViewRows: GetTimelineViewRows;
  requestedTurnSummaryRowIdsRef: MutableRefObject<Set<string>>;
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
  compactActivityIntents: boolean;
  isTail: boolean;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
  spacing: TimelineRowsListSpacing;
}

interface TimelineExpandableRowViewProps {
  compactActivityIntents: boolean;
  expandableTitle: TimelineTitle;
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

interface TimelineRowTitleRenderStateArgs extends RowActivityContext {
  compactActivityIntents: boolean;
}

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
      expandableTitle: TimelineTitle;
      kind: "row-title";
      title: TimelineTitle;
    };

type TimelineRowSignaturePart = boolean | number | string | null | undefined;
type TimelineRowsListSpacing = "top-level" | "nested" | "bundle";
type TimelineRawRows = readonly TimelineRow[];
type GetTimelineViewRows = (rows: TimelineRawRows) => ThreadTimelineViewRow[];

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

function signaturePart(value: TimelineRowSignaturePart): string {
  if (value === null) return "<null>";
  if (value === undefined) return "<undefined>";
  return String(value);
}

function joinSignatureParts(parts: readonly TimelineRowSignaturePart[]): string {
  return parts.map(signaturePart).join("\u001f");
}

function activityIntentSignature(intent: TimelineActivityIntent): string {
  switch (intent.type) {
    case "read":
      return joinSignatureParts([
        intent.type,
        intent.command,
        intent.name,
        intent.path,
      ]);
    case "list_files":
      return joinSignatureParts([intent.type, intent.command, intent.path]);
    case "search":
      return joinSignatureParts([
        intent.type,
        intent.command,
        intent.query,
        intent.path,
      ]);
    case "unknown":
      return joinSignatureParts([intent.type, intent.command]);
    default:
      return assertNever(intent);
  }
}

function activityIntentsSignature(
  intents: readonly TimelineActivityIntent[],
): string {
  return intents.map(activityIntentSignature).join("\u001e");
}

function timelineRowsSignature(rows: readonly ThreadTimelineViewRow[]): string {
  return rows.map(timelineRowRenderSignature).join("\u001e");
}

function timelineRowBaseSignature(row: ThreadTimelineViewRow): string {
  // sourceSeqEnd guards high-mutation fields omitted from signatures below,
  // including output, text, and diffs. In-place row content mutations must
  // advance the source sequence to avoid stale memoized UI.
  return joinSignatureParts([
    row.kind,
    row.id,
    row.threadId,
    row.turnId,
    row.sourceSeqStart,
    row.sourceSeqEnd,
    row.startedAt,
    row.createdAt,
  ]);
}

function timelineWorkRowRenderSignature(row: TimelineViewWorkRow): string {
  const baseParts: TimelineRowSignaturePart[] = [
    timelineRowBaseSignature(row),
    row.status,
    row.workKind,
  ];

  switch (row.workKind) {
    case "command":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.command,
        row.source,
        row.exitCode,
        row.durationMs,
        row.approvalStatus,
        activityIntentsSignature(row.activityIntents),
      ]);
    case "tool":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.toolName,
        row.label,
        row.durationMs,
        row.approvalStatus,
        activityIntentsSignature(row.activityIntents),
      ]);
    case "file-change":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.approvalStatus,
        row.change.kind,
        row.change.path,
        row.change.movePath,
        row.change.diffStats.added,
        row.change.diffStats.removed,
      ]);
    case "web-search":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.queries.join("\u001e"),
      ]);
    case "web-fetch":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.url,
        row.prompt,
        row.pattern,
      ]);
    case "delegation":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.toolName,
        row.subagentType,
        row.description,
        row.durationMs,
        timelineRowsSignature(row.childRows),
      ]);
    case "approval":
      return joinSignatureParts([
        ...baseParts,
        row.interactionId,
        row.title,
        row.target.itemId,
        row.target.toolName,
      ]);
    default:
      return assertNever(row);
  }
}

function timelineRowRenderSignature(row: ThreadTimelineViewRow): string {
  const baseSignature = timelineRowBaseSignature(row);
  switch (row.kind) {
    case "conversation":
      return joinSignatureParts([
        baseSignature,
        row.role,
        row.userRequest?.kind,
        row.userRequest?.status,
        row.attachments?.localFiles,
        row.attachments?.localImages,
        row.attachments?.webImages,
      ]);
    case "system":
      return joinSignatureParts([
        baseSignature,
        row.status,
        row.systemKind,
        row.title,
        row.detail,
      ]);
    case "activity-summary":
      return joinSignatureParts([
        baseSignature,
        row.status,
        timelineRowsSignature(row.children),
      ]);
    case "turn":
      return joinSignatureParts([
        baseSignature,
        row.status,
        row.summaryCount,
        row.durationMs,
        row.children ? timelineRowsSignature(row.children) : null,
      ]);
    case "work":
      return timelineWorkRowRenderSignature(row);
    default:
      return assertNever(row);
  }
}

function timelineRowTitleRenderStateKey({
  compactActivityIntents,
  isTail,
  row,
  scopeActive,
}: TimelineRowTitleRenderStateArgs): string {
  return joinSignatureParts([
    timelineRowRenderSignature(row),
    compactActivityIntents,
    isTail,
    scopeActive,
  ]);
}

function buildTimelineRowTitleRenderState({
  compactActivityIntents,
  isTail,
  row,
  scopeActive,
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
    timelineRowTitleOptions({ isTail, row, scopeActive }),
  );
  return {
    kind: "row-title",
    title,
    expandableTitle:
      compactActivityIntents &&
      row.kind !== "conversation" &&
      row.status === "error"
        ? (buildExpandableStructuredToolTitle(row) ?? title)
        : title,
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
    previous.isTail === next.isTail &&
    previous.scopeActive === next.scopeActive &&
    previous.spacing === next.spacing &&
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
    previous.expandableTitle === next.expandableTitle &&
    previous.horizontalPadding === next.horizontalPadding &&
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

function useTimelineViewRowsCache(): GetTimelineViewRows {
  const cacheRef = useRef(new WeakMap<TimelineRawRows, ThreadTimelineViewRow[]>());
  return useCallback<GetTimelineViewRows>((rawRows) => {
    const cachedRows = cacheRef.current.get(rawRows);
    if (cachedRows) {
      return cachedRows;
    }

    const viewRows = buildTimelineViewRows(rawRows);
    cacheRef.current.set(rawRows, viewRows);
    return viewRows;
  }, []);
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
  row,
}: TimelineExpandableBodyProps) {
  const {
    onOpenLocalFileLink,
    projectId,
    resolveUserAttachmentImageSrc,
    themeType,
  } = useTimelineRendererContext();

  switch (row.kind) {
    case "activity-summary":
      return (
        <TimelineRowsList
          rows={row.children}
          scopeActive={false}
          compactActivityIntents={true}
          spacing="bundle"
        />
      );
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
          <div className="overflow-auto rounded-md border border-border/60 bg-background/40">
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
  row,
}: TurnRowBodyProps) {
  const {
    getViewRows,
    requestedTurnSummaryRowIdsRef,
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
      ? getViewRows(loadedRows)
      : null;
  const isLoading = loadingTurnSummaryIds.has(row.id);
  const isError = erroredTurnSummaryIds.has(row.id);
  const handleRetry = useCallback((): void => {
    requestedTurnSummaryRowIdsRef.current.delete(row.id);
    requestLazyTurnRows({
      onLoadTurnSummaryRows,
      requestedTurnSummaryRowIdsRef,
      row,
    });
  }, [onLoadTurnSummaryRows, requestedTurnSummaryRowIdsRef, row]);

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
        scopeActive={row.status === "pending"}
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
  compactActivityIntents,
  isTail,
  row,
  scopeActive,
  spacing,
}: TimelineRowViewProps) {
  const { onTitleAction } = useTimelineRendererContext();
  const horizontalPadding = timelineRowHorizontalPadding(spacing);
  const titleState = useTimelineRowTitleRenderState({
    compactActivityIntents,
    isTail,
    row,
    scopeActive,
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
      expandableTitle={titleState.expandableTitle}
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
  expandableTitle,
  horizontalPadding,
  row,
}: TimelineExpandableRowViewProps) {
  const {
    autoExpandedRowIds,
    requestedTurnSummaryRowIdsRef,
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
        requestedTurnSummaryRowIdsRef,
        row,
      });
    }
  }, [
    erroredTurnSummaryIds,
    loadingTurnSummaryIds,
    onLoadTurnSummaryRows,
    requestedTurnSummaryRowIdsRef,
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
      title={expandableTitle}
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
          <MemoizedTimelineRowView
            row={row}
            isTail={index === rows.length - 1}
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
  const getViewRows = useTimelineViewRowsCache();
  const rows = useMemo(
    () => getViewRows(props.timelineRows),
    [getViewRows, props.timelineRows],
  );
  const scopeActive = isRuntimeScopeActive(props.threadRuntimeDisplayStatus);
  const themeType = props.themeType ?? "light";
  const computedAutoExpandedRowIds = useMemo(
    () =>
      collectTimelineAutoExpandedRowIds({
        getViewRows,
        rows,
        scopeActive,
        turnSummaryRowsById: props.turnSummaryRowsById,
      }),
    [getViewRows, rows, scopeActive, props.turnSummaryRowsById],
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
  const rendererContextValue = useMemo<TimelineRendererContextValue>(
    () => ({
      autoExpandedRowIds,
      getViewRows,
      requestedTurnSummaryRowIdsRef,
      loadingTurnSummaryIds,
      erroredTurnSummaryIds,
      onLoadTurnSummaryRows: props.onLoadTurnSummaryRows,
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
      loadingTurnSummaryIds,
      props.onLoadTurnSummaryRows,
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
