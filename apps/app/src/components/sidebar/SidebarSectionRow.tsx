import {
  memo,
  useCallback,
  useState,
  type CSSProperties,
  type MouseEvent,
  type MouseEventHandler,
} from "react";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { SidebarStickyTier } from "@/components/ui/sidebar.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import {
  COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
  SIDEBAR_HOVER_ACTIONS_GAP_CLASS,
  SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
} from "@/components/ui/sidebar-hover-actions.js";
import { cn } from "@bb/shared-ui/lib/utils";
import type { CollapsedChildActivity } from "@bb/client-core";
import {
  SIDEBAR_MORE_ACTION_TRIGGER_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_STATIC_STATE_CLASS,
  getSidebarThreadRowPaddingLeft,
} from "./sidebarRowClasses";
import { SidebarChildToggleChevron } from "./SidebarChildToggleChevron";
import { CollapsedThreadStatusGlyph } from "./ThreadRow";
import type { SidebarSortableDragBindings } from "./sortableMotion";
import type { ConsumeDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import {
  useThreadGroupSplitIndicator,
  type ThreadSplitIndicatorTarget,
} from "./paneContentSplitIndicator";
import { SplitPaneMiniMap } from "./SplitPaneMiniMap";
import { usePluginThreadRowStatusForThreads } from "@/lib/plugin-thread-row-status";

const EMPTY_SPLIT_INDICATOR_THREADS: readonly ThreadSplitIndicatorTarget[] = [];

function stopActionsClick(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

interface SidebarSectionRowProps {
  name: string;
  label: string;
  depth: number;
  activity: CollapsedChildActivity;
  collapsedThreads?: readonly ThreadSplitIndicatorTarget[];
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  stickyLevel?: number;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings?: SidebarSortableDragBindings;
  isDropTargetActive?: boolean;
  onCreateThread?: () => void;
  onRename?: () => void;
  onRemove?: () => void;
}

function SidebarSectionRowComponent({
  name,
  label,
  depth,
  activity,
  collapsedThreads = EMPTY_SPLIT_INDICATOR_THREADS,
  consumeClickSuppression,
  dragBindings,
  isDropTargetActive = false,
  isCollapsed,
  onToggleCollapsed,
  onCreateThread,
  onRename,
  onRemove,
  stickyLevel,
}: SidebarSectionRowProps) {
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const collapsedSplitIndicator = useThreadGroupSplitIndicator(
    collapsedThreads,
    isCollapsed,
  );
  const pluginStatus = usePluginThreadRowStatusForThreads(collapsedThreads);
  const hasMenuActions = Boolean(onRename || onRemove);
  const hasActions = Boolean(onCreateThread || hasMenuActions);
  const showRollupIndicator =
    isCollapsed &&
    (collapsedSplitIndicator.miniMap !== null ||
      activity.pending ||
      activity.working ||
      activity.hasUnsubmittedDraft ||
      activity.unread ||
      activity.unreadError ||
      pluginStatus !== null);
  const renderRollupIndicator = () =>
    collapsedSplitIndicator.miniMap ? (
      <SplitPaneMiniMap
        slots={collapsedSplitIndicator.miniMap}
        label={`${label} — contains a thread open in split`}
        isWorking={activity.working || pluginStatus?.tone === "running"}
      />
    ) : (
      <CollapsedThreadStatusGlyph
        activity={activity}
        pluginStatus={pluginStatus}
      />
    );
  const className = cn(
    SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
    stickyLevel === undefined && "relative",
    SIDEBAR_ROW_BASE_CLASS,
    LIST_HOVER_TRANSITION,
    SIDEBAR_ROW_STATIC_STATE_CLASS,
    COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
    dragBindings && !dragBindings.disabled && "select-none",
    isDropTargetActive && "bg-sidebar-accent text-sidebar-accent-foreground",
  );
  const style: CSSProperties = {
    paddingLeft: getSidebarThreadRowPaddingLeft(depth),
  };
  const handleClickCapture = useCallback<MouseEventHandler<HTMLElement>>(
    (event) => {
      if (!consumeClickSuppression?.()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [consumeClickSuppression],
  );
  const content = (
    <>
      {}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onToggleCollapsed}
        className="absolute inset-0 rounded-md outline-none ring-sidebar-ring focus-visible:ring-2"
      />
      <span className="relative z-10 flex min-w-0 flex-1 items-center gap-1 text-left">
        <span className="min-w-0 truncate">{name}</span>
        <SidebarChildToggleChevron
          isCollapsed={isCollapsed}
          expandLabel={`Expand ${label} section`}
          collapseLabel={`Collapse ${label} section`}
          onToggle={onToggleCollapsed}
        />
      </span>
      {showRollupIndicator ? (
        <span
          data-sidebar-collapsed-activity-edge=""
          data-sidebar-hover-actions-open={isActionsOpen ? "true" : undefined}
          className={cn(
            "pointer-events-none absolute right-0 top-1/2 z-20 inline-flex -translate-y-1/2 items-center text-subtle-foreground max-md:pointer-coarse:hidden",
            hasActions && SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
          )}
        >
          {renderRollupIndicator()}
        </span>
      ) : null}
      <span
        className={cn(
          "relative z-10 shrink-0",
          hasActions
            ? "inline-flex items-center"
            : COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
        )}
      >
        {hasActions ? (
          <span
            data-sidebar-hover-actions-open={isActionsOpen ? "true" : undefined}
            data-sidebar-hover-actions-mobile={
              SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE
            }
            className={cn(
              SIDEBAR_HOVER_ACTIONS_CLASS,
              "relative z-10 inline-flex shrink-0 items-center",
              SIDEBAR_HOVER_ACTIONS_GAP_CLASS,
            )}
            onClick={stopActionsClick}
          >
            {showRollupIndicator ? (
              <span className="hidden shrink-0 items-center justify-center text-subtle-foreground max-md:pointer-coarse:inline-flex">
                {renderRollupIndicator()}
              </span>
            ) : null}
            {hasMenuActions ? (
              <DropdownMenu onOpenChange={setIsActionsOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`${label} section actions`}
                    className={cn(
                      "rounded-md p-0 text-subtle-foreground hover:bg-transparent hover:text-foreground",
                      SIDEBAR_MORE_ACTION_TRIGGER_CLASS,
                    )}
                  >
                    <Icon
                      name="MoreHorizontal"
                      className={COARSE_POINTER_ICON_SIZE_CLASS}
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {onRename ? (
                    <DropdownMenuItem onSelect={onRename}>
                      <Icon name="Edit" aria-hidden="true" />
                      Rename
                    </DropdownMenuItem>
                  ) : null}
                  {onRemove ? (
                    <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                      <Icon name="Trash2" aria-hidden="true" />
                      Remove
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {onCreateThread ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`New thread in ${label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCreateThread();
                    }}
                    className={cn(
                      "rounded-md p-0 text-subtle-foreground hover:bg-transparent hover:text-foreground",
                      COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
                    )}
                  >
                    <Icon
                      name="MessageSquarePlus"
                      className={COARSE_POINTER_ICON_SIZE_CLASS}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">New thread</TooltipContent>
              </Tooltip>
            ) : null}
          </span>
        ) : showRollupIndicator ? (
          <span className="hidden size-full items-center justify-center text-subtle-foreground max-md:pointer-coarse:inline-flex">
            {renderRollupIndicator()}
          </span>
        ) : null}
      </span>
    </>
  );

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
        onClickCapture={
          consumeClickSuppression ? handleClickCapture : undefined
        }
      >
        {content}
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
      onClickCapture={consumeClickSuppression ? handleClickCapture : undefined}
    >
      {content}
    </div>
  );
}

export const SidebarSectionRow = memo(SidebarSectionRowComponent);
