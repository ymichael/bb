import { useMemo } from "react"
import {
  findLocalPathProjectSourceForHost,
  type Thread,
} from "@bb/domain"
import type { ProjectResponse } from "@bb/server-contract"
import {
  AlertTriangle,
  ChevronRight,
  CircleDashed,
  Folder,
  FolderOpen,
  MoreHorizontal,
  PencilLine,
  SquarePen,
  Trash2,
  Wrench,
} from "lucide-react"
import { NavLink } from "react-router-dom"
import { EmptyState } from "@/components/shared/EmptyState"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenuItem, SidebarMenuSkeleton } from "@/components/ui/sidebar"
import { isBusyThread } from "@/lib/thread-activity"
import { cn } from "@/lib/utils"
import { ThreadRow } from "./ThreadRow"

interface ProjectRowProps {
  project: ProjectResponse
  projectThreads: Thread[]
  threadsLoading: boolean
  localHostId: string | null | undefined
  selectedThreadId?: string
  isActive: boolean
  isCollapsed: boolean
  collapsedManagerIds: Set<string>
  isProjectRenamePending: boolean
  isProjectDeletePending: boolean
  isPathUpdating: boolean
  areThreadActionsDisabled: boolean
  onProjectSelect?: () => void
  onToggleProjectCollapsed: (projectId: string) => void
  onToggleManagerCollapsed: (threadId: string) => void
  onRenameProject: (project: ProjectResponse) => void
  onChangeProjectPath: (projectId: string) => void
  onRepairProjectPath: (projectId: string) => void
  onDeleteProject: (project: ProjectResponse) => void
  onRenameThread: (thread: Thread) => void
  onToggleThreadArchive: (thread: Thread) => void
  onDeleteThread: (thread: Thread) => void
  onToggleThreadRead: (thread: Thread) => void
}

interface ProjectThreadGroups {
  managerThreads: Thread[]
  managedThreadsByManagerId: Map<string, Thread[]>
  otherThreads: Thread[]
}

function buildProjectThreadGroups(projectThreads: Thread[]): ProjectThreadGroups {
  const managerThreads = projectThreads
    .filter((thread) => thread.type === "manager")
    .sort((a, b) => b.createdAt - a.createdAt)
  const managerThreadIds = new Set(managerThreads.map((thread) => thread.id))
  const managedThreadsByManagerId = new Map<string, Thread[]>()

  for (const thread of projectThreads) {
    if (thread.type !== "standard" || !thread.parentThreadId) continue
    if (!managerThreadIds.has(thread.parentThreadId)) continue

    const existing = managedThreadsByManagerId.get(thread.parentThreadId)
    if (existing) {
      existing.push(thread)
      continue
    }

    managedThreadsByManagerId.set(thread.parentThreadId, [thread])
  }

  for (const managedThreads of managedThreadsByManagerId.values()) {
    managedThreads.sort((a, b) => b.createdAt - a.createdAt)
  }

  const otherThreads = projectThreads
    .filter((thread) => {
      if (thread.type === "manager") return false
      if (!thread.parentThreadId) return true
      return !managerThreadIds.has(thread.parentThreadId)
    })
    .sort((a, b) => b.createdAt - a.createdAt)

  return {
    managerThreads,
    managedThreadsByManagerId,
    otherThreads,
  }
}

export function ProjectRow({
  project,
  projectThreads,
  threadsLoading,
  localHostId,
  selectedThreadId,
  isActive,
  isCollapsed,
  collapsedManagerIds,
  isProjectRenamePending,
  isProjectDeletePending,
  isPathUpdating,
  areThreadActionsDisabled,
  onProjectSelect,
  onToggleProjectCollapsed,
  onToggleManagerCollapsed,
  onRenameProject,
  onChangeProjectPath,
  onRepairProjectPath,
  onDeleteProject,
  onRenameThread,
  onToggleThreadArchive,
  onDeleteThread,
  onToggleThreadRead,
}: ProjectRowProps) {
  const { managerThreads, managedThreadsByManagerId, otherThreads } = useMemo(
    () => buildProjectThreadGroups(projectThreads),
    [projectThreads],
  )
  const localSource = localHostId
    ? findLocalPathProjectSourceForHost(project.sources, localHostId)
    : undefined
  const isProjectPathMissing = localHostId != null && !localSource
  const isProjectActionsDisabled =
    isProjectRenamePending || isProjectDeletePending || isPathUpdating

  return (
    <SidebarMenuItem className="space-y-1">
      <div
        className={cn(
          "group/project-row relative flex h-8 w-full items-center rounded-md text-sm transition-colors",
          isProjectPathMissing
            ? "border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15"
            : isActive
              ? "bg-sidebar-border/80 text-sidebar-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
        title={project.name}
      >
        <NavLink
          to={`/projects/${project.id}`}
          onClick={onProjectSelect}
          className="absolute inset-0 rounded-md outline-none ring-sidebar-ring focus-visible:ring-2"
        />
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
          title={isCollapsed ? "Expand project threads" : "Collapse project threads"}
          onClick={() => {
            onToggleProjectCollapsed(project.id)
          }}
          className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2"
        >
          <span className="relative inline-flex size-4 items-center justify-center">
            <ChevronRight
              className={cn(
                "absolute size-4 opacity-0 transition-all duration-150 group-hover/project-row:opacity-100",
                !isCollapsed && "rotate-90",
              )}
            />
            {isCollapsed ? (
              <Folder className="absolute size-4 opacity-100 transition-opacity duration-150 group-hover/project-row:opacity-0" />
            ) : (
              <FolderOpen className="absolute size-4 opacity-100 transition-opacity duration-150 group-hover/project-row:opacity-0" />
            )}
          </span>
        </button>
        <span className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center">
          <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
          {isProjectPathMissing ? (
            <AlertTriangle className="ml-1 size-3.5 shrink-0 text-destructive" aria-hidden />
          ) : null}
        </span>
        {isProjectPathMissing ? (
          <button
            type="button"
            title="Project folder is missing. Choose a new folder."
            aria-label="Repair project path"
            className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-destructive outline-none ring-sidebar-ring transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isProjectActionsDisabled}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void onRepairProjectPath(project.id)
            }}
          >
            {isPathUpdating ? (
              <CircleDashed className="size-4 animate-spin" />
            ) : (
              <Wrench className="size-4" />
            )}
          </button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={`${project.name} options`}
              aria-label={`${project.name} options`}
              className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              disabled={isProjectActionsDisabled}
              onSelect={(event) => {
                event.preventDefault()
                onRenameProject(project)
              }}
            >
              <PencilLine className="size-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isProjectActionsDisabled}
              onSelect={(event) => {
                event.preventDefault()
                void onChangeProjectPath(project.id)
              }}
            >
              <Wrench className="size-4" />
              Change path
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={isProjectActionsDisabled}
              onSelect={(event) => {
                event.preventDefault()
                onDeleteProject(project)
              }}
            >
              <Trash2 className="size-4" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <NavLink
          to={`/projects/${project.id}`}
          state={{ focusPrompt: true }}
          onClick={(event) => {
            event.stopPropagation()
            onProjectSelect?.()
          }}
          title={`Open ${project.name}`}
          aria-label={`Open ${project.name}`}
          className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2"
        >
          <SquarePen className="size-4" />
        </NavLink>
      </div>

      {!isCollapsed ? (
        threadsLoading ? (
          <div className="group-data-[collapsible=icon]:hidden">
            <SidebarMenuSkeleton />
          </div>
        ) : projectThreads.length > 0 ? (
          <div className="space-y-1 group-data-[collapsible=icon]:hidden">
            {managerThreads.map((thread) => {
              const managedChildren = managedThreadsByManagerId.get(thread.id) ?? []
              const isManagerCollapsed = collapsedManagerIds.has(thread.id)

              return (
                <div key={thread.id} className="space-y-1">
                  <ThreadRow
                    projectId={project.id}
                    thread={thread}
                    isActive={selectedThreadId === thread.id}
                    isActionsDisabled={areThreadActionsDisabled}
                    onProjectSelect={onProjectSelect}
                    onToggleManagerCollapsed={onToggleManagerCollapsed}
                    onToggleRead={onToggleThreadRead}
                    onRename={onRenameThread}
                    onToggleArchive={onToggleThreadArchive}
                    onDelete={onDeleteThread}
                    options={{
                      kind: "manager",
                      hasManagedChildren: managedChildren.length > 0,
                      isCollapsed: isManagerCollapsed,
                      managedChildCount: managedChildren.length,
                      managedChildBusyCount: managedChildren.filter(isBusyThread).length,
                    }}
                  />
                  {!isManagerCollapsed && managedChildren.length > 0 ? (
                    <div className="space-y-1">
                      {managedChildren.map((childThread) => (
                        <ThreadRow
                          key={childThread.id}
                          projectId={project.id}
                          thread={childThread}
                          isActive={selectedThreadId === childThread.id}
                          isActionsDisabled={areThreadActionsDisabled}
                          onProjectSelect={onProjectSelect}
                          onToggleRead={onToggleThreadRead}
                          onRename={onRenameThread}
                          onToggleArchive={onToggleThreadArchive}
                          onDelete={onDeleteThread}
                          options={{ kind: "managed-child" }}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
            {otherThreads.map((thread) => (
              <ThreadRow
                key={thread.id}
                projectId={project.id}
                thread={thread}
                isActive={selectedThreadId === thread.id}
                isActionsDisabled={areThreadActionsDisabled}
                onProjectSelect={onProjectSelect}
                onToggleRead={onToggleThreadRead}
                onRename={onRenameThread}
                onToggleArchive={onToggleThreadArchive}
                onDelete={onDeleteThread}
                options={{ kind: "default" }}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            message="No threads"
            className="py-0.5 pl-8 pr-2 group-data-[collapsible=icon]:hidden"
            messageClassName="text-xs leading-4 text-sidebar-foreground/60"
          />
        )
      ) : null}
    </SidebarMenuItem>
  )
}
