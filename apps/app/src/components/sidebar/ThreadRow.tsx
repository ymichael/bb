import {
  memo,
  useCallback,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
  useRef,
} from "react";
import { useSetAtom } from "jotai";
import type { ThreadListEntry } from "@bb/domain";
import type { PluginComposerThreadRowStatus } from "@get-bb/plugin-sdk";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { SidebarStickyTier } from "@/components/ui/sidebar.js";
import { NavLink } from "react-router-dom";
import {
  ThreadActionsContextMenu,
  ThreadActionsMenu,
  ThreadArchiveQuickAction,
} from "@/components/thread/ThreadActionsMenu";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import { useInlineThreadTitle } from "@/components/thread/InlineThreadTitle";
import {
  COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
  COARSE_POINTER_GLYPH_BOX_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import {
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
  SIDEBAR_HOVER_ACTIONS_INSET_CLASS,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
} from "@/components/ui/sidebar-hover-actions.js";
import {
  hasActiveBackgroundAgentActivity,
  hasActiveBackgroundCommandActivity,
  hasActiveGoalActivity,
  hasActivePlanModeActivity,
  hasActiveWorkflowActivity,
  isRuntimeBusyThread,
  isUnreadDoneThread,
  getThreadListIndicatorLabel,
  hasThreadListWorkingActivity,
  NO_COLLAPSED_CHILD_ACTIVITY,
  resolveThreadListIndicator,
  type CollapsedChildActivity,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { getThreadRoutePath } from "@/lib/route-paths";
import { cn } from "@bb/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_GLYPH_SLOT_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  SIDEBAR_ROW_SELECTED_STATE_CLASS,
  SIDEBAR_MORE_ACTION_TRIGGER_CLASS,
  SIDEBAR_PAIRED_ACTION_LEADING_TARGET_CLASS,
  SIDEBAR_PAIRED_ACTION_TRAILING_TARGET_CLASS,
  SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS,
  SIDEBAR_SUCCESS_STATUS_COLOR_CLASS,
  SIDEBAR_SUCCESS_STATUS_DOT_CLASS,
  SIDEBAR_WORKING_STATUS_COLOR_CLASS,
  getSidebarThreadRowPaddingLeft,
} from "./sidebarRowClasses";
import type { ConsumeDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import type { SidebarSortableDragBindings } from "./sortableMotion";
import { SidebarChildToggleChevron } from "./SidebarChildToggleChevron";
import { useSidebarThreadShortcut } from "./sidebarThreadShortcuts";
import { SplitPaneMiniMap } from "./SplitPaneMiniMap";
import { usePaneContentSplitIndicator } from "./paneContentSplitIndicator";
import { useThreadRowSplitDrag } from "./useThreadRowSplitDrag";
import { AppCommandShortcutPill } from "@/components/commands/AppCommandShortcutHint";
import {
  ThreadTitleMentions,
  useSidebarProjectName,
  useThreadTitleDisplayText,
} from "@/components/thread/ThreadTitleMentions";
import { pluginIconName } from "@/components/plugin/PluginIcon";
import { usePluginThreadRowStatus } from "@/lib/plugin-thread-row-status";

const SIDEBAR_TITLE_DOUBLE_CLICK_MS = 400;

let lastSidebarTitleClick: { at: number; threadId: string } | null = null;

function consumeSidebarTitleDoubleClick(threadId: string): boolean {
  const now = Date.now();
  const previous = lastSidebarTitleClick;
  lastSidebarTitleClick = { at: now, threadId };
  return (
    previous !== null &&
    previous.threadId === threadId &&
    now - previous.at < SIDEBAR_TITLE_DOUBLE_CLICK_MS
  );
}

export function resetSidebarTitleDoubleClickForTest(): void {
  lastSidebarTitleClick = null;
}

interface ThreadRowBaseOptions {
  depth: number;
  isCompact: boolean;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings?: SidebarSortableDragBindings;
}

export type ThreadRowOptions =
  | (ThreadRowBaseOptions & {
      kind: "default";
    })
  | (ThreadRowBaseOptions & {
      kind: "parent";
      isCollapsed: boolean;
      childCount: number;
      childActivity: CollapsedChildActivity;
      stickyLevel?: number;
      onToggleCollapsed: (threadId: string) => void;
    });

interface ThreadRowProps {
  projectId: string;
  thread: ThreadListEntry;
  crossProjectId: string | null;
  isActive: boolean;
  hasComposerDraft: boolean;
  onProjectSelect?: () => void;
  options: ThreadRowOptions;
}

type ThreadRowClickCaptureHandler = MouseEventHandler<HTMLDivElement>;

interface ThreadRowContainerArgs {
  children: ReactNode;
  className: string;
  dragBindings?: SidebarSortableDragBindings;
  onClickCapture?: ThreadRowClickCaptureHandler;
  onSplitDragPointerDown?: PointerEventHandler<HTMLElement>;
  stickyLevel?: number;
  style: CSSProperties;
}

function ThreadDraftIndicator({
  hideIdleLabel = false,
  isWorking,
}: {
  hideIdleLabel?: boolean;
  isWorking: boolean;
}) {
  const label = getThreadListIndicatorLabel(
    isWorking ? "working-draft" : "draft",
  );
  return (
    <Icon
      name="Edit"
      className={cn(
        "pointer-events-none shrink-0",
        COARSE_POINTER_ICON_SIZE_CLASS,
        isWorking
          ? ["animate-shine-icon", SIDEBAR_WORKING_STATUS_COLOR_CLASS]
          : "text-muted-foreground",
      )}
      {...(!isWorking && hideIdleLabel
        ? { "aria-hidden": true }
        : { "aria-label": label ?? undefined })}
    />
  );
}

function PluginThreadRowStatusIndicator({
  status,
}: {
  status: PluginComposerThreadRowStatus;
}) {
  if (status.tone === "running") {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center motion-safe:animate-pulse",
          COARSE_POINTER_ICON_SIZE_CLASS,
          "text-success",
        )}
      >
        <Icon
          name={pluginIconName(status.icon)}
          className={cn(
            "pointer-events-none shrink-0 animate-shine-icon",
            COARSE_POINTER_ICON_SIZE_CLASS,
            "motion-safe:[animation-duration:1.5s]",
          )}
          aria-label={status.label}
        />
      </span>
    );
  }

  return (
    <Icon
      name={pluginIconName(status.icon)}
      className={cn(
        "pointer-events-none shrink-0",
        COARSE_POINTER_ICON_SIZE_CLASS,
        status.tone === "success"
          ? SIDEBAR_SUCCESS_STATUS_COLOR_CLASS
          : status.tone === "error"
            ? "text-destructive"
            : "text-muted-foreground",
      )}
      aria-label={status.label}
    />
  );
}

function getThreadRowStyle(depth: number): CSSProperties {
  return {
    paddingLeft: getSidebarThreadRowPaddingLeft(depth),
  };
}

function renderThreadRowContainer({
  children,
  className,
  dragBindings,
  onClickCapture,
  onSplitDragPointerDown,
  stickyLevel,
  style,
}: ThreadRowContainerArgs) {
  if (stickyLevel !== undefined) {
    return (
      <SidebarStickyTier
        ref={dragBindings?.setActivatorNodeRef}
        tier="parent"
        level={stickyLevel}
        className={className}
        style={style}
        {...dragBindings?.attributes}
        {...(dragBindings?.listeners ?? {})}
        onClickCapture={onClickCapture}
        onPointerDown={onSplitDragPointerDown}
      >
        {children}
      </SidebarStickyTier>
    );
  }

  return (
    <div
      ref={dragBindings?.setActivatorNodeRef}
      className={className}
      style={style}
      {...dragBindings?.attributes}
      {...(dragBindings?.listeners ?? {})}
      onClickCapture={onClickCapture}
      onPointerDown={onSplitDragPointerDown}
    >
      {children}
    </div>
  );
}

interface ThreadStatusGlyphProps extends ThreadListIndicatorState {
  hideIdleDraftLabel?: boolean;
}

export function ThreadStatusGlyph({
  hasPendingInteraction,
  hasUnsubmittedDraft,
  hasUnreadError,
  hasUnreadSuccess,
  hideIdleDraftLabel = false,
  isBackgroundAgentActive,
  isBackgroundCommandActive,
  isGoalActive,
  isPlanModeActive,
  isRuntimeActive,
  isWorkflowActive,
  queuedWork,
}: ThreadStatusGlyphProps) {
  const kind = resolveThreadListIndicator({
    hasPendingInteraction,
    hasUnsubmittedDraft,
    hasUnreadError,
    hasUnreadSuccess,
    isBackgroundAgentActive,
    isBackgroundCommandActive,
    isGoalActive,
    isPlanModeActive,
    isRuntimeActive,
    isWorkflowActive,
    queuedWork,
  });

  switch (kind) {
    case "unread-error":
    case "queued-failed":
      return (
        <Icon
          name="CircleX"
          className={cn("text-destructive", COARSE_POINTER_ICON_SIZE_CLASS)}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "waiting-for-input":
      return (
        <Icon
          name="CircleQuestion"
          className={cn(
            "text-muted-foreground/75",
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "working-draft":
      return <ThreadDraftIndicator isWorking />;
    case "workflow":
      return (
        <Icon
          name="Workflow"
          className={cn(
            "animate-shine-icon",
            SIDEBAR_WORKING_STATUS_COLOR_CLASS,
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "background-agent":
      return (
        <Icon
          name="UserRoundPlus"
          className={cn(
            "animate-shine-icon",
            SIDEBAR_WORKING_STATUS_COLOR_CLASS,
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "background-command":
      return (
        <Icon
          name="Terminal"
          className={cn(
            "animate-shine-icon",
            SIDEBAR_WORKING_STATUS_COLOR_CLASS,
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "plan-mode":
      return (
        <Icon
          name="ListTodo"
          className={cn(
            "animate-shine-icon",
            SIDEBAR_WORKING_STATUS_COLOR_CLASS,
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "goal":
      return (
        <Icon
          name="Target"
          className={cn(
            "animate-shine-icon",
            SIDEBAR_WORKING_STATUS_COLOR_CLASS,
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "runtime":
      return (
        <Icon
          name="Loading"
          className={cn(
            "animate-spin",
            SIDEBAR_WORKING_STATUS_COLOR_CLASS,
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "queued-waiting":
      return (
        <Icon
          name="Clock"
          className={cn(
            "text-muted-foreground/75",
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "draft":
      return (
        <ThreadDraftIndicator
          hideIdleLabel={hideIdleDraftLabel}
          isWorking={false}
        />
      );
    case "unread-success":
      return (
        <span
          className={SIDEBAR_SUCCESS_STATUS_DOT_CLASS}
          aria-label={getThreadListIndicatorLabel(kind) ?? undefined}
        />
      );
    case "none":
      return null;
  }
}

interface CollapsedThreadStatusGlyphProps {
  activity: CollapsedChildActivity;
  pluginStatus?: PluginComposerThreadRowStatus | null;
}

export function CollapsedThreadStatusGlyph({
  activity,
  pluginStatus = null,
}: CollapsedThreadStatusGlyphProps) {
  const statusProps: ThreadListIndicatorState = {
    hasPendingInteraction: activity.pending,
    hasUnsubmittedDraft: activity.hasUnsubmittedDraft,
    hasUnreadError: activity.unreadError,
    hasUnreadSuccess: activity.unread,
    isBackgroundAgentActive: activity.backgroundAgent,
    isBackgroundCommandActive: activity.backgroundCommand,
    isGoalActive: activity.goal,
    queuedWork: "none",
    isPlanModeActive: activity.planMode,
    isRuntimeActive: activity.runtimeWorking,
    isWorkflowActive: activity.workflow,
  };
  const { pluginStatusIsVisible } = resolveThreadTrailingIndicatorStatus(
    statusProps,
    pluginStatus,
  );

  if (pluginStatusIsVisible && pluginStatus) {
    return <PluginThreadRowStatusIndicator status={pluginStatus} />;
  }

  return <ThreadStatusGlyph {...statusProps} />;
}
type ThreadTrailingIndicatorProps = ThreadStatusGlyphProps & {
  pluginStatus: PluginComposerThreadRowStatus | null;
};

interface ThreadTrailingIndicatorResolution {
  accessibleLabel: string | null;
  indicatorKind: ReturnType<typeof resolveThreadListIndicator>;
  pluginStatusIsVisible: boolean;
}

function resolveThreadTrailingIndicatorStatus(
  statusProps: ThreadStatusGlyphProps,
  pluginStatus: PluginComposerThreadRowStatus | null,
): ThreadTrailingIndicatorResolution {
  const indicatorKind = resolveThreadListIndicator(statusProps);
  const pluginStatusIsVisible =
    pluginStatus !== null &&
    indicatorKind !== "runtime" &&
    indicatorKind !== "unread-error" &&
    indicatorKind !== "waiting-for-input";

  return {
    accessibleLabel: pluginStatusIsVisible
      ? pluginStatus.label
      : getThreadListIndicatorLabel(indicatorKind),
    indicatorKind,
    pluginStatusIsVisible,
  };
}

function ThreadTrailingIndicator({
  pluginStatus,
  ...statusProps
}: ThreadTrailingIndicatorProps) {
  const { indicatorKind, pluginStatusIsVisible } =
    resolveThreadTrailingIndicatorStatus(statusProps, pluginStatus);

  if (indicatorKind === "none" && !pluginStatusIsVisible) {
    return null;
  }

  return (
    <span
      data-sidebar-thread-trailing-indicator=""
      className={cn(
        SIDEBAR_ROW_GLYPH_SLOT_CLASS,
        COARSE_POINTER_GLYPH_BOX_CLASS,
      )}
    >
      {pluginStatusIsVisible && pluginStatus ? (
        <PluginThreadRowStatusIndicator status={pluginStatus} />
      ) : (
        <ThreadStatusGlyph {...statusProps} />
      )}
    </span>
  );
}

function ThreadRowComponent({
  projectId,
  thread,
  crossProjectId,
  isActive,
  hasComposerDraft,
  onProjectSelect,
  options,
}: ThreadRowProps) {
  const [isDropdownActionsOpen, setIsDropdownActionsOpen] = useState(false);
  const [isContextActionsOpen, setIsContextActionsOpen] = useState(false);
  const { renameThread } = useThreadActions();
  const setConversationCollapsed = useSetAtom(
    getThreadConversationCollapsedAtom(thread.id),
  );
  const shortcut = useSidebarThreadShortcut(thread.id);
  const pluginThreadRowStatus = usePluginThreadRowStatus(thread.id);
  const showActive = isActive;
  const hasPendingInteraction = thread.hasPendingInteraction;
  const threadRuntimeBusy = isRuntimeBusyThread(thread);
  const threadWorkflowActive = hasActiveWorkflowActivity(thread);
  const threadBackgroundAgentActive = hasActiveBackgroundAgentActivity(thread);
  const threadBackgroundCommandActive =
    hasActiveBackgroundCommandActivity(thread);
  const threadPlanModeActive = hasActivePlanModeActivity(thread);
  const threadGoalActive = hasActiveGoalActivity(thread);
  const threadUnreadDone = isUnreadDoneThread(thread);
  const threadUnreadError = threadUnreadDone && thread.status === "error";
  const threadUnreadSuccess = threadUnreadDone && !threadUnreadError;
  const threadTitle = getThreadDisplayTitle(thread);
  const labelTitle = useThreadTitleDisplayText(threadTitle);
  const crossProjectName = useSidebarProjectName(crossProjectId);
  const crossProjectLabel =
    crossProjectId === null
      ? null
      : crossProjectName
        ? `In project ${crossProjectName}`
        : "In another project";
  const handleRename = useCallback(
    (nextTitle: string) => {
      renameThread(thread.id, nextTitle);
    },
    [renameThread, thread.id],
  );
  const { editor, isEditing, startEditing } = useInlineThreadTitle({
    onCommit: handleRename,
    resetKey: thread.id,
    title: threadTitle,
  });
  const startTitleEditing = useCallback(
    (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      event.preventDefault();
      event.stopPropagation();
      startEditing();
    },
    [startEditing],
  );
  const splitIndicator = usePaneContentSplitIndicator(
    { kind: "thread", projectId, threadId: thread.id },
    true,
  );
  const { onPointerDown: onSplitDragPointerDown, openInSplit } =
    useThreadRowSplitDrag({
      projectId,
      threadId: thread.id,
      title: labelTitle,
    });
  const splitAvailable = onSplitDragPointerDown !== undefined;
  const parentOptions = options.kind === "parent" ? options : null;
  const isParentRow = parentOptions !== null;
  const isParentCollapsed = parentOptions?.isCollapsed ?? false;
  const childCount = parentOptions?.childCount ?? 0;
  const childActivity =
    parentOptions?.childActivity ?? NO_COLLAPSED_CHILD_ACTIVITY;
  const hasChildren = childCount > 0;
  const hasHiddenChildren = isParentRow && isParentCollapsed && hasChildren;
  const trailingHasPendingInteraction = hasHiddenChildren
    ? hasPendingInteraction || childActivity.pending
    : hasPendingInteraction;
  const trailingRuntimeBusy = hasHiddenChildren
    ? threadRuntimeBusy || childActivity.runtimeWorking
    : threadRuntimeBusy;
  const trailingIsWorkflowActive = hasHiddenChildren
    ? threadWorkflowActive || childActivity.workflow
    : threadWorkflowActive;
  const trailingBackgroundAgentActive = hasHiddenChildren
    ? threadBackgroundAgentActive || childActivity.backgroundAgent
    : threadBackgroundAgentActive;
  const trailingBackgroundCommandActive = hasHiddenChildren
    ? threadBackgroundCommandActive || childActivity.backgroundCommand
    : threadBackgroundCommandActive;
  const trailingPlanModeActive = hasHiddenChildren
    ? threadPlanModeActive || childActivity.planMode
    : threadPlanModeActive;
  const trailingGoalActive = hasHiddenChildren
    ? threadGoalActive || childActivity.goal
    : threadGoalActive;
  const trailingHasUnreadError = hasHiddenChildren
    ? threadUnreadError || childActivity.unreadError
    : threadUnreadError;
  const trailingHasUnreadSuccess = hasHiddenChildren
    ? threadUnreadSuccess || childActivity.unread
    : threadUnreadSuccess;
  const trailingHasUnsubmittedDraft = hasHiddenChildren
    ? hasComposerDraft || childActivity.hasUnsubmittedDraft
    : hasComposerDraft;
  const trailingIndicatorState: ThreadListIndicatorState = {
    hasPendingInteraction: trailingHasPendingInteraction,
    hasUnsubmittedDraft: trailingHasUnsubmittedDraft,
    hasUnreadError: trailingHasUnreadError,
    hasUnreadSuccess: trailingHasUnreadSuccess,
    isBackgroundAgentActive: trailingBackgroundAgentActive,
    isBackgroundCommandActive: trailingBackgroundCommandActive,
    isGoalActive: trailingGoalActive,
    queuedWork: thread.queuedWork,
    isPlanModeActive: trailingPlanModeActive,
    isRuntimeActive: trailingRuntimeBusy,
    isWorkflowActive: trailingIsWorkflowActive,
  };
  const trailingIndicatorResolution = resolveThreadTrailingIndicatorStatus(
    trailingIndicatorState,
    pluginThreadRowStatus,
  );
  const trailingIndicatorKind = trailingIndicatorResolution.indicatorKind;
  const splitIndicatorIsWorking = hasThreadListWorkingActivity(
    trailingIndicatorState,
    pluginThreadRowStatus?.tone === "running",
  );
  const splitIndicatorLabel = trailingIndicatorResolution.accessibleLabel
    ? `${labelTitle} — open in split; ${trailingIndicatorResolution.accessibleLabel}`
    : `${labelTitle} — open in split`;
  const linkLabel = hasComposerDraft
    ? `Open ${labelTitle} (unsubmitted draft)`
    : `Open ${labelTitle}`;
  const rowDragBindings = options.dragBindings;
  const rowClassName = cn(
    SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
    "group/thread-row",
    SIDEBAR_ROW_BASE_CLASS,
    LIST_HOVER_TRANSITION,
    parentOptions?.stickyLevel === undefined && "relative",
    options.isCompact
      ? COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS
      : COARSE_POINTER_ROW_HEIGHT_CLASS,
    showActive
      ? SIDEBAR_ROW_SELECTED_STATE_CLASS
      : SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
    !showActive &&
      splitIndicator.isOpenInSplit &&
      SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS,
    !showActive && "has-[[data-state=open]]:bg-sidebar-accent",
    rowDragBindings && !rowDragBindings.disabled && "select-none",
  );
  const rowStyle = getThreadRowStyle(options.depth);
  const isActionsOpen = isDropdownActionsOpen || isContextActionsOpen;
  const handleRowClickCapture = useCallback<ThreadRowClickCaptureHandler>(
    (event) => {
      if (!options.consumeClickSuppression?.()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [options],
  );

  const rowLinkRef = useRef<HTMLAnchorElement>(null);
  const rowContent = (
    <>
      <NavLink
        ref={rowLinkRef}
        to={getThreadRoutePath({ projectId, threadId: thread.id })}
        data-sidebar-thread-shortcut-target=""
        data-sidebar-thread-id={thread.id}
        onClick={(event) => {
          if (isEditing) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          setConversationCollapsed(false);
          if (splitAvailable && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            openInSplit();
            return;
          }
          if (consumeSidebarTitleDoubleClick(thread.id)) {
            event.preventDefault();
            event.stopPropagation();
            startEditing();
            return;
          }
          onProjectSelect?.();
        }}
        onDoubleClick={isEditing ? undefined : startTitleEditing}
        aria-label={linkLabel}
        aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
        className="absolute inset-0 rounded-md outline-none ring-sidebar-ring focus-visible:ring-2"
      />
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5",
          !shortcut && SIDEBAR_HOVER_ACTIONS_INSET_CLASS,
        )}
      >
        {isEditing ? (
          <span className="relative z-10 min-w-0 flex-1 overflow-visible">
            {editor}
          </span>
        ) : (
          <span
            className="bb-sidebar-thread-title min-w-0 truncate"
            title={labelTitle}
            onDoubleClick={startTitleEditing}
          >
            <ThreadTitleMentions title={threadTitle} />
          </span>
        )}
        {crossProjectLabel !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-sidebar-thread-cross-project=""
                role="img"
                aria-label={crossProjectLabel}
                className="relative top-px z-10 flex shrink-0 items-center text-muted-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  rowLinkRef.current?.click();
                }}
              >
                <Icon name="FolderExport" className="size-3.5" aria-hidden />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{crossProjectLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        {parentOptions && hasChildren ? (
          <SidebarChildToggleChevron
            isCollapsed={isParentCollapsed}
            expandLabel={`Expand ${labelTitle} threads`}
            collapseLabel={`Collapse ${labelTitle} threads`}
            onToggle={() => parentOptions.onToggleCollapsed(thread.id)}
            revealOnHover={!isParentCollapsed}
          />
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {shortcut ? (
          <AppCommandShortcutPill shortcut={shortcut} />
        ) : (
          <span
            className={cn(
              "flex shrink-0 items-center justify-end max-md:pointer-coarse:pointer-events-none",
              COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
            )}
          >
            <span
              className={cn(
                "relative shrink-0",
                COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
              )}
            >
              <span
                data-sidebar-hover-actions-open={
                  isActionsOpen ? "true" : undefined
                }
                className={cn(
                  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
                  "absolute inset-0 flex items-center justify-center",
                )}
              >
                {splitIndicator.miniMap ? (
                  <span
                    data-sidebar-thread-trailing-indicator=""
                    className={cn(
                      SIDEBAR_ROW_GLYPH_SLOT_CLASS,
                      COARSE_POINTER_GLYPH_BOX_CLASS,
                    )}
                  >
                    <SplitPaneMiniMap
                      slots={splitIndicator.miniMap}
                      label={splitIndicatorLabel}
                      isWorking={splitIndicatorIsWorking}
                    />
                  </span>
                ) : (
                  <ThreadTrailingIndicator
                    {...trailingIndicatorState}
                    hideIdleDraftLabel={
                      !hasHiddenChildren && trailingIndicatorKind === "draft"
                    }
                    pluginStatus={pluginThreadRowStatus}
                  />
                )}
              </span>
              <div
                data-sidebar-hover-actions-open={
                  isActionsOpen ? "true" : undefined
                }
                className={cn(
                  SIDEBAR_HOVER_ACTIONS_CLASS,
                  "absolute inset-y-0 right-0 z-10 flex items-center justify-end max-md:pointer-coarse:hidden",
                )}
              >
                <ThreadArchiveQuickAction
                  thread={thread}
                  className={cn(
                    "text-subtle-foreground hover:bg-transparent hover:text-foreground",
                    SIDEBAR_MORE_ACTION_TRIGGER_CLASS,
                    "-mr-0.5",
                    SIDEBAR_PAIRED_ACTION_LEADING_TARGET_CLASS,
                  )}
                />
                <ThreadActionsMenu
                  thread={thread}
                  triggerClassName={cn(
                    "text-subtle-foreground hover:bg-transparent hover:text-foreground",
                    SIDEBAR_MORE_ACTION_TRIGGER_CLASS,
                    SIDEBAR_PAIRED_ACTION_TRAILING_TARGET_CLASS,
                  )}
                  onOpenInSplit={splitAvailable ? openInSplit : undefined}
                  onOpenChange={setIsDropdownActionsOpen}
                />
              </div>
            </span>
          </span>
        )}
      </span>
    </>
  );

  const row = renderThreadRowContainer({
    children: rowContent,
    className: rowClassName,
    dragBindings: rowDragBindings,
    onClickCapture: options.consumeClickSuppression
      ? handleRowClickCapture
      : undefined,
    onSplitDragPointerDown,
    stickyLevel: parentOptions?.stickyLevel,
    style: rowStyle,
  });

  return (
    <ThreadActionsContextMenu
      thread={thread}
      onOpenInSplit={splitAvailable ? openInSplit : undefined}
      onOpenChange={setIsContextActionsOpen}
    >
      {row}
    </ThreadActionsContextMenu>
  );
}

export const ThreadRow = memo(ThreadRowComponent);
