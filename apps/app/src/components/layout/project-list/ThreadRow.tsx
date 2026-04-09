import { useState } from "react"
import type { Thread, ThreadListEntry } from "@bb/domain"
import {
  ChevronDown,
  ChevronRight,
  CircleDashed,
  UserRound,
} from "lucide-react"
import { NavLink } from "react-router-dom"
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu"
import { SidebarMenuBadge } from "@/components/ui/sidebar"
import { isBusyThread, isUnreadDoneThread } from "@/lib/thread-activity"
import { getThreadDisplayTitle } from "@/lib/thread-title"
import { cn } from "@/lib/utils"

export type ThreadRowOptions =
  | {
      kind: "default"
    }
  | {
      kind: "manager"
      hasManagedChildren: boolean
      isCollapsed: boolean
      managedChildCount: number
      managedChildBusyCount: number
    }
  | {
      kind: "managed-child"
    }

interface ThreadRowProps {
  projectId: string
  thread: ThreadListEntry
  isActive: boolean
  isActionsDisabled: boolean
  onProjectSelect?: () => void
  onToggleManagerCollapsed?: (threadId: string) => void
  onToggleRead: (thread: Thread) => void
  onRename: (thread: Thread) => void
  onToggleArchive: (thread: Thread) => void
  onDelete: (thread: Thread) => void
  options: ThreadRowOptions
}

interface ManagerChevronProps {
  isCollapsed: boolean
  isBusy: boolean
  onToggle: () => void
  threadTitle: string
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
        isCollapsed ? `Expand ${threadTitle} threads` : `Collapse ${threadTitle} threads`
      }
      title={isCollapsed ? "Expand managed threads" : "Collapse managed threads"}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
      className="relative z-10 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none ring-sidebar-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2"
    >
      <span className="relative inline-flex size-4 items-center justify-center">
        {isBusy ? (
          <CircleDashed
            className="absolute size-4 animate-spin opacity-100 transition-opacity duration-150 group-hover/thread-row:opacity-0"
            aria-hidden
          />
        ) : null}
        <ChevronRight
          className={cn(
            "absolute size-4 transition-all duration-150",
            !isCollapsed && "rotate-90",
            isBusy ? "opacity-0 group-hover/thread-row:opacity-100" : "opacity-100",
          )}
        />
      </span>
    </button>
  )
}

interface ThreadLeadingGlyphProps {
  hasPendingInteraction: boolean
  isManagedChild: boolean
  isBusy: boolean
  showUnreadBadge: boolean
}

function ThreadLeadingGlyph({
  hasPendingInteraction,
  isManagedChild,
  isBusy,
  showUnreadBadge,
}: ThreadLeadingGlyphProps) {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-sidebar-foreground/60">
      {isManagedChild ? (
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 rotate-45" />
      ) : hasPendingInteraction ? (
        <span
          className="size-1.5 rounded-full bg-primary"
          aria-label="Pending interaction requires attention"
          title="Pending interaction"
        />
      ) : isBusy ? (
        <CircleDashed className="size-4 animate-spin" />
      ) : showUnreadBadge ? (
        <span
          className="size-1.5 rounded-full bg-primary"
          aria-label="Unread completed thread"
          title="Unread completion"
        />
      ) : null}
    </span>
  )
}

export function ThreadRow({
  projectId,
  thread,
  isActive,
  isActionsDisabled,
  onProjectSelect,
  onToggleManagerCollapsed,
  onToggleRead,
  onRename,
  onToggleArchive,
  onDelete,
  options,
}: ThreadRowProps) {
  const [isActionsOpen, setIsActionsOpen] = useState(false)
  const hasPendingInteraction = thread.parentThreadId === null && thread.hasPendingInteraction
  const threadIsBusy = isBusyThread(thread) && !hasPendingInteraction
  const showUnreadBadge = !hasPendingInteraction && isUnreadDoneThread(thread)
  const threadTitle = getThreadDisplayTitle(thread)
  const isManager = options.kind === "manager"
  const isManagedChild = options.kind === "managed-child"
  const hasManagedChildren = options.kind === "manager" && options.hasManagedChildren
  const isManagerCollapsed = options.kind === "manager" && options.isCollapsed
  const managedChildCount = options.kind === "manager" ? options.managedChildCount : 0
  const managedChildBusyCount =
    options.kind === "manager" ? options.managedChildBusyCount : 0
  const isManagerBusy = isManager && (threadIsBusy || managedChildBusyCount > 0)

  return (
    <div
      className={cn(
        "group/thread-row relative flex w-full items-center gap-2 rounded-md pr-0 text-sm transition-colors",
        isManagedChild ? "h-7" : "h-8",
        isManagedChild ? "pl-6 text-sidebar-foreground/60" : "pl-2",
        isActive
          ? "bg-sidebar-border/80 text-sidebar-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <NavLink
        to={`/projects/${projectId}/threads/${thread.id}`}
        onClick={onProjectSelect}
        aria-label={`Open ${threadTitle}`}
        title={`Open ${threadTitle}`}
        className="absolute inset-0 rounded-md outline-none ring-sidebar-ring focus-visible:ring-2"
      />
      {isManager && hasManagedChildren && onToggleManagerCollapsed ? (
        <ManagerChevron
          isCollapsed={isManagerCollapsed}
          isBusy={isManagerBusy}
          onToggle={() => {
            onToggleManagerCollapsed(thread.id)
          }}
          threadTitle={threadTitle}
        />
      ) : (
        <ThreadLeadingGlyph
          hasPendingInteraction={hasPendingInteraction}
          isManagedChild={isManagedChild}
          isBusy={threadIsBusy}
          showUnreadBadge={showUnreadBadge}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{threadTitle}</span>
      <span className="flex h-7 shrink-0 items-center justify-end">
        {isManager && managedChildCount > 0 ? (
          <span
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center"
            aria-label={`${managedChildCount} managed thread${managedChildCount === 1 ? "" : "s"}`}
            title={`${managedChildCount} managed thread${managedChildCount === 1 ? "" : "s"}`}
          >
            <SidebarMenuBadge className="rounded-full bg-sidebar-foreground/10 px-1.5 text-sidebar-foreground/80">
              {managedChildCount}
            </SidebarMenuBadge>
          </span>
        ) : null}
        <span className="relative h-7 w-7 shrink-0">
          <span
            className={cn(
              "absolute inset-0 flex items-center justify-center transition-opacity",
              isActionsOpen ? "opacity-0" : "group-hover/thread-row:opacity-0",
            )}
          >
            {isManager ? (
              <UserRound className="size-4 text-sidebar-foreground/70" aria-label="Manager" />
            ) : isManagedChild && threadIsBusy ? (
              <CircleDashed className="size-4 animate-spin text-sidebar-foreground/70" />
            ) : null}
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
              triggerClassName="h-7 w-7 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              onOpenChange={setIsActionsOpen}
              disabled={isActionsDisabled}
              isRead={(thread.lastReadAt ?? 0) >= thread.updatedAt}
              onToggleRead={() => {
                onToggleRead(thread)
              }}
              onRename={() => {
                onRename(thread)
              }}
              onToggleArchive={() => {
                onToggleArchive(thread)
              }}
              onDelete={() => {
                onDelete(thread)
              }}
              isArchived={thread.archivedAt != null}
              threadType={thread.type}
            />
          </div>
        </span>
      </span>
    </div>
  )
}
