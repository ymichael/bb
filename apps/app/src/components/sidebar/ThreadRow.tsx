import { memo, useState } from "react";
import type { ThreadListEntry } from "@bb/domain";
import {
  Pill,
  SidebarMenuBadge,
  SidebarStickyTier,
  StatusPill,
} from "@/components/ui";
import {
  ChevronDown,
  ChevronRight,
  CircleDashed,
  type LucideIcon,
  UserRound,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import {
  COARSE_POINTER_DOT_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
  COARSE_POINTER_GLYPH_BOX_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@/components/ui";
import {
  getEnvironmentWorkspaceDisplayIcon,
  getEnvironmentWorkspaceDisplayIconLabel,
} from "@/lib/environment-workspace-display";
import { isBusyThread, isUnreadDoneThread } from "@/lib/thread-activity";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import {
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
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
      managedChildBusyCount: number;
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
  isBusy: boolean;
  onToggle: () => void;
  threadTitle: string;
}

const LEADING_SLOT_CLASS =
  "inline-flex shrink-0 items-center justify-center text-sidebar-foreground/60";

function EmptyLeadingSlot() {
  return (
    <span
      aria-hidden="true"
      className={cn(LEADING_SLOT_CLASS, COARSE_POINTER_GLYPH_BOX_CLASS)}
    />
  );
}

function ManagerChevron({
  isCollapsed,
  isBusy,
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
        LEADING_SLOT_CLASS,
        COARSE_POINTER_GLYPH_BOX_CLASS,
      )}
    >
      <span
        className={cn(
          "relative inline-flex items-center justify-center",
          COARSE_POINTER_ICON_SIZE_CLASS,
        )}
      >
        {isBusy ? (
          <CircleDashed
            className={cn(
              "absolute animate-spin opacity-100 transition-opacity duration-150 group-hover/thread-row:opacity-0",
              COARSE_POINTER_ICON_SIZE_CLASS,
            )}
            aria-hidden="true"
          />
        ) : null}
        <ChevronRight
          className={cn(
            "absolute transition-all duration-150",
            COARSE_POINTER_ICON_SIZE_CLASS,
            !isCollapsed && "rotate-90",
            isBusy
              ? "opacity-0 group-hover/thread-row:opacity-100"
              : "opacity-100",
          )}
        />
      </span>
    </button>
  );
}

function ManagedChildChevron({
  hasPendingInteraction,
  isBusy,
  showUnreadBadge,
}: ThreadStatusGlyphProps) {
  const showStatusGlyph = hasPendingInteraction || isBusy || showUnreadBadge;
  return (
    <span
      data-managed-child-marker=""
      className={cn(LEADING_SLOT_CLASS, COARSE_POINTER_GLYPH_BOX_CLASS)}
    >
      {showStatusGlyph ? (
        <ThreadStatusGlyph
          hasPendingInteraction={hasPendingInteraction}
          isBusy={isBusy}
          showUnreadBadge={showUnreadBadge}
        />
      ) : (
        <ChevronDown
          aria-hidden="true"
          className={cn("rotate-45", COARSE_POINTER_ICON_SIZE_CLASS)}
        />
      )}
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
      <CircleDashed
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

function ThreadLeadingStatusSlot({
  hasPendingInteraction,
  isBusy,
  showUnreadBadge,
}: ThreadStatusGlyphProps) {
  return (
    <span className={cn(LEADING_SLOT_CLASS, COARSE_POINTER_GLYPH_BOX_CLASS)}>
      <ThreadStatusGlyph
        hasPendingInteraction={hasPendingInteraction}
        isBusy={isBusy}
        showUnreadBadge={showUnreadBadge}
      />
    </span>
  );
}

interface ThreadTrailingIconProps {
  environmentIcon: LucideIcon | null;
  environmentIconLabel: string | null;
  isManager: boolean;
}

function ThreadTrailingIcon({
  environmentIcon: EnvironmentIcon,
  environmentIconLabel,
  isManager,
}: ThreadTrailingIconProps) {
  if (isManager) {
    return (
      <UserRound
        className={cn(
          "text-sidebar-foreground/70",
          COARSE_POINTER_ICON_SIZE_CLASS,
        )}
        aria-label="Manager"
      />
    );
  }

  return EnvironmentIcon ? (
    <EnvironmentIcon
      className={cn(
        "text-sidebar-foreground/70",
        COARSE_POINTER_ICON_SIZE_CLASS,
      )}
      aria-label={environmentIconLabel ?? undefined}
    />
  ) : null;
}

function ThreadRowComponent({
  projectId,
  thread,
  isActive,
  isPromoted = false,
  onProjectSelect,
  options,
}: ThreadRowProps) {
  const [isActionsOpen, setIsActionsOpen] = useState(false);
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
  const managedChildBusyCount = managerOptions?.managedChildBusyCount ?? 0;
  const isManagerBusy =
    isManager &&
    (threadIsBusy || (isManagerCollapsed && managedChildBusyCount > 0));
  const EnvironmentIcon = getEnvironmentWorkspaceDisplayIcon(
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
    isManagedChild ? "pl-1" : SIDEBAR_STANDARD_ROW_PADDING_CLASS,
    isActive
      ? "bg-sidebar-border text-sidebar-foreground"
      : SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  );
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
          isBusy={isManagerBusy}
          onToggle={() => {
            managerOptions.onToggleCollapsed(thread.id);
          }}
          threadTitle={threadTitle}
        />
      ) : isManagedChild ? (
        <EmptyLeadingSlot />
      ) : (
        <ThreadLeadingStatusSlot
          hasPendingInteraction={hasPendingInteraction}
          isBusy={threadIsBusy}
          showUnreadBadge={showUnreadBadge}
        />
      )}
      {isManagedChild ? (
        <ManagedChildChevron
          hasPendingInteraction={hasPendingInteraction}
          isBusy={threadIsBusy}
          showUnreadBadge={showUnreadBadge}
        />
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate">{threadTitle}</span>
        {isManager ? (
          <StatusPill variant="outline" className="shrink-0">
            manager
          </StatusPill>
        ) : null}
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
        {isManager && managedChildCount > 0 ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center justify-center",
              COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
            )}
            aria-label={`${managedChildCount} managed thread${managedChildCount === 1 ? "" : "s"}`}
            title={`${managedChildCount} managed thread${managedChildCount === 1 ? "" : "s"}`}
          >
            <SidebarMenuBadge className="rounded-full bg-sidebar-foreground/10 px-1.5 text-sidebar-foreground/80">
              {managedChildCount}
            </SidebarMenuBadge>
          </span>
        ) : null}
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
            <ThreadTrailingIcon
              environmentIcon={EnvironmentIcon}
              environmentIconLabel={environmentIconLabel}
              isManager={isManager}
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
              onOpenChange={setIsActionsOpen}
            />
          </div>
        </span>
      </span>
    </>
  );

  if (isManager) {
    return (
      <SidebarStickyTier tier="manager" className={rowClassName}>
        {rowContent}
      </SidebarStickyTier>
    );
  }

  return <div className={rowClassName}>{rowContent}</div>;
}

export const ThreadRow = memo(ThreadRowComponent);
