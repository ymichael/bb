import { useState } from "react"
import type { Thread } from "@bb/domain"
import {
  ChevronDown,
  ChevronRight,
  CircleDashed,
  UserRound,
} from "lucide-react"
import { NavLink } from "react-router-dom"
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu"
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
  thread: Thread
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

function ManagedThreadBranchGlyph() {
  return (
    <ChevronDown
      aria-hidden="true"
      className="size-4 shrink-0 rotate-45 text-sidebar-foreground/60"
    />
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
  const threadIsBusy = isBusyThread(thread)
  const showUnreadBadge = isUnreadDoneThread(thread)
  const threadTitle = getThreadDisplayTitle(thread)
  const isManager = options.kind === "manager"
  const isManagedChild = options.kind === "managed-child"
  const hasManagedChildren = options.kind === "manager" && options.hasManagedChildren
  const isManagerCollapsed = options.kind === "manager" && options.isCollapsed
  const managedChildCount = options.kind === "manager" ? options.managedChildCount : 0
  const managedChildBusyCount =
    options.kind === "manager" ? options.managedChildBusyCount : 0

  return (
    <div
      className={cn(
        "group/thread-row relative flex h-8 w-full items-center gap-2 rounded-md pr-0 text-sm transition-colors",
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
        <button
          type="button"
          aria-expanded={!isManagerCollapsed}
          aria-label={
            isManagerCollapsed
              ? `Expand ${threadTitle} threads`
              : `Collapse ${threadTitle} threads`
          }
          title={isManagerCollapsed ? "Expand managed threads" : "Collapse managed threads"}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onToggleManagerCollapsed(thread.id)
          }}
          className="relative z-10 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none ring-sidebar-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2"
        >
          <ChevronRight
            className={cn("size-4 transition-transform", !isManagerCollapsed && "rotate-90")}
          />
        </button>
      ) : (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-sidebar-foreground/60">
          {isManagedChild ? (
            <ManagedThreadBranchGlyph />
          ) : threadIsBusy ? (
            <CircleDashed className="size-3.5 animate-spin" />
          ) : showUnreadBadge ? (
            <span
              className="size-1.5 rounded-full bg-primary"
              aria-label="Unread completed thread"
              title="Unread completion"
            />
          ) : null}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{threadTitle}</span>
      {isManager && isManagerCollapsed && managedChildCount > 0 ? (
        <span className="flex shrink-0 items-center gap-1 pl-1">
          {managedChildBusyCount > 0 ? (
            <CircleDashed className="size-3 animate-spin text-sidebar-foreground/60" />
          ) : null}
          <span className="text-xs tabular-nums text-sidebar-foreground/50">
            ({managedChildCount})
          </span>
        </span>
      ) : null}
      <span className="flex h-7 shrink-0 items-center justify-end gap-1 pl-1">
        <span className="relative h-7 w-7 shrink-0">
          <span
            className={cn(
              "absolute inset-0 flex items-center justify-center transition-opacity",
              isActionsOpen ? "opacity-0" : "group-hover/thread-row:opacity-0",
            )}
          >
            {isManager ? (
              <UserRound className="size-4 text-sidebar-foreground/70" aria-label="Manager" />
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
