import { memo, useState } from "react";
import type { ThreadListEntry } from "@bb/domain";
import { Icon, type IconName } from "@/components/ui/icon.js";
import { OverflowFade } from "@/components/ui/overflow-fade.js";
import { Pill } from "@/components/ui/pill.js";
import { SidebarStickyTier } from "@/components/ui/sidebar.js";
import { NavLink } from "react-router-dom";
import {
  ThreadActionsContextMenu,
  ThreadActionsMenu,
} from "@/components/thread/ThreadActionsMenu";
import {
  COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
  COARSE_POINTER_DOT_SIZE_CLASS,
  COARSE_POINTER_GLYPH_BOX_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@/components/ui/coarse-pointer-sizing.js";
import {
  getEnvironmentWorkspaceDisplayIconLabel,
  getEnvironmentWorkspaceDisplayIconName,
} from "@/lib/environment-workspace-display";
import { isBusyThread, isUnreadDoneThread } from "@/lib/thread-activity";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import {
  SIDEBAR_MANAGER_CHILD_ROW_PADDING_CLASS,
  SIDEBAR_MANAGER_ROW_PADDING_CLASS,
  SIDEBAR_PROJECT_THREAD_ROW_PADDING_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
} from "./sidebarRowClasses";

export type ThreadRowOptions =
  | {
      kind: "default";
    }
  | {
      kind: "managed-child";
    }
  | {
      kind: "manager";
      isCollapsed: boolean;
      managedChildCount: number;
      onToggleCollapsed: (threadId: string) => void;
    };

interface ThreadRowProps {
  projectId: string;
  thread: ThreadListEntry;
  isActive: boolean;
  isPromoted?: boolean;
  onProjectSelect?: () => void;
  options: ThreadRowOptions;
}

interface ManagerChevronProps {
  isCollapsed: boolean;
  onToggle: () => void;
  threadTitle: string;
}

const ROW_GLYPH_SLOT_CLASS =
  "inline-flex shrink-0 items-center justify-center text-sidebar-foreground/60";

function ManagerChevron({
  isCollapsed,
  onToggle,
  threadTitle,
}: ManagerChevronProps) {
  return (
    <button
      type="button"
      aria-expanded={!isCollapsed}
      aria-label={
        isCollapsed
          ? `Expand ${threadTitle} threads`
          : `Collapse ${threadTitle} threads`
      }
      title={
        isCollapsed ? "Expand managed threads" : "Collapse managed threads"
      }
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "relative z-10 rounded-md outline-none ring-sidebar-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2",
        ROW_GLYPH_SLOT_CLASS,
        COARSE_POINTER_GLYPH_BOX_CLASS,
      )}
    >
      <span
        className={cn(
          "relative inline-flex items-center justify-center",
          COARSE_POINTER_ICON_SIZE_CLASS,
        )}
      >
        <span
          data-manager-leading-icon=""
          className={cn(
            "absolute inline-flex items-center justify-center opacity-100 transition-opacity duration-150 group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
          aria-hidden="true"
        >
          <Icon
            name="UserRound"
            className={COARSE_POINTER_ICON_SIZE_CLASS}
            aria-hidden="true"
          />
        </span>
        <span
          data-manager-collapse-indicator=""
          className={cn(
            "absolute inline-flex items-center justify-center opacity-0 transition-all duration-150 group-hover/thread-row:opacity-100 group-focus-within/thread-row:opacity-100",
            COARSE_POINTER_ICON_SIZE_CLASS,
            !isCollapsed && "rotate-90",
          )}
          aria-hidden="true"
        >
          <Icon
            name="ChevronRight"
            className={COARSE_POINTER_ICON_SIZE_CLASS}
            aria-hidden="true"
          />
        </span>
      </span>
    </button>
  );
}

function ManagerLeadingIcon() {
  return (
    <span
      data-manager-leading-icon=""
      className={cn(ROW_GLYPH_SLOT_CLASS, COARSE_POINTER_GLYPH_BOX_CLASS)}
      aria-hidden="true"
    >
      <Icon
        name="UserRound"
        className={COARSE_POINTER_ICON_SIZE_CLASS}
        aria-hidden="true"
      />
    </span>
  );
}

interface ThreadStatusGlyphProps {
  hasPendingInteraction: boolean;
  isBusy: boolean;
  showUnreadBadge: boolean;
}

function ThreadStatusGlyph({
  hasPendingInteraction,
  isBusy,
  showUnreadBadge,
}: ThreadStatusGlyphProps) {
  if (hasPendingInteraction) {
    return (
      <span
        className={cn(
          "rounded-full bg-attention",
          COARSE_POINTER_DOT_SIZE_CLASS,
        )}
        aria-label="Pending interaction requires attention"
        title="Pending interaction"
      />
    );
  }

  if (isBusy) {
    return (
      <Icon
        name="CircleDashed"
        className={cn(
          "animate-spin text-sidebar-foreground/70",
          COARSE_POINTER_ICON_SIZE_CLASS,
        )}
        aria-label="Thread working"
      />
    );
  }

  if (showUnreadBadge) {
    return (
      <span
        className={cn("rounded-full bg-primary", COARSE_POINTER_DOT_SIZE_CLASS)}
        aria-label="Unread thread requires attention"
        title="Unread thread requires attention"
      />
    );
  }

  return null;
}

interface ThreadTrailingIndicatorProps extends ThreadStatusGlyphProps {
  environmentIcon: IconName | null;
  environmentIconLabel: string | null;
}

function ThreadTrailingIndicator({
  environmentIcon,
  environmentIconLabel,
  hasPendingInteraction,
  isBusy,
  showUnreadBadge,
}: ThreadTrailingIndicatorProps) {
  const showStatusGlyph = hasPendingInteraction || isBusy || showUnreadBadge;

  if (showStatusGlyph) {
    return (
      <span
        className={cn(ROW_GLYPH_SLOT_CLASS, COARSE_POINTER_GLYPH_BOX_CLASS)}
      >
        <ThreadStatusGlyph
          hasPendingInteraction={hasPendingInteraction}
          isBusy={isBusy}
          showUnreadBadge={showUnreadBadge}
        />
      </span>
    );
  }

  return (
    <ThreadTrailingIcon
      environmentIcon={environmentIcon}
      environmentIconLabel={environmentIconLabel}
    />
  );
}

function ThreadTrailingIcon({
  environmentIcon,
  environmentIconLabel,
}: ThreadTrailingIconProps) {
  return environmentIcon ? (
    <Icon
      name={environmentIcon}
      className={cn(
        "text-sidebar-foreground/70",
        COARSE_POINTER_ICON_SIZE_CLASS,
      )}
      aria-label={environmentIconLabel ?? undefined}
    />
  ) : null;
}

interface ThreadTrailingIconProps {
  environmentIcon: IconName | null;
  environmentIconLabel: string | null;
}

function ThreadRowComponent({
  projectId,
  thread,
  isActive,
  isPromoted = false,
  onProjectSelect,
  options,
}: ThreadRowProps) {
  const [isDropdownActionsOpen, setIsDropdownActionsOpen] = useState(false);
  const [isContextActionsOpen, setIsContextActionsOpen] = useState(false);
  const hasPendingInteraction = thread.hasPendingInteraction;
  const threadIsBusy = isBusyThread(thread) && !hasPendingInteraction;
  const showUnreadBadge = !hasPendingInteraction && isUnreadDoneThread(thread);
  const threadTitle = getThreadDisplayTitle(thread);
  const managerOptions = options.kind === "manager" ? options : null;
  const isManager = managerOptions !== null;
  const isManagedChild = options.kind === "managed-child";
  const isManagerCollapsed = managerOptions?.isCollapsed ?? false;
  const managedChildCount = managerOptions?.managedChildCount ?? 0;
  const hasManagedChildren = managedChildCount > 0;
  const environmentIcon = getEnvironmentWorkspaceDisplayIconName(
    thread.environmentWorkspaceDisplayKind,
  );
  const environmentIconLabel = getEnvironmentWorkspaceDisplayIconLabel(
    thread.environmentWorkspaceDisplayKind,
  );
  const rowClassName = cn(
    "group/thread-row",
    SIDEBAR_ROW_BASE_CLASS,
    !isManager && "relative",
    isManagedChild
      ? COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS
      : COARSE_POINTER_ROW_HEIGHT_CLASS,
    isManager
      ? SIDEBAR_MANAGER_ROW_PADDING_CLASS
      : isManagedChild
        ? SIDEBAR_MANAGER_CHILD_ROW_PADDING_CLASS
        : SIDEBAR_PROJECT_THREAD_ROW_PADDING_CLASS,
    isActive
      ? "bg-sidebar-border text-sidebar-foreground"
      : SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  );
  const isActionsOpen = isDropdownActionsOpen || isContextActionsOpen;

  const rowContent = (
    <>
      <NavLink
        to={`/projects/${projectId}/threads/${thread.id}`}
        onClick={onProjectSelect}
        aria-label={`Open ${threadTitle}`}
        title={`Open ${threadTitle}`}
        className="absolute inset-0 rounded-md outline-none ring-sidebar-ring focus-visible:ring-2"
      />
      {managerOptions && hasManagedChildren ? (
        <ManagerChevron
          isCollapsed={isManagerCollapsed}
          onToggle={() => {
            managerOptions.onToggleCollapsed(thread.id);
          }}
          threadTitle={threadTitle}
        />
      ) : isManager ? (
        <ManagerLeadingIcon />
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate">{threadTitle}</span>
        {isPromoted ? (
          <Pill variant="emphasis" className="shrink-0">
            promoted
          </Pill>
        ) : null}
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center justify-end",
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
            className={cn(
              "absolute inset-0 flex items-center justify-center transition-opacity",
              isActionsOpen ? "opacity-0" : "group-hover/thread-row:opacity-0",
            )}
          >
            <ThreadTrailingIndicator
              environmentIcon={environmentIcon}
              environmentIconLabel={environmentIconLabel}
              hasPendingInteraction={hasPendingInteraction}
              isBusy={threadIsBusy}
              showUnreadBadge={showUnreadBadge}
            />
          </span>
          <div
            className={cn(
              "absolute inset-0 z-10 flex items-center justify-end transition-opacity",
              isActionsOpen
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0 group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100",
            )}
          >
            <ThreadActionsMenu
              thread={thread}
              triggerClassName={cn(
                "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
              )}
              onOpenChange={setIsDropdownActionsOpen}
            />
          </div>
        </span>
      </span>
    </>
  );

  const row = isManager ? (
    <SidebarStickyTier tier="manager" className={rowClassName}>
      {rowContent}
      <OverflowFade placement="below" tone="sidebar" size="sm" />
    </SidebarStickyTier>
  ) : (
    <div className={rowClassName}>{rowContent}</div>
  );

  return (
    <ThreadActionsContextMenu
      thread={thread}
      onOpenChange={setIsContextActionsOpen}
    >
      {row}
    </ThreadActionsContextMenu>
  );
}

export const ThreadRow = memo(ThreadRowComponent);
