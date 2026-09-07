import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { useLocation } from "react-router-dom";
import type {
  PromptInput,
  ThreadOriginKind,
  ThreadRuntimeDisplayStatus,
} from "@bb/domain";
import type {
  TimelineParentChange,
  TimelineRow,
  TimelineSystemOperationKind,
} from "@bb/server-contract";
import type { ThreadChatMessageReference } from "@get-bb/plugin-sdk";
import {
  activityIntentTitleGlyph,
  assertNever,
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  buildTimelineViewRows,
  createTimelineViewRowsCache,
  findActiveLatestBundleId,
  workRowGlyph,
  workRowPluginGlyph,
  workRowPresentation,
  type BuildTimelineRowTitleOptions,
  type BuildTimelineViewRowsOptions,
  type ThreadTimelineViewRow,
  type TimelineActivityIntentTitle,
  type TimelineTitle,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
} from "@bb/thread-view";
import { cn } from "@bb/shared-ui/lib/utils";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  collectTimelineAutoExpansionRowIds,
  isNonExpandableSummary,
  isRowExpandable,
} from "@bb/client-core";
import { isRunningThreadRuntimeDisplayStatus } from "@bb/client-core";
import type {
  ThreadTimelineAddToChatHandler,
  ThreadTimelineEditMessageHandler,
  ThreadTimelineInlineMessageEditor,
  ThreadTimelineForkMessageHandler,
  ThreadTimelineSendToMainMessageHandler,
  ThreadTimelineLinkHandler,
  ThreadTimelineLocalFileLinkHandler,
  ThreadTimelineOpenPluginPanelHandler,
  ThreadTimelineImageViewSrcResolver,
  ThreadTimelineConsumerMessageAction,
  ThreadTimelinePluginMessageAction,
  ThreadTimelineUnreadDividerPlacement,
  UserAttachmentImageSrcResolver,
} from "./types.js";
import { ConversationMessageContent } from "./ConversationMessageContent.js";
import {
  MessageColumnWidthContext,
  useMeasuredWidth,
} from "./MessageActionBar.js";
import { TimelineSelectionMenu } from "./TimelineSelectionMenu.js";
import type { MessageProseSelection } from "./SelectableMessageProse.js";
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
import { Button } from "@bb/shared-ui/button";
import { AutoHeightContainer } from "../../ui/height-transition.js";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { isIconName, presentationTintStyle } from "./presentation-display.js";
import { PluginCompactIconMask } from "../../plugin/PluginIcon.js";
import { usePluginIconUrl } from "@/lib/plugin-logos";
import {
  PluginTimelineRendererBody,
  isPluginRenderableWorkRow,
  usePluginTimelineRenderer,
} from "./PluginTimelineRendererBody.js";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  TimelineScrollRestoreRowIdContext,
  useBottomAnchoredScroll,
} from "@/components/ui/bottom-anchored-scroll-body.js";
import {
  collectSearchedMessageAncestorRowIds,
  readSearchMessageTarget,
  useScrollToSearchedMessage,
} from "./useScrollToSearchedMessage.js";
import {
  joinSignatureParts,
  timelineRowRenderSignature,
  timelineRowsSignature,
} from "@bb/client-core";
import {
  TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME,
  timelineRowContainmentStyle,
  useArmTopLevelTimelineRowContainment,
} from "./timeline-row-containment.js";
import { NESTED_TIMELINE_GROUP_LINE_CLASS_NAME } from "./timeline-nested-group-line.js";
import { getThreadRoutePath } from "@/lib/route-paths";
import { useThreadTimelineTurnSummaryDetails } from "@/hooks/queries/thread-queries";
import { type ThreadTimelineTurnSummaryDetailsQueryIdentity } from "@/hooks/queries/query-keys";
import {
  useSenderThreadMetadataById,
  type SenderThreadMetadata,
} from "@/hooks/useSenderThreadMetadataById";
import {
  EMPTY_PLUGIN_SLOT_SNAPSHOT,
  getPluginSlotSnapshot,
  subscribePluginSlots,
  type PluginMessageActionSlot,
} from "@/lib/plugin-slots.js";
import { runPluginMessageAction } from "@/lib/plugin-message-actions.js";
import { isPluginSideChatSenderThread } from "@/lib/side-chat-plugin.js";
import {
  buildMessageDirectiveRegistry,
  MessageDirectiveRegistryProvider,
} from "@/components/ui/markdown-message-directives.js";
import {
  TimelineWindowedItemsLoader,
  TimelineWindowingMeasurementsContext,
  TimelineWindowingScrollRootContext,
  type TimelineWindowedItemRenderState,
} from "./TimelineWindowedItemsLoader.js";

export interface ThreadTimelineRowsProps {
  timelineWindowingEnabled?: boolean;
  initialExpanded?: ReadonlySet<string>;
  canSpawnChild?: boolean;
  threadOriginKind?: ThreadOriginKind | null;
  onForkMessage?: ThreadTimelineForkMessageHandler;
  onEditMessage?: ThreadTimelineEditMessageHandler;
  inlineMessageEditor?: ThreadTimelineInlineMessageEditor;
  onMessageAddToChat?: ThreadTimelineAddToChatHandler;
  onSendToMainMessage?: ThreadTimelineSendToMainMessageHandler;
  onSelectionAddToChat?: ThreadTimelineAddToChatHandler;
  consumerMessageActions?: readonly ThreadTimelineConsumerMessageAction[];
  includePluginMessageActions?: boolean;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onOpenPluginPanel?: ThreadTimelineOpenPluginPanelHandler;
  onTitleAction?: TimelineTitleActionResolver;
  projectId?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  resolveImageViewSrc?: ThreadTimelineImageViewSrcResolver;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  hasOlderTimelineRows?: boolean;
  isLoadingOlderTimelineRows?: boolean;
  onLoadOlderRows?: () => Promise<void> | void;
  timelineRows: TimelineRow[];
  timelineNavigationTargetRowId?: string | null;
  threadId?: string;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
  unreadDividerAutoScroll?: boolean;
  unreadDividerPlacement?: ThreadTimelineUnreadDividerPlacement | null;
  workspaceRootPath: string | undefined;
}

interface TimelineRendererStaticContextValue {
  canSpawnChild: boolean;
  getViewRows: GetTimelineViewRows;
  onForkMessage: ThreadTimelineForkMessageHandler | undefined;
  onEditMessage: ThreadTimelineEditMessageHandler | undefined;
  inlineMessageEditor: ThreadTimelineInlineMessageEditor | undefined;
  onMessageAddToChat: ThreadTimelineAddToChatHandler | undefined;
  onSendToMainMessage: ThreadTimelineSendToMainMessageHandler | undefined;
  onSelectionAddToChat: ThreadTimelineAddToChatHandler | undefined;
  pluginMessageActions: readonly PluginMessageActionSlot[];
  consumerMessageActions: readonly ThreadTimelineConsumerMessageAction[];
  reportProseSelection:
    | ((
        rowId: string,
        selection: MessageProseSelection | null,
        message: ThreadChatMessageReference,
      ) => void)
    | undefined;
  threadOriginKind: ThreadOriginKind | null;
  onOpenLink: ThreadTimelineLinkHandler | undefined;
  onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler | undefined;
  onOpenPluginPanel: ThreadTimelineOpenPluginPanelHandler | undefined;
  onTitleAction: TimelineTitleActionResolver | undefined;
  projectId: string | undefined;
  resolveImageViewSrc: ThreadTimelineImageViewSrcResolver | undefined;
  resolveMentionLink: PromptMentionLinkResolver | undefined;
  resolveSegmentLinkHref: TimelineTitleLinkResolver | undefined;
  resolveUserAttachmentImageSrc: UserAttachmentImageSrcResolver | undefined;
  threadId: string | undefined;
  workspaceRootPath: string | undefined;
}

interface TimelineTurnStateContextValue {
  initialAutoExpandedRowIds: ReadonlySet<string>;
  liveAutoExpandedRowIds: ReadonlySet<string>;
  terminalAutoExpandedRowIds: ReadonlySet<string>;
}

interface TimelineRowsListProps {
  compactActivityIntents: boolean;
  hasOlderTimelineRows?: boolean;
  isLoadingOlderTimelineRows?: boolean;
  navigationTargetRowId?: string | null;
  onLoadOlderRows?: () => Promise<void> | void;
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
  spacing: TimelineRowsListSpacing;
  className?: string;
  unreadDividerAutoScroll: boolean;
  unreadDividerPlacement: ThreadTimelineUnreadDividerPlacement | null;
}

interface TimelineUnreadDividerProps {
  autoScroll: boolean;
}

interface TimelineRowViewProps {
  activeLatestBundleId: string | null;
  compactActivityIntents: boolean;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
  spacing: TimelineRowsListSpacing;
}

interface TimelineExpandableRowViewProps {
  activeLatestBundleId: string | null;
  compactActivityIntents: boolean;
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
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
  showAssistantMessageActions: boolean;
}

interface TurnRowBodyProps {
  compactActivityIntents: boolean;
  row: TimelineViewTurnRow;
  showAssistantMessageActions: boolean;
}

type LazyTurnRowBodyProps = TurnRowBodyProps;

interface TimelineSystemDetailBlockProps {
  detail: string;
  streaming: boolean;
}

interface BuildTimelineRowsListItemsArgs {
  rows: readonly ThreadTimelineViewRow[];
  unreadDividerPlacement: ThreadTimelineUnreadDividerPlacement | null;
}

interface FindUnreadDividerIndexArgs {
  rows: readonly ThreadTimelineViewRow[];
  unreadDividerPlacement: ThreadTimelineUnreadDividerPlacement | null;
}

interface IsUnreadDividerCandidateAfterCutoffArgs {
  cutoffAt: number;
  row: ThreadTimelineViewRow;
}

interface ActiveSummaryTreatmentArgs {
  activeLatestBundleId: string | null;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
}

interface TimelineRowTitleRenderStateArgs extends ActiveSummaryTreatmentArgs {
  compactActivityIntents: boolean;
}

interface TimelineRowTitleRenderStateCache {
  key: string;
  state: TimelineRowTitleRenderState;
}

interface BuildTurnSummaryDetailsIdentityArgs {
  rowSourceSeqEnd: TimelineViewTurnRow["sourceSeqEnd"];
  rowSourceSeqStart: TimelineViewTurnRow["sourceSeqStart"];
  rowThreadId: TimelineViewTurnRow["threadId"];
  rowTurnId: TimelineViewTurnRow["turnId"];
  threadId: string | undefined;
}

interface TimelineRowsOwnerKeyArgs {
  threadId: string | undefined;
  timelineRows: readonly TimelineRow[];
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
type TimelineRowsListItem =
  | {
      kind: "row";
      row: ThreadTimelineViewRow;
    }
  | {
      kind: "unread-divider";
      id: "thread-unread-divider";
    };

interface ConversationRowProps {
  row: TimelineConversationViewRow;
  showAssistantMessageActions: boolean;
}

interface ConversationRowContentProps extends ConversationRowProps {
  mobileActionDisplay: "inline" | "overflow";
  streaming: boolean;
}

const TimelineRendererStaticContext =
  createContext<TimelineRendererStaticContextValue | null>(null);
const SenderThreadMetadataContext = createContext<ReadonlyMap<
  string,
  SenderThreadMetadata
> | null>(null);
const TimelineTurnStateContext =
  createContext<TimelineTurnStateContextValue | null>(null);
const LatestActionableAssistantMessageIdContext = createContext<string | null>(
  null,
);
const LatestActionableUserMessageIdContext = createContext<string | null>(null);
const StreamingAssistantMessageIdContext = createContext<string | null>(null);
const EMPTY_ROW_ID_SET: ReadonlySet<string> = new Set<string>();
const TimelineSearchExpansionContext =
  createContext<ReadonlySet<string>>(EMPTY_ROW_ID_SET);
const TimelineWindowingEnabledContext = createContext(false);
const TIMELINE_TERMINAL_EXPANSION_RETENTION = 24;

function useTimelineRendererStaticContext(): TimelineRendererStaticContextValue {
  const context = useContext(TimelineRendererStaticContext);
  if (!context) {
    throw new Error("Thread timeline renderer context is missing");
  }
  return context;
}

function useSenderThreadMetadataContext(): ReadonlyMap<
  string,
  SenderThreadMetadata
> {
  const context = useContext(SenderThreadMetadataContext);
  if (!context) {
    throw new Error("Thread timeline sender metadata context is missing");
  }
  return context;
}

function useTimelineTurnStateContext(): TimelineTurnStateContextValue {
  const context = useContext(TimelineTurnStateContext);
  if (!context) {
    throw new Error("Thread timeline turn-state context is missing");
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
    previous.showAssistantMessageActions === next.showAssistantMessageActions &&
    previous.spacing === next.spacing &&
    previous.activeLatestBundleId === next.activeLatestBundleId &&
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
    previous.scopeActive === next.scopeActive &&
    previous.showAssistantMessageActions === next.showAssistantMessageActions &&
    previous.title === next.title &&
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

function useStableReadonlySet(
  values: ReadonlySet<string>,
): ReadonlySet<string> {
  const valuesRef = useRef(values);
  if (!areReadonlySetsEqual(valuesRef.current, values)) {
    valuesRef.current = values;
  }
  return valuesRef.current;
}

function useTimelineSearchExpansionRowIds(
  rows: readonly ThreadTimelineViewRow[],
): ReadonlySet<string> {
  const inheritedRowIds = useContext(TimelineSearchExpansionContext);
  const { threadId } = useTimelineRendererStaticContext();
  const location = useLocation();
  return useMemo(() => {
    const target = readSearchMessageTarget(location.state);
    if (target === null) {
      return inheritedRowIds;
    }
    if (
      threadId !== undefined &&
      target.threadId !== null &&
      target.threadId !== threadId
    ) {
      return inheritedRowIds;
    }
    const localRowIds = collectSearchedMessageAncestorRowIds(rows, target.seq);
    if (localRowIds.size === 0) {
      return inheritedRowIds;
    }
    const combinedRowIds = new Set<string>(inheritedRowIds);
    for (const id of localRowIds) {
      combinedRowIds.add(id);
    }
    return combinedRowIds;
  }, [inheritedRowIds, location.state, rows, threadId]);
}

function buildTurnSummaryDetailsIdentity({
  rowSourceSeqEnd,
  rowSourceSeqStart,
  rowThreadId,
  rowTurnId,
  threadId,
}: BuildTurnSummaryDetailsIdentityArgs): ThreadTimelineTurnSummaryDetailsQueryIdentity {
  return {
    sourceSeqEnd: rowSourceSeqEnd,
    sourceSeqStart: rowSourceSeqStart,
    threadId: threadId ?? rowThreadId,
    turnId: rowTurnId,
  };
}

function timelineRowsOwnerKey({
  threadId,
  timelineRows,
}: TimelineRowsOwnerKeyArgs): string {
  const ownerThreadId = threadId ?? timelineRows[0]?.threadId ?? "";
  return ownerThreadId;
}

function timelineHeightSnapRevision(rows: readonly TimelineRow[]): string {
  const firstRowId = rows[0]?.id;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "turn") {
      return joinSignatureParts([
        firstRowId,
        row.id,
        row.sourceSeqStart,
        row.sourceSeqEnd,
      ]);
    }
  }
  return joinSignatureParts([firstRowId, "active"]);
}

function useTimelineViewRowsCache(): GetTimelineViewRows {
  const cacheRef = useRef(createTimelineViewRowsCache());
  return useCallback<GetTimelineViewRows>(
    (rawRows, options) =>
      buildTimelineViewRows(rawRows, { ...options, cache: cacheRef.current }),
    [],
  );
}

function shouldRenderCompactActivityIntentRows(
  row: ThreadTimelineViewRow,
): row is Extract<TimelineViewWorkRow, { workKind: "command" }> {
  return (
    row.kind === "work" &&
    row.workKind === "command" &&
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
}: ActiveSummaryTreatmentArgs): BuildTimelineRowTitleOptions {
  const useActiveBundleLabel = isActiveLatestBundleSummary({
    activeLatestBundleId,
    row,
    scopeActive,
  });
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
    case "nested":
      return "gap-2";
    case "bundle":
      return "gap-0";
  }
}

function isForkSeedAnchorRow(row: TimelineConversationViewRow): boolean {
  return (
    row.role === "user" &&
    row.initiator === "agent" &&
    row.senderThreadId !== null &&
    row.turnId === null
  );
}

function findLastActionableAssistantMessageId(
  rows: readonly ThreadTimelineViewRow[],
): string | null {
  let lastMessageId: string | null = null;

  const visitRows = (candidateRows: readonly ThreadTimelineViewRow[]): void => {
    for (const row of candidateRows) {
      if (row.kind === "conversation") {
        if (row.role === "assistant") {
          lastMessageId = row.id;
        }
        continue;
      }

      if (
        row.kind === "turn" &&
        row.status === "pending" &&
        row.children !== null
      ) {
        visitRows(row.children);
      }
    }
  };

  visitRows(rows);
  return lastMessageId;
}

export function findStreamingAssistantMessageId(
  rows: readonly ThreadTimelineViewRow[],
): string | null {
  let candidateRows: readonly ThreadTimelineViewRow[] = rows;
  for (;;) {
    const lastRow = candidateRows[candidateRows.length - 1];
    if (lastRow === undefined) {
      return null;
    }
    if (lastRow.kind === "conversation") {
      return lastRow.role === "assistant" ? lastRow.id : null;
    }
    if (
      lastRow.kind === "turn" &&
      lastRow.status === "pending" &&
      lastRow.children !== null
    ) {
      candidateRows = lastRow.children;
      continue;
    }
    if (
      lastRow.kind === "work" &&
      lastRow.workKind === "delegation" &&
      lastRow.status === "pending"
    ) {
      candidateRows = lastRow.childRows;
      continue;
    }
    return null;
  }
}

function findLastActionableUserMessageId(
  rows: readonly ThreadTimelineViewRow[],
  canAddAttachments: boolean,
): string | null {
  let lastMessageId: string | null = null;

  const visitRows = (candidateRows: readonly ThreadTimelineViewRow[]): void => {
    for (const row of candidateRows) {
      if (row.kind === "conversation") {
        const hasReusableAttachment =
          row.role === "user" &&
          ((row.attachments?.localFilePaths.length ?? 0) > 0 ||
            (row.attachments?.localImagePaths.length ?? 0) > 0);
        if (
          row.role === "user" &&
          row.initiator === "user" &&
          (row.text.trim().length > 0 ||
            (canAddAttachments && hasReusableAttachment))
        ) {
          lastMessageId = row.id;
        }
        continue;
      }

      if (
        row.kind === "turn" &&
        row.status === "pending" &&
        row.children !== null
      ) {
        visitRows(row.children);
      }
    }
  };

  visitRows(rows);
  return lastMessageId;
}

const EMPTY_CONSUMER_MESSAGE_ACTIONS: readonly ThreadTimelineConsumerMessageAction[] =
  [];

function buildRowPluginMessageActions(args: {
  slots: readonly PluginMessageActionSlot[];
  timelineThreadId: string | undefined;
  message: ThreadChatMessageReference;
  openThreadPanel: ThreadTimelineOpenPluginPanelHandler | undefined;
}): readonly ThreadTimelinePluginMessageAction[] | undefined {
  const { slots, timelineThreadId, message, openThreadPanel } = args;
  if (timelineThreadId === undefined || slots.length === 0) {
    return undefined;
  }
  return slots.map((slot) => ({
    key: `${slot.pluginId}/${slot.id}/${slot.generation}`,
    pluginId: slot.pluginId,
    icon: slot.icon ?? null,
    label: slot.title,
    onSelect: () =>
      runPluginMessageAction({
        slot,
        threadId: timelineThreadId,
        message,
        openThreadPanel,
      }),
  }));
}

function buildRowConsumerMessageActions(args: {
  actions: readonly ThreadTimelineConsumerMessageAction[];
  message: ThreadChatMessageReference;
}): readonly ThreadTimelinePluginMessageAction[] {
  const { actions, message } = args;
  return actions
    .filter(
      (action) =>
        action.roles === undefined || action.roles.includes(message.role),
    )
    .map((action) => ({
      key: `consumer/${action.id}`,
      pluginId: action.pluginId,
      icon: action.icon,
      label: action.label,
      onSelect: () => {
        const warn = (error: unknown) => {
          console.warn(
            `ThreadChat messageAction "${action.id}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        };
        try {
          const result = action.run(message);
          if (result instanceof Promise) {
            result.catch(warn);
          }
        } catch (error) {
          warn(error);
        }
      },
    }));
}

function ConversationRow({
  row,
  showAssistantMessageActions,
}: ConversationRowProps) {
  const latestActionableAssistantMessageId = useContext(
    LatestActionableAssistantMessageIdContext,
  );
  const latestActionableUserMessageId = useContext(
    LatestActionableUserMessageIdContext,
  );
  const streamingAssistantMessageId = useContext(
    StreamingAssistantMessageIdContext,
  );
  const latestActionableMessageId =
    row.role === "user"
      ? latestActionableUserMessageId
      : latestActionableAssistantMessageId;
  return (
    <ConversationRowContent
      row={row}
      showAssistantMessageActions={showAssistantMessageActions}
      mobileActionDisplay={
        row.id === latestActionableMessageId ? "inline" : "overflow"
      }
      streaming={
        row.role === "assistant" && row.id === streamingAssistantMessageId
      }
    />
  );
}

function InlineMessageEditorHost({
  editor,
}: {
  editor: ThreadTimelineInlineMessageEditor;
}) {
  return (
    <div className="ml-auto w-full max-w-[70%] max-md:max-w-full">
      <div
        ref={editor.onHostElementChange}
        data-sent-message-inline-editor-host=""
      />
    </div>
  );
}

const ConversationRowContent = memo(function ConversationRowContent({
  row,
  showAssistantMessageActions,
  mobileActionDisplay,
  streaming,
}: ConversationRowContentProps) {
  const {
    canSpawnChild,
    inlineMessageEditor,
    onEditMessage,
    onForkMessage,
    onMessageAddToChat,
    onSendToMainMessage,
    onSelectionAddToChat,
    pluginMessageActions,
    consumerMessageActions,
    reportProseSelection,
    threadOriginKind,
    onOpenLink,
    onOpenLocalFileLink,
    onOpenPluginPanel,
    onTitleAction,
    projectId,
    resolveMentionLink,
    resolveSegmentLinkHref,
    resolveUserAttachmentImageSrc,
    threadId,
    workspaceRootPath,
  } = useTimelineRendererStaticContext();
  const senderThreadMetadataById = useSenderThreadMetadataContext();
  if (
    row.role === "user" &&
    inlineMessageEditor !== undefined &&
    inlineMessageEditor.messageId === row.id
  ) {
    return <InlineMessageEditorHost editor={inlineMessageEditor} />;
  }
  const messageReference: ThreadChatMessageReference = {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    text: row.text,
    sourceSeqEnd: row.sourceSeqEnd,
  };
  const rowSlotActions = buildRowPluginMessageActions({
    slots: pluginMessageActions,
    timelineThreadId: threadId,
    message: messageReference,
    openThreadPanel: onOpenPluginPanel,
  });
  const rowConsumerActions =
    consumerMessageActions.length === 0
      ? []
      : buildRowConsumerMessageActions({
          actions: consumerMessageActions,
          message: messageReference,
        });
  const rowPluginActions =
    rowConsumerActions.length === 0
      ? rowSlotActions
      : [...(rowSlotActions ?? []), ...rowConsumerActions];
  if (row.role === "user") {
    const senderThreadMetadata =
      row.senderThreadId === null
        ? null
        : (senderThreadMetadataById.get(row.senderThreadId) ?? null);
    const originKind = isForkSeedAnchorRow(row) ? threadOriginKind : null;
    const canEditMessage =
      onEditMessage !== undefined &&
      row.initiator === "user" &&
      !row.turnRequest.isGrouped &&
      row.turnRequest.kind === "message" &&
      row.turnRequest.status === "accepted" &&
      (row.attachments?.imageUrls.length ?? 0) === 0;
    const onEdit = canEditMessage
      ? () => {
          const input: PromptInput[] = [];
          if (row.text.trim().length > 0) {
            input.push({
              type: "text",
              text: row.text,
              mentions: [...row.mentions],
            });
          }
          for (const path of row.attachments?.localImagePaths ?? []) {
            input.push({ type: "localImage", path });
          }
          for (const path of row.attachments?.localFilePaths ?? []) {
            input.push({ type: "localFile", path });
          }
          onEditMessage({
            messageId: row.id,
            expectedRequestSequence: row.sourceSeqStart,
            input,
          });
        }
      : undefined;
    return (
      <ConversationMessageContent
        attachments={row.attachments}
        originKind={originKind}
        initiator={row.initiator}
        mentions={row.mentions}
        mobileActionDisplay={mobileActionDisplay}
        onAddToChat={onSelectionAddToChat}
        onEdit={onEdit}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveMentionLink={resolveMentionLink}
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        role="user"
        resolveSegmentLinkHref={resolveSegmentLinkHref}
        onTitleAction={onTitleAction}
        senderThreadId={row.senderThreadId}
        senderThreadProjectId={senderThreadMetadata?.projectId}
        senderThreadTitle={senderThreadMetadata?.title ?? null}
        senderIsPluginSideChat={isPluginSideChatSenderThread(
          senderThreadMetadata,
        )}
        systemMessageKind={row.systemMessageKind}
        systemMessageSubject={row.systemMessageSubject}
        pluginActions={rowPluginActions}
        text={row.text}
        turnRequest={row.turnRequest}
      />
    );
  }
  const onFork =
    onForkMessage === undefined
      ? undefined
      : () => onForkMessage({ sourceSeqEnd: row.sourceSeqEnd });
  const onSendToMain =
    onSendToMainMessage === undefined
      ? undefined
      : () => onSendToMainMessage({ messageText: row.text });
  const onSelectProse =
    reportProseSelection === undefined
      ? undefined
      : (selection: MessageProseSelection | null) =>
          reportProseSelection(
            row.id,
            selection === null
              ? null
              : { ...selection, sourceSeqEnd: row.sourceSeqEnd },
            messageReference,
          );
  return (
    <ConversationMessageContent
      attachments={row.attachments}
      id={row.id}
      onAddToChat={onMessageAddToChat}
      onFork={onFork}
      onSendToMain={onSendToMain}
      forkDisabled={!canSpawnChild}
      onSelectProse={onSelectProse}
      onOpenLink={onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      onOpenPluginPanel={onOpenPluginPanel}
      pluginActions={rowPluginActions}
      projectId={projectId}
      resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
      role="assistant"
      showActions={showAssistantMessageActions}
      mobileActionDisplay={mobileActionDisplay}
      streaming={streaming}
      text={row.text}
      threadId={row.threadId}
      turnId={row.turnId}
      workspaceRootPath={workspaceRootPath}
    />
  );
});

function TimelineUnreadDivider({ autoScroll }: TimelineUnreadDividerProps) {
  const bottomAnchor = useBottomAnchoredScroll();
  const dividerRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);

  useEffect(() => {
    if (!autoScroll || !bottomAnchor || hasScrolledRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const divider = dividerRef.current;
      if (!divider) {
        return;
      }

      hasScrolledRef.current = true;
      bottomAnchor.scrollElementIntoViewClampedToMaxScroll({
        element: divider,
      });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [autoScroll, bottomAnchor]);

  return (
    <div
      ref={dividerRef}
      role="separator"
      aria-label="New messages"
      className={cn(
        "flex items-center gap-2 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-timeline-accent",
      )}
      data-testid="thread-unread-divider"
    >
      <span className="shrink-0">New</span>
      <span className="h-px min-w-0 flex-1 bg-timeline-accent" aria-hidden />
    </div>
  );
}

function TimelineSystemDetailBlock({
  detail,
  streaming,
}: TimelineSystemDetailBlockProps) {
  return (
    <TimelineDetailScroll
      size="base"
      streaming={streaming}
      contentKey={detail}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-tight text-subtle-foreground opacity-70">
        {detail}
      </pre>
    </TimelineDetailScroll>
  );
}

function TimelineExpandableBody({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  showAssistantMessageActions,
}: TimelineExpandableBodyProps) {
  const {
    onOpenLink,
    onOpenLocalFileLink,
    projectId,
    resolveUserAttachmentImageSrc,
    workspaceRootPath,
    resolveImageViewSrc,
  } = useTimelineRendererStaticContext();

  switch (row.kind) {
    case "bundle-summary":
    case "step-summary": {
      const list = (
        <TimelineRowsList
          rows={row.children}
          scopeActive={false}
          showAssistantMessageActions={showAssistantMessageActions}
          compactActivityIntents={true}
          spacing="bundle"
          unreadDividerAutoScroll={false}
          unreadDividerPlacement={null}
        />
      );
      if (!isNonExpandableSummary(row.children)) {
        return list;
      }
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
          showAssistantMessageActions={
            showAssistantMessageActions && row.status === "pending"
          }
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
            className={NESTED_TIMELINE_GROUP_LINE_CLASS_NAME}
          >
            <div className="flex flex-col gap-3">
              {row.childRows.length > 0 ? (
                <TimelineRowsList
                  rows={row.childRows}
                  scopeActive={delegationActive}
                  showAssistantMessageActions={false}
                  compactActivityIntents={false}
                  spacing="nested"
                  unreadDividerAutoScroll={false}
                  unreadDividerPlacement={null}
                />
              ) : null}
              {row.output.trim().length > 0 ? (
                <ConversationMessageContent
                  attachments={null}
                  id={row.id}
                  onOpenLink={onOpenLink}
                  onOpenLocalFileLink={onOpenLocalFileLink}
                  projectId={projectId}
                  resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
                  role="assistant"
                  showActions={false}
                  mobileActionDisplay="overflow"
                  streaming={delegationActive}
                  text={row.output}
                  threadId={row.threadId}
                  turnId={row.turnId}
                  workspaceRootPath={workspaceRootPath}
                />
              ) : null}
            </div>
          </TimelineDetailScroll>
        );
      }
      return (
        <WorkRowBodyWithPluginRenderer
          row={row}
          resolveImageViewSrc={resolveImageViewSrc}
          workspaceRootPath={workspaceRootPath}
        />
      );
    case "system":
      return row.detail ? (
        <TimelineSystemDetailBlock
          detail={row.detail}
          streaming={row.status === "pending"}
        />
      ) : null;
    case "conversation":
      return null;
    default:
      return assertNever(row);
  }
}

function WorkRowBodyWithPluginRenderer({
  row,
  resolveImageViewSrc,
  workspaceRootPath,
}: {
  row: TimelineViewWorkRow;
  resolveImageViewSrc: ThreadTimelineImageViewSrcResolver | undefined;
  workspaceRootPath: string | undefined;
}) {
  const slot = usePluginTimelineRenderer(row);
  const original = useCallback(
    () => (
      <WorkRowBody
        row={row}
        resolveImageViewSrc={resolveImageViewSrc}
        workspaceRootPath={workspaceRootPath}
      />
    ),
    [resolveImageViewSrc, row, workspaceRootPath],
  );
  if (slot !== null && isPluginRenderableWorkRow(row)) {
    return (
      <PluginTimelineRendererBody row={row} slot={slot} original={original} />
    );
  }
  return original();
}

function TurnRowBody({
  compactActivityIntents,
  row,
  showAssistantMessageActions,
}: TurnRowBodyProps) {
  if (row.children === null) {
    return (
      <LazyTurnRowBody
        compactActivityIntents={compactActivityIntents}
        row={row}
        showAssistantMessageActions={showAssistantMessageActions}
      />
    );
  }

  return (
    <TimelineRowsList
      rows={row.children}
      scopeActive={false}
      showAssistantMessageActions={showAssistantMessageActions}
      compactActivityIntents={compactActivityIntents}
      spacing="nested"
      className={NESTED_TIMELINE_GROUP_LINE_CLASS_NAME}
      unreadDividerAutoScroll={false}
      unreadDividerPlacement={null}
    />
  );
}

function LazyTurnRowBody({
  compactActivityIntents,
  row,
  showAssistantMessageActions,
}: LazyTurnRowBodyProps) {
  const { getViewRows, threadId } = useTimelineRendererStaticContext();
  const {
    sourceSeqEnd: rowSourceSeqEnd,
    sourceSeqStart: rowSourceSeqStart,
    threadId: rowThreadId,
    turnId: rowTurnId,
  } = row;
  const identity = useMemo<ThreadTimelineTurnSummaryDetailsQueryIdentity>(
    () =>
      buildTurnSummaryDetailsIdentity({
        rowSourceSeqEnd,
        rowSourceSeqStart,
        rowThreadId,
        rowTurnId,
        threadId,
      }),
    [rowSourceSeqEnd, rowSourceSeqStart, rowThreadId, rowTurnId, threadId],
  );
  const {
    data: detail,
    isError,
    refetch,
  } = useThreadTimelineTurnSummaryDetails(identity);
  const handleRetry = useCallback((): void => {
    void refetch();
  }, [refetch]);
  const rows = detail ? getViewRows(detail.rows, { closedScope: true }) : null;

  if (!rows && isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive-text">
        <span>Failed to load turn details.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRetry}
          className="h-7 cursor-pointer border-destructive px-2 text-destructive hover:text-destructive"
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
        showAssistantMessageActions={showAssistantMessageActions}
        compactActivityIntents={compactActivityIntents}
        spacing="nested"
        className={NESTED_TIMELINE_GROUP_LINE_CLASS_NAME}
        unreadDividerAutoScroll={false}
        unreadDividerPlacement={null}
      />
    );
  }
  return (
    <div className="text-sm text-muted-foreground">Loading turn details...</div>
  );
}

export const PAST_ROW_DIM_CLASS_NAME = "opacity-40";

export function pastRowDimClassName({
  activeLatestBundleId,
  row,
  scopeActive,
}: ActiveSummaryTreatmentArgs): string | undefined {
  if (
    row.kind === "bundle-summary" &&
    isActiveLatestBundleSummary({ activeLatestBundleId, row, scopeActive })
  ) {
    return undefined;
  }
  switch (row.kind) {
    case "work":
    case "system":
    case "turn":
    case "bundle-summary":
    case "step-summary":
      return row.status === "completed" ? PAST_ROW_DIM_CLASS_NAME : undefined;
    case "conversation":
      return undefined;
    default:
      return undefined;
  }
}

function leadingIconForWorkRow(
  row: ThreadTimelineViewRow,
): IconName | undefined {
  if (row.kind !== "work") {
    return undefined;
  }
  return workRowGlyph(row, isIconName);
}

export function systemOperationLeadingIcon(
  operationKind: TimelineSystemOperationKind,
  parentChangeAction: TimelineParentChange["action"] | null,
): IconName | undefined {
  switch (operationKind) {
    case "parent-change":
      return parentChangeAction === "release" ? "UserRound" : "UserRoundPlus";
    case "thread-provisioning":
      return "Terminal";
    case "thread-interrupted":
      return "AlertCircle";
    case "compaction":
      return "CircleArrowShrink";
    case "context-clear":
      return "Clean";
    case "generic":
    case "warning":
    case "deprecation":
    case "provider-unhandled":
      return undefined;
    default:
      return assertNever(operationKind);
  }
}

function leadingIconForSystemRow(
  row: ThreadTimelineViewRow,
): IconName | undefined {
  if (row.kind !== "system" || row.systemKind !== "operation") {
    return undefined;
  }
  return systemOperationLeadingIcon(
    row.operationKind,
    row.operationKind === "parent-change" ? row.parentChange.action : null,
  );
}

function leadingIconForRow(row: ThreadTimelineViewRow): IconName | undefined {
  return leadingIconForWorkRow(row) ?? leadingIconForSystemRow(row);
}

function leadingIconStyleForRow(
  row: ThreadTimelineViewRow,
): CSSProperties | undefined {
  if (row.kind !== "work") {
    return undefined;
  }
  return presentationTintStyle(workRowPresentation(row));
}

function useLeadingIconUrlForRow(
  row: ThreadTimelineViewRow,
): string | undefined {
  return usePluginIconUrl(
    row.kind === "work" ? workRowPluginGlyph(row) : undefined,
  );
}

function TimelineRowView({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  scopeActive,
  showAssistantMessageActions,
  spacing,
}: TimelineRowViewProps) {
  const horizontalPadding = timelineRowHorizontalPadding(spacing);
  const { onTitleAction, resolveSegmentLinkHref } =
    useTimelineRendererStaticContext();
  const titleState = useTimelineRowTitleRenderState({
    activeLatestBundleId,
    compactActivityIntents,
    row,
    scopeActive,
  });
  const pluginRendererSlot = usePluginTimelineRenderer(
    row.kind === "work" ? row : null,
  );
  const staticLeadingIconUrl = useLeadingIconUrlForRow(row);

  if (row.kind === "conversation") {
    return (
      <ConversationRow
        row={row}
        showAssistantMessageActions={showAssistantMessageActions}
      />
    );
  }

  if (titleState.kind === "compact-activity-intents") {
    return (
      <>
        {titleState.titles.map((entry) => (
          <TimelineStaticRow
            key={entry.id}
            horizontalPadding={horizontalPadding}
            className={pastRowDimClassName({
              activeLatestBundleId,
              row,
              scopeActive,
            })}
          >
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
              <Icon
                name={activityIntentTitleGlyph(entry)}
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <TimelineTitleView
                title={entry.title}
                onTitleAction={onTitleAction}
                resolveSegmentLinkHref={resolveSegmentLinkHref}
              />
            </span>
          </TimelineStaticRow>
        ))}
      </>
    );
  }

  if (!isRowExpandable(row) && pluginRendererSlot === null) {
    const staticLeadingIcon = leadingIconForRow(row);
    const staticLeadingIconStyle = leadingIconStyleForRow(row);
    return (
      <TimelineStaticRow
        horizontalPadding={horizontalPadding}
        className={pastRowDimClassName({
          activeLatestBundleId,
          row,
          scopeActive,
        })}
      >
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
          {staticLeadingIconUrl !== undefined ? (
            <PluginCompactIconMask
              url={staticLeadingIconUrl}
              className="size-3.5 text-muted-foreground"
              style={staticLeadingIconStyle}
            />
          ) : staticLeadingIcon ? (
            <Icon
              name={staticLeadingIcon}
              className="size-3.5 shrink-0 text-muted-foreground"
              style={staticLeadingIconStyle}
              aria-hidden
            />
          ) : null}
          <TimelineTitleView
            title={titleState.title}
            onTitleAction={onTitleAction}
            resolveSegmentLinkHref={resolveSegmentLinkHref}
          />
        </span>
      </TimelineStaticRow>
    );
  }

  return (
    <MemoizedTimelineExpandableRowView
      activeLatestBundleId={activeLatestBundleId}
      row={row}
      scopeActive={scopeActive}
      showAssistantMessageActions={showAssistantMessageActions}
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
  scopeActive,
  showAssistantMessageActions,
  title,
  horizontalPadding,
  row,
}: TimelineExpandableRowViewProps) {
  const { onTitleAction, resolveSegmentLinkHref } =
    useTimelineRendererStaticContext();
  const {
    initialAutoExpandedRowIds,
    liveAutoExpandedRowIds,
    terminalAutoExpandedRowIds,
  } = useTimelineTurnStateContext();
  const searchExpandedRowIds = useContext(TimelineSearchExpansionContext);
  const renderBody = useCallback(
    () => (
      <TimelineExpandableBody
        activeLatestBundleId={activeLatestBundleId}
        row={row}
        compactActivityIntents={compactActivityIntents}
        showAssistantMessageActions={showAssistantMessageActions}
      />
    ),
    [
      activeLatestBundleId,
      compactActivityIntents,
      row,
      showAssistantMessageActions,
    ],
  );

  const leadingIcon = leadingIconForRow(row);
  const leadingIconUrl = useLeadingIconUrlForRow(row);
  const leadingIconStyle = leadingIconStyleForRow(row);

  return (
    <ExpandableTimelineRow
      title={title}
      summaryClassName={pastRowDimClassName({
        activeLatestBundleId,
        row,
        scopeActive,
      })}
      horizontalPadding={horizontalPadding}
      leadingIcon={leadingIcon}
      leadingIconUrl={leadingIconUrl}
      leadingIconStyle={leadingIconStyle}
      autoExpanded={
        liveAutoExpandedRowIds.has(row.id) ||
        initialAutoExpandedRowIds.has(row.id)
      }
      forceExpanded={searchExpandedRowIds.has(row.id)}
      terminalAutoExpanded={terminalAutoExpandedRowIds.has(row.id)}
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

function findUnreadDividerIndex({
  rows,
  unreadDividerPlacement,
}: FindUnreadDividerIndexArgs): number {
  if (unreadDividerPlacement === null) {
    return -1;
  }

  switch (unreadDividerPlacement.kind) {
    case "before-first":
      return rows.length > 0 ? 0 : -1;
    case "after-cutoff":
      return rows.findIndex((row) =>
        isUnreadDividerCandidateAfterCutoff({
          cutoffAt: unreadDividerPlacement.cutoffAt,
          row,
        }),
      );
    default:
      assertNever(unreadDividerPlacement);
  }
}

function isUserAuthoredConversationRow(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.initiator === "user"
  );
}

function isUnreadDividerCandidateAfterCutoff({
  cutoffAt,
  row,
}: IsUnreadDividerCandidateAfterCutoffArgs): boolean {
  if (row.createdAt <= cutoffAt) {
    return false;
  }

  return !isUserAuthoredConversationRow(row);
}

function buildTimelineRowsListItems({
  rows,
  unreadDividerPlacement,
}: BuildTimelineRowsListItemsArgs): TimelineRowsListItem[] {
  const items: TimelineRowsListItem[] = [];
  const dividerIndex = findUnreadDividerIndex({
    rows,
    unreadDividerPlacement,
  });

  for (const [index, row] of rows.entries()) {
    if (index === dividerIndex) {
      items.push({ kind: "unread-divider", id: "thread-unread-divider" });
    }
    items.push({ kind: "row", row });
  }

  return items;
}

function TimelineRowItemWrapper({
  children,
  row,
  spacing,
  windowedState,
}: {
  children: ReactNode;
  row: ThreadTimelineViewRow;
  spacing: TimelineRowsListSpacing;
  windowedState: TimelineWindowedItemRenderState;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const composedRef = useComposedRefs(wrapperRef, windowedState.itemRef);
  const isTopLevel = spacing === "top-level";
  useArmTopLevelTimelineRowContainment(
    wrapperRef,
    isTopLevel && !windowedState.windowingEnabled,
  );
  return (
    <div
      ref={composedRef}
      data-timeline-row-id={row.id}
      data-timeline-window-key={row.id}
      data-index={windowedState.itemIndex}
      data-timeline-windowed-realized={
        windowedState.windowingEnabled
          ? String(windowedState.isRealized)
          : undefined
      }
      className={
        isTopLevel && !windowedState.windowingEnabled
          ? TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME
          : undefined
      }
      style={
        windowedState.itemStyle ??
        (isTopLevel && !windowedState.windowingEnabled
          ? timelineRowContainmentStyle(row)
          : undefined)
      }
    >
      {children}
    </div>
  );
}

function estimateTimelineWindowedRowHeight(
  row: ThreadTimelineViewRow,
  spacing: TimelineRowsListSpacing,
): number {
  if (row.kind !== "conversation") {
    return spacing === "top-level" ? 20 : spacing === "bundle" ? 24 : 28;
  }
  const charsPerLine =
    spacing === "top-level" ? (row.role === "user" ? 76 : 95) : 64;
  let lineCount = Math.max(1, Math.ceil(row.text.length / charsPerLine));
  if (row.role === "user") {
    lineCount = Math.min(lineCount, 15);
    return 50 + lineCount * 23;
  }
  return 20 + lineCount * 23;
}

function TimelineRowsList({
  compactActivityIntents,
  hasOlderTimelineRows,
  isLoadingOlderTimelineRows,
  navigationTargetRowId,
  onLoadOlderRows,
  rows,
  scopeActive,
  showAssistantMessageActions,
  spacing,
  className,
  unreadDividerAutoScroll,
  unreadDividerPlacement,
}: TimelineRowsListProps) {
  const { threadId } = useTimelineRendererStaticContext();
  const isCompactViewport = useIsCompactViewport();
  const bottomAnchor = useBottomAnchoredScroll();
  const scrollRestoreRowId = useContext(TimelineScrollRestoreRowIdContext);
  const detailScrollRoot = useContext(TimelineWindowingScrollRootContext);
  const timelineWindowingEnabled = useContext(TimelineWindowingEnabledContext);
  const inheritedMeasurements = useContext(
    TimelineWindowingMeasurementsContext,
  );
  const [standaloneMeasurements] = useState(() => new Map<string, number>());
  const measurements = inheritedMeasurements ?? standaloneMeasurements;
  const searchExpandedRowIds = useTimelineSearchExpansionRowIds(rows);
  const stableSearchExpandedRowIds = useStableReadonlySet(searchExpandedRowIds);
  useScrollToSearchedMessage(rows, threadId, {
    hasOlderRows: hasOlderTimelineRows,
    isLoadingOlderRows: isLoadingOlderTimelineRows,
    onLoadOlderRows,
  });
  const activeLatestBundleId = useMemo(
    () => findActiveLatestBundleId(rows),
    [rows],
  );
  const items = useMemo(
    () => buildTimelineRowsListItems({ rows, unreadDividerPlacement }),
    [rows, unreadDividerPlacement],
  );
  const itemKeys = useMemo(
    () =>
      items.map((item) =>
        item.kind === "row" ? item.row.id : `divider:${item.id}`,
      ),
    [items],
  );
  const alwaysMountedKeys = useMemo(() => {
    const keys = new Set<string>();
    const lastRow = rows.at(-1);
    if (lastRow !== undefined) {
      keys.add(lastRow.id);
    }
    for (const item of items) {
      if (item.kind === "unread-divider") {
        keys.add(`divider:${item.id}`);
      }
    }
    for (const rowId of stableSearchExpandedRowIds) {
      keys.add(rowId);
    }
    if (spacing === "top-level" && scrollRestoreRowId !== null) {
      keys.add(scrollRestoreRowId);
    }
    if (
      spacing === "top-level" &&
      timelineWindowingEnabled &&
      navigationTargetRowId != null
    ) {
      keys.add(navigationTargetRowId);
    }
    return keys;
  }, [
    items,
    rows,
    scrollRestoreRowId,
    spacing,
    stableSearchExpandedRowIds,
    navigationTargetRowId,
    timelineWindowingEnabled,
  ]);
  const getWindowingScrollElement =
    detailScrollRoot?.getScrollElement ??
    bottomAnchor?.getScrollElement ??
    null;
  const isTopLevelList = spacing === "top-level";
  const { measureRef: messageColumnWidthSourceRef, width: messageColumnWidth } =
    useMeasuredWidth({ enabled: isTopLevelList });
  const messageColumnWidthValue = useMemo(
    () => ({ width: messageColumnWidth }),
    [messageColumnWidth],
  );
  return (
    <TimelineSearchExpansionContext.Provider value={stableSearchExpandedRowIds}>
      <MessageColumnWidthContext.Provider
        value={isTopLevelList ? messageColumnWidthValue : null}
      >
        <div
          ref={isTopLevelList ? messageColumnWidthSourceRef : undefined}
          className={cn(
            "flex min-w-0 flex-col [&_button:not(:disabled)]:cursor-pointer",
            timelineRowsListGapClassName(spacing),
            className,
          )}
          data-timeline-row-list={spacing}
        >
          <TimelineWindowedItemsLoader
            enabled={timelineWindowingEnabled}
            alwaysMountedKeys={alwaysMountedKeys}
            estimateItemHeight={(index) => {
              const item = items[index];
              return item?.kind === "row"
                ? estimateTimelineWindowedRowHeight(item.row, spacing)
                : 28;
            }}
            gap={spacing === "bundle" ? 0 : 8}
            getScrollElement={getWindowingScrollElement}
            itemKeys={itemKeys}
            measurements={measurements}
            minItemCount={
              spacing === "top-level" ? (isCompactViewport ? 40 : 60) : 20
            }
            renderItem={(index, windowedState) => {
              const item = items[index];
              if (item === undefined) {
                return null;
              }
              if (item.kind === "unread-divider") {
                return (
                  <div
                    key={item.id}
                    ref={windowedState.itemRef}
                    data-index={windowedState.itemIndex}
                    data-timeline-window-key={`divider:${item.id}`}
                    data-timeline-windowed-realized={
                      windowedState.windowingEnabled
                        ? String(windowedState.isRealized)
                        : undefined
                    }
                    style={windowedState.itemStyle}
                  >
                    {windowedState.isRealized ? (
                      <TimelineUnreadDivider
                        autoScroll={unreadDividerAutoScroll}
                      />
                    ) : null}
                  </div>
                );
              }
              return (
                <TimelineRowItemWrapper
                  key={item.row.id}
                  row={item.row}
                  spacing={spacing}
                  windowedState={windowedState}
                >
                  {windowedState.isRealized ? (
                    <MemoizedTimelineRowView
                      activeLatestBundleId={activeLatestBundleId}
                      row={item.row}
                      scopeActive={scopeActive}
                      showAssistantMessageActions={showAssistantMessageActions}
                      spacing={spacing}
                      compactActivityIntents={compactActivityIntents}
                    />
                  ) : null}
                </TimelineRowItemWrapper>
              );
            }}
          />
        </div>
      </MessageColumnWidthContext.Provider>
    </TimelineSearchExpansionContext.Provider>
  );
}

function ThreadTimelineRowsComponent(props: ThreadTimelineRowsProps) {
  const ownerKey = timelineRowsOwnerKey({
    threadId: props.threadId,
    timelineRows: props.timelineRows,
  });
  return <ThreadTimelineRowsForTimelineView key={ownerKey} {...props} />;
}

function ThreadTimelineRowsForTimelineView(props: ThreadTimelineRowsProps) {
  const getViewRows = useTimelineViewRowsCache();
  const [windowingMeasurements] = useState(() => new Map<string, number>());
  const rows = useMemo(
    () => getViewRows(props.timelineRows),
    [getViewRows, props.timelineRows],
  );
  const heightSnapRevision = timelineHeightSnapRevision(props.timelineRows);
  const latestActionableAssistantMessageId = useMemo(
    () => findLastActionableAssistantMessageId(rows),
    [rows],
  );
  const latestActionableUserMessageId = useMemo(
    () =>
      findLastActionableUserMessageId(
        rows,
        props.onSelectionAddToChat !== undefined ||
          props.onEditMessage !== undefined,
      ),
    [props.onEditMessage, props.onSelectionAddToChat, rows],
  );
  const scopeActive = isRunningThreadRuntimeDisplayStatus(
    props.threadRuntimeDisplayStatus,
  );
  const streamingAssistantMessageId = useMemo(
    () => (scopeActive ? findStreamingAssistantMessageId(rows) : null),
    [rows, scopeActive],
  );
  const computedAutoExpansionRowIds = useMemo(
    () => collectTimelineAutoExpansionRowIds({ rows, scopeActive }),
    [rows, scopeActive],
  );
  const liveAutoExpandedRowIds = useStableReadonlySet(
    computedAutoExpansionRowIds.liveExpandedRowIds,
  );
  const accumulatedTerminalRowIdsRef = useRef(new Set<string>());
  const accumulatedTerminalRowIds = useMemo(() => {
    const accumulated = accumulatedTerminalRowIdsRef.current;
    for (const id of computedAutoExpansionRowIds.terminalFrontierRowIds) {
      accumulated.delete(id);
      accumulated.add(id);
    }
    while (accumulated.size > TIMELINE_TERMINAL_EXPANSION_RETENTION) {
      const oldestId = accumulated.values().next().value;
      if (oldestId === undefined) {
        break;
      }
      accumulated.delete(oldestId);
    }
    return new Set(accumulated);
  }, [computedAutoExpansionRowIds.terminalFrontierRowIds]);
  const terminalAutoExpandedRowIds = useStableReadonlySet(
    accumulatedTerminalRowIds,
  );
  const initialAutoExpandedRowIds = useStableReadonlySet(
    props.initialExpanded ?? EMPTY_ROW_ID_SET,
  );
  const projectId = props.projectId;
  const senderThreadMetadataById = useSenderThreadMetadataById();
  const messageDirectiveSlots = useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().messageDirectives,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.messageDirectives,
  );
  const messageActionSlots = useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().messageActions,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.messageActions,
  );
  const messageDirectiveRegistry = useMemo(
    () => buildMessageDirectiveRegistry(messageDirectiveSlots),
    [messageDirectiveSlots],
  );
  const resolveSegmentLinkHref = useMemo<TimelineTitleLinkResolver>(() => {
    return (link) => {
      return projectId !== undefined
        ? getThreadRoutePath({ projectId, threadId: link.threadId })
        : null;
    };
  }, [projectId]);
  const onSelectionAddToChat = props.onSelectionAddToChat;
  const timelineThreadId = props.threadId;
  const hasPluginSelectionActions =
    timelineThreadId !== undefined && messageActionSlots.length > 0;
  const hasSelectionActions =
    onSelectionAddToChat !== undefined || hasPluginSelectionActions;
  const [activeSelection, setActiveSelection] = useState<{
    rowId: string;
    selection: MessageProseSelection;
    message: ThreadChatMessageReference;
  } | null>(null);
  const reportProseSelection = useMemo<
    | ((
        rowId: string,
        selection: MessageProseSelection | null,
        message: ThreadChatMessageReference,
      ) => void)
    | undefined
  >(
    () =>
      hasSelectionActions
        ? (rowId, selection, message) => {
            setActiveSelection((current) => {
              if (selection !== null) {
                return { rowId, selection, message };
              }
              return current?.rowId === rowId ? null : current;
            });
          }
        : undefined,
    [hasSelectionActions],
  );
  const dismissSelection = useCallback(() => {
    setActiveSelection(null);
  }, []);
  const handleSelectionAddToChat = useCallback(
    (
      text: string,
      attachments?: Parameters<ThreadTimelineAddToChatHandler>[1],
    ) => {
      if (attachments === undefined) {
        onSelectionAddToChat?.(text);
      } else {
        onSelectionAddToChat?.(text, attachments);
      }
      setActiveSelection(null);
    },
    [onSelectionAddToChat],
  );
  const selectionAddToChatHandler =
    onSelectionAddToChat === undefined ? undefined : handleSelectionAddToChat;
  const onOpenPluginPanel = props.onOpenPluginPanel;
  const selectionPluginActions = useMemo<
    readonly ThreadTimelinePluginMessageAction[]
  >(() => {
    if (
      activeSelection === null ||
      timelineThreadId === undefined ||
      messageActionSlots.length === 0
    ) {
      return [];
    }
    return messageActionSlots.map((slot) => ({
      key: `${slot.pluginId}/${slot.id}/${slot.generation}`,
      pluginId: slot.pluginId,
      icon: slot.icon ?? null,
      label: slot.title,
      onSelect: () =>
        runPluginMessageAction({
          slot,
          threadId: timelineThreadId,
          message: activeSelection.message,
          selectedText: activeSelection.selection.text,
          openThreadPanel: onOpenPluginPanel,
        }),
    }));
  }, [
    activeSelection,
    messageActionSlots,
    onOpenPluginPanel,
    timelineThreadId,
  ]);
  const staticContextValue = useMemo<TimelineRendererStaticContextValue>(
    () => ({
      canSpawnChild: props.canSpawnChild ?? false,
      getViewRows,
      onForkMessage: props.onForkMessage,
      onEditMessage: props.onEditMessage,
      inlineMessageEditor: props.inlineMessageEditor,
      onMessageAddToChat: props.onMessageAddToChat,
      onSendToMainMessage: props.onSendToMainMessage,
      onSelectionAddToChat: selectionAddToChatHandler,
      pluginMessageActions:
        timelineThreadId === undefined ||
        props.includePluginMessageActions === false
          ? EMPTY_PLUGIN_SLOT_SNAPSHOT.messageActions
          : messageActionSlots,
      consumerMessageActions:
        props.consumerMessageActions ?? EMPTY_CONSUMER_MESSAGE_ACTIONS,
      reportProseSelection,
      threadOriginKind: props.threadOriginKind ?? null,
      onOpenLink: props.onOpenLink,
      onOpenLocalFileLink: props.onOpenLocalFileLink,
      onOpenPluginPanel: props.onOpenPluginPanel,
      onTitleAction: props.onTitleAction,
      projectId,
      resolveImageViewSrc: props.resolveImageViewSrc,
      resolveMentionLink: props.resolveMentionLink,
      resolveSegmentLinkHref,
      resolveUserAttachmentImageSrc: props.resolveUserAttachmentImageSrc,
      threadId: props.threadId,
      workspaceRootPath: props.workspaceRootPath,
    }),
    [
      props.canSpawnChild,
      getViewRows,
      props.onForkMessage,
      props.onEditMessage,
      props.inlineMessageEditor,
      props.onMessageAddToChat,
      props.onSendToMainMessage,
      selectionAddToChatHandler,
      messageActionSlots,
      props.includePluginMessageActions,
      props.consumerMessageActions,
      reportProseSelection,
      props.threadOriginKind,
      timelineThreadId,
      props.onOpenLink,
      props.onOpenLocalFileLink,
      props.onOpenPluginPanel,
      props.onTitleAction,
      projectId,
      props.resolveImageViewSrc,
      props.resolveMentionLink,
      resolveSegmentLinkHref,
      props.resolveUserAttachmentImageSrc,
      props.threadId,
      props.workspaceRootPath,
    ],
  );
  const turnStateContextValue = useMemo<TimelineTurnStateContextValue>(
    () => ({
      initialAutoExpandedRowIds,
      liveAutoExpandedRowIds,
      terminalAutoExpandedRowIds,
    }),
    [
      initialAutoExpandedRowIds,
      liveAutoExpandedRowIds,
      terminalAutoExpandedRowIds,
    ],
  );

  return (
    <MessageDirectiveRegistryProvider registry={messageDirectiveRegistry}>
      <TimelineRendererStaticContext.Provider value={staticContextValue}>
        <SenderThreadMetadataContext.Provider value={senderThreadMetadataById}>
          <LatestActionableAssistantMessageIdContext.Provider
            value={latestActionableAssistantMessageId}
          >
            <LatestActionableUserMessageIdContext.Provider
              value={latestActionableUserMessageId}
            >
              <StreamingAssistantMessageIdContext.Provider
                value={streamingAssistantMessageId}
              >
                <TimelineTurnStateContext.Provider
                  value={turnStateContextValue}
                >
                  <TimelineWindowingMeasurementsContext.Provider
                    value={windowingMeasurements}
                  >
                    <TimelineWindowingEnabledContext.Provider
                      value={props.timelineWindowingEnabled ?? false}
                    >
                      <AutoHeightContainer snapRevision={heightSnapRevision}>
                        <TimelineRowsList
                          hasOlderTimelineRows={props.hasOlderTimelineRows}
                          isLoadingOlderTimelineRows={
                            props.isLoadingOlderTimelineRows
                          }
                          navigationTargetRowId={
                            props.timelineNavigationTargetRowId
                          }
                          onLoadOlderRows={props.onLoadOlderRows}
                          rows={rows}
                          scopeActive={scopeActive}
                          showAssistantMessageActions={true}
                          compactActivityIntents={false}
                          spacing="top-level"
                          unreadDividerAutoScroll={
                            props.unreadDividerAutoScroll ?? true
                          }
                          unreadDividerPlacement={
                            props.unreadDividerPlacement ?? null
                          }
                        />
                      </AutoHeightContainer>
                    </TimelineWindowingEnabledContext.Provider>
                  </TimelineWindowingMeasurementsContext.Provider>
                  {hasSelectionActions ? (
                    <TimelineSelectionMenu
                      selection={activeSelection?.selection ?? null}
                      onAddToChat={selectionAddToChatHandler}
                      pluginActions={selectionPluginActions}
                      onDismiss={dismissSelection}
                    />
                  ) : null}
                </TimelineTurnStateContext.Provider>
              </StreamingAssistantMessageIdContext.Provider>
            </LatestActionableUserMessageIdContext.Provider>
          </LatestActionableAssistantMessageIdContext.Provider>
        </SenderThreadMetadataContext.Provider>
      </TimelineRendererStaticContext.Provider>
    </MessageDirectiveRegistryProvider>
  );
}

export const ThreadTimelineRows = memo(ThreadTimelineRowsComponent);
ThreadTimelineRows.displayName = "ThreadTimelineRows";
