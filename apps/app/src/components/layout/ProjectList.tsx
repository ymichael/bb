import { useEffect, useMemo, useState } from "react"
import { useAtom } from "jotai"
import { useQueryClient } from "@tanstack/react-query"
import type { Thread } from "@bb/domain"
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Folder,
  FolderOpen,
  MoreHorizontal,
  PencilLine,
  Plus,
  SquarePen,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react"
import {
  useArchiveThread,
  useDeleteThread,
  useDeleteProject,
  useMarkThreadRead,
  useMarkThreadUnread,
  useProjects,
  useThreads,
  useUnarchiveThread,
  useUpdateProject,
  useUpdateThread,
} from "@/hooks/useApi"
import { useHostDaemon } from "@/hooks/useHostDaemon"
import * as api from "@/lib/api"
import { NavLink, useLocation, useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { getThreadDisplayTitle, threadTypeLabel } from "@/lib/thread-title"
import {
  isBusyThread,
  isUnreadDoneThread,
} from "@/lib/thread-activity"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/shared/EmptyState"
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu"
import {
  ThreadRenameDialog,
  type ThreadRenameDialogTarget,
} from "@/components/thread/ThreadRenameDialog"
import { ThreadDeleteDialog } from "@/components/thread/ThreadDeleteDialog"
import { useDialogState } from "@/hooks/useDialogState"
import {
  isArchiveForceRequiredError,
} from "@/lib/thread-archive"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { atomWithStorage } from "jotai/utils"
import { createJsonLocalStorage } from "@/lib/browser-storage"

interface ProjectListProps {
  onNewProject?: () => void
  onProjectSelect?: () => void
  selectedProjectId?: string
  isCreatingProject?: boolean
}

const COLLAPSED_PROJECTS_STORAGE_KEY = "bb.sidebar.collapsedProjects"
const COLLAPSED_MANAGERS_STORAGE_KEY = "bb.sidebar.collapsedManagers"
const collapsedProjectIdsAtom = atomWithStorage<string[]>(
  COLLAPSED_PROJECTS_STORAGE_KEY,
  [],
  createJsonLocalStorage<string[]>(),
  { getOnInit: true },
)
const collapsedManagerIdsAtom = atomWithStorage<string[]>(
  COLLAPSED_MANAGERS_STORAGE_KEY,
  [],
  createJsonLocalStorage<string[]>(),
  { getOnInit: true },
)

function ManagedThreadBranchGlyph() {
  return (
    <ChevronDown
      aria-hidden="true"
      className="size-4 shrink-0 rotate-45 text-sidebar-foreground/60"
    />
  )
}

export function ProjectList({
  onNewProject,
  onProjectSelect,
  selectedProjectId,
  isCreatingProject = false,
}: ProjectListProps) {
  const { data: projects, isLoading: projectsLoading } = useProjects()
  const { data: threads, isLoading: threadsLoading } = useThreads()
  const archiveThread = useArchiveThread()
  const markThreadRead = useMarkThreadRead()
  const markThreadUnread = useMarkThreadUnread()
  const updateThread = useUpdateThread()
  const unarchiveThread = useUnarchiveThread()
  const deleteThread = useDeleteThread()
  const updateProject = useUpdateProject()
  const deleteProject = useDeleteProject()
  const queryClient = useQueryClient()
  const { localHostId, pickFolder } = useHostDaemon()
  const location = useLocation()
  const navigate = useNavigate()
  const [collapsedProjectIdList, setCollapsedProjectIdList] = useAtom(collapsedProjectIdsAtom)
  const [collapsedManagerIdList, setCollapsedManagerIdList] = useAtom(collapsedManagerIdsAtom)
  const [openThreadActionsThreadId, setOpenThreadActionsThreadId] = useState<string | null>(null)
  const archiveConfirmationDialog = useDialogState<Thread>()
  const threadRenameDialog = useDialogState<ThreadRenameDialogTarget>()
  const threadDeleteDialog = useDialogState<Thread>()

  const selectedThreadId = location.pathname.match(
    /^\/projects\/[^/]+\/threads\/([^/]+)/
  )?.[1]
  const collapsedProjectIds = useMemo(
    () => new Set(collapsedProjectIdList),
    [collapsedProjectIdList],
  )
  const collapsedManagerIds = useMemo(
    () => new Set(collapsedManagerIdList),
    [collapsedManagerIdList],
  )

  const threadsByProject = useMemo(() => {
    const grouped = new Map<string, Thread[]>()

    for (const thread of threads ?? []) {
      if (thread.archivedAt != null) continue
      const existing = grouped.get(thread.projectId)
      if (existing) {
        existing.push(thread)
      } else {
        grouped.set(thread.projectId, [thread])
      }
    }

    for (const projectThreads of grouped.values()) {
      projectThreads.sort((a, b) => b.createdAt - a.createdAt)
    }

    return grouped
  }, [threads])

  useEffect(() => {
    const archiveConfirmationTarget = archiveConfirmationDialog.target
    if (!archiveConfirmationTarget || !threads) return

    const nextThread = threads.find((thread) => thread.id === archiveConfirmationTarget.id)
    if (!nextThread || nextThread.archivedAt != null) {
      archiveConfirmationDialog.onClose()
    }
  }, [archiveConfirmationDialog.onClose, archiveConfirmationDialog.target, threads])

  const toggleProjectCollapsed = (projectId: string) => {
    setCollapsedProjectIdList((current) => {
      const next = new Set(current)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return Array.from(next)
    })
  }

  const toggleManagerCollapsed = (threadId: string) => {
    setCollapsedManagerIdList((current) => {
      const next = new Set(current)
      if (next.has(threadId)) {
        next.delete(threadId)
      } else {
        next.add(threadId)
      }
      return Array.from(next)
    })
  }

  const renameProject = (projectId: string, currentName: string) => {
    if (updateProject.isPending) return

    const typedName = window.prompt("Enter a new project name:", currentName)
    if (typedName == null) return

    const nextName = typedName.trim()
    if (!nextName) {
      window.alert("Project name cannot be empty.")
      return
    }

    updateProject.mutate({
      id: projectId,
      name: nextName,
    })
  }

  const upsertProjectSourcePath = async (projectId: string) => {
    if (!pickFolder || !localHostId) return
    const selectedPath = await pickFolder()
    if (!selectedPath) return
    const project = projects?.find((p) => p.id === projectId)
    const existingSource = project?.sources?.find(
      (s: { hostId: string }) => s.hostId === localHostId,
    )
    try {
      if (existingSource) {
        await api.updateProjectSource(projectId, existingSource.id, { type: "local_path", path: selectedPath })
      } else {
        await api.addProjectSource(projectId, {
          hostId: localHostId,
          type: "local_path",
          path: selectedPath,
        })
      }
      queryClient.invalidateQueries({ queryKey: ["projects"] })
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to update project source")
    }
  }

  const changeProjectPath = async (projectId: string) => {
    await upsertProjectSourcePath(projectId)
  }

  const repairProjectPath = async (projectId: string, _fallbackName: string) => {
    await upsertProjectSourcePath(projectId)
  }

  const removeProject = (projectId: string, projectName: string) => {
    if (deleteProject.isPending) return
    const confirmed = window.confirm(
      `Remove "${projectName}" and all of its threads? This cannot be undone.`
    )
    if (!confirmed) return

    deleteProject.mutate(projectId, {
      onSuccess: () => {
        setCollapsedProjectIdList((current) => {
          const next = new Set(current)
          next.delete(projectId)
          return Array.from(next)
        })
        if (selectedProjectId === projectId) {
          navigate("/", { replace: true })
        }
      },
    })
  }

  const requestArchiveThread = (thread: Thread) => {
    if (archiveThread.isPending) return

    // Client-side confirmation is deferred to the server — if the environment
    // has uncommitted changes, the server returns 409 and we show the dialog.
    archiveThread.mutate({ id: thread.id, force: false }, {
      onError: (error) => {
        if (isArchiveForceRequiredError(error)) {
          archiveConfirmationDialog.onOpen(thread)
          return
        }
        toast.error(
          error instanceof Error ? error.message : `Failed to archive ${threadTypeLabel(thread.type)}.`,
        )
      },
    })
  }

  const requestRenameThread = (thread: Thread) => {
    if (updateThread.isPending) return

    threadRenameDialog.onOpen({
      id: thread.id,
      currentTitle: getThreadDisplayTitle(thread),
      threadType: thread.type,
    })
  }

  const submitThreadRename = (threadId: string, title: string) => {
    updateThread.mutate(
      {
        id: threadId,
        title,
      },
      {
        onSuccess: () => {
          threadRenameDialog.onClose()
        },
      }
    )
  }

  const requestDeleteThread = (thread: Thread) => {
    if (deleteThread.isPending) return
    threadDeleteDialog.onOpen(thread)
  }

  const confirmDeleteThread = (thread: Thread) => {
    deleteThread.mutate(
      { id: thread.id },
      {
        onSuccess: () => {
          threadDeleteDialog.onClose()
          if (selectedThreadId === thread.id) {
            navigate(`/projects/${thread.projectId}`, { replace: true })
          }
        },
        onError: (error) => {
          toast.error(
            error instanceof Error ? error.message : `Failed to delete ${threadTypeLabel(thread.type)}.`,
          )
        },
      }
    )
  }

  const confirmArchiveThread = () => {
    if (!archiveConfirmationDialog.target || archiveThread.isPending) return

    const threadId = archiveConfirmationDialog.target.id
    const label = threadTypeLabel(archiveConfirmationDialog.target.type)
    archiveConfirmationDialog.onClose()
    archiveThread.mutate(
      { id: threadId, force: true },
      {
        onError: (error) => {
          toast.error(
            error instanceof Error ? error.message : `Failed to archive ${label}.`,
          )
        },
      }
    )
  }

  const renderThreadRow = (
    projectId: string,
    thread: Thread,
    options?: {
      isManagedChild?: boolean
      isManager?: boolean
      hasManagedChildren?: boolean
      isManagerCollapsed?: boolean
      managedChildCount?: number
      managedChildBusyCount?: number
    }
  ) => {
    const threadIsBusy = isBusyThread(thread)
    const showUnreadBadge = isUnreadDoneThread(thread)
    const isThreadActionsOpen = openThreadActionsThreadId === thread.id
    const isThreadActive = selectedThreadId === thread.id
    const threadTitle = getThreadDisplayTitle(thread)
    const isManager = options?.isManager === true
    const isManagedChild = options?.isManagedChild === true
    const hasManagedChildren = options?.hasManagedChildren === true
    const isManagerCollapsed = options?.isManagerCollapsed === true
    const managedChildCount = options?.managedChildCount ?? 0
    const managedChildBusyCount = options?.managedChildBusyCount ?? 0

    return (
      <div
        key={thread.id}
        className={cn(
          "group/thread-row relative flex h-8 w-full items-center gap-2 rounded-md pr-0 text-sm transition-colors",
          isManagedChild ? "pl-6 text-sidebar-foreground/60" : "pl-2",
          isThreadActive
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
        {isManager && hasManagedChildren ? (
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
              toggleManagerCollapsed(thread.id)
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
                isThreadActionsOpen ? "opacity-0" : "group-hover/thread-row:opacity-0",
              )}
            >
              {isManager ? (
                <UserRound className="size-4 text-sidebar-foreground/70" aria-label="Manager" />
              ) : null}
            </span>
            <div
              className={cn(
                "absolute inset-0 z-10 flex items-center justify-end transition-opacity",
                isThreadActionsOpen
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0 group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100",
              )}
            >
              <ThreadActionsMenu
                triggerClassName="h-7 w-7 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                onOpenChange={(open) => {
                  setOpenThreadActionsThreadId(open ? thread.id : null)
                }}
                disabled={
                  archiveThread.isPending ||
                  unarchiveThread.isPending ||
                  deleteThread.isPending ||
                  updateThread.isPending ||
                  markThreadRead.isPending ||
                  markThreadUnread.isPending
                }
                isRead={(thread.lastReadAt ?? 0) >= thread.updatedAt}
                onToggleRead={() => {
                  if ((thread.lastReadAt ?? 0) >= thread.updatedAt) {
                    markThreadUnread.mutate(thread.id)
                    return
                  }
                  markThreadRead.mutate(thread.id)
                }}
                onRename={() => {
                  requestRenameThread(thread)
                }}
                onToggleArchive={() => {
                  if (thread.archivedAt != null) {
                    unarchiveThread.mutate({ id: thread.id })
                    return
                  }
                  void requestArchiveThread(thread)
                }}
                onDelete={() => {
                  requestDeleteThread(thread)
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

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="flex items-center justify-between pr-1 mb-1">
        Projects
        {onNewProject ? <button
          type="button"
          onClick={onNewProject}
          disabled={isCreatingProject}
          title={isCreatingProject ? "Creating project..." : "Add project"}
          aria-label="Add project"
          className="inline-flex size-5 items-center justify-center rounded text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground disabled:opacity-50"
        >
          <Plus className="size-4" />
        </button> : null}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-2">
          {projectsLoading ? (
            <>
              <SidebarMenuSkeleton />
              <SidebarMenuSkeleton />
            </>
          ) : projects && projects.length > 0 ? (
            projects.map((project) => {
              const projectThreads = threadsByProject.get(project.id) ?? []
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
                } else {
                  managedThreadsByManagerId.set(thread.parentThreadId, [thread])
                }
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
              const isProjectCollapsed = collapsedProjectIds.has(project.id)
              const isProjectActive =
                selectedProjectId === project.id && !selectedThreadId
              const localSource = localHostId
                ? project.sources?.find((s: { hostId: string }) => s.hostId === localHostId)
                : undefined
              const isProjectPathMissing = localHostId != null && !localSource

              return (
                <SidebarMenuItem key={project.id} className="space-y-1">
                  <div
                    className={cn(
                      "group/project-row relative flex h-8 w-full items-center rounded-md text-sm transition-colors",
                      isProjectPathMissing
                        ? "border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15"
                        : isProjectActive
                          ? "bg-sidebar-border/80 text-sidebar-foreground"
                          : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
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
                      aria-expanded={!isProjectCollapsed}
                      aria-label={
                        isProjectCollapsed
                          ? `Expand ${project.name}`
                          : `Collapse ${project.name}`
                      }
                      title={
                        isProjectCollapsed ? "Expand project threads" : "Collapse project threads"
                      }
                      onClick={() => toggleProjectCollapsed(project.id)}
                      className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2"
                    >
                      <span className="relative inline-flex size-4 items-center justify-center">
                        <ChevronRight
                          className={cn(
                            "absolute size-4 opacity-0 transition-all duration-150 group-hover/project-row:opacity-100",
                            !isProjectCollapsed && "rotate-90"
                          )}
                        />
                        {isProjectCollapsed ? (
                          <Folder className="absolute size-4 opacity-100 transition-opacity duration-150 group-hover/project-row:opacity-0" />
                        ) : (
                          <FolderOpen className="absolute size-4 opacity-100 transition-opacity duration-150 group-hover/project-row:opacity-0" />
                        )}
                      </span>
                    </button>
                    <span className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center">
                      <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                      {isProjectPathMissing ? (
                        <AlertTriangle
                          className="ml-1 size-3.5 shrink-0 text-destructive"
                          aria-hidden
                        />
                      ) : null}
                    </span>
                    {isProjectPathMissing ? (
                      <button
                        type="button"
                        title="Project folder is missing. Choose a new folder."
                        aria-label="Repair project path"
                        className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-destructive outline-none ring-sidebar-ring transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={updateProject.isPending}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void repairProjectPath(project.id, project.name)
                        }}
                      >
                        {updateProject.isPending ? (
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
                          disabled={updateProject.isPending || deleteProject.isPending}
                          onSelect={(event) => {
                            event.preventDefault()
                            renameProject(project.id, project.name)
                          }}
                        >
                          <PencilLine className="size-4" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={updateProject.isPending || deleteProject.isPending}
                          onSelect={(event) => {
                            event.preventDefault()
                            void changeProjectPath(project.id)
                          }}
                        >
                          <Wrench className="size-4" />
                          Change path
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          disabled={deleteProject.isPending || updateProject.isPending}
                          onSelect={(event) => {
                            event.preventDefault()
                            removeProject(project.id, project.name)
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

                  {!isProjectCollapsed ? (
                    threadsLoading ? (
                      <div className="group-data-[collapsible=icon]:hidden">
                        <SidebarMenuSkeleton />
                      </div>
                    ) : projectThreads.length > 0 ? (
                      <div className="space-y-1 group-data-[collapsible=icon]:hidden">
                        {managerThreads.map((thread) => (
                          <div
                            key={thread.id}
                            className="space-y-1"
                          >
                            {(() => {
                              const managedChildren = managedThreadsByManagerId.get(thread.id) ?? []
                              return renderThreadRow(project.id, thread, {
                                isManager: true,
                                hasManagedChildren: managedChildren.length > 0,
                                isManagerCollapsed: collapsedManagerIds.has(thread.id),
                                managedChildCount: managedChildren.length,
                                managedChildBusyCount: managedChildren.filter(isBusyThread).length,
                              })
                            })()}
                            {!collapsedManagerIds.has(thread.id) &&
                            (managedThreadsByManagerId.get(thread.id)?.length ?? 0) > 0 ? (
                              <div className="space-y-1">
                                {(managedThreadsByManagerId.get(thread.id) ?? []).map((childThread) =>
                                  renderThreadRow(project.id, childThread, {
                                    isManagedChild: true,
                                  })
                                )}
                              </div>
                            ) : null}
                          </div>
                        ))}
                        {otherThreads.map((thread) => renderThreadRow(project.id, thread))}
                      </div>
                    ) : (
                      <EmptyState
                        message="No threads"
                        icon={FolderOpen}
                        className="py-0.5 pl-8 pr-2 group-data-[collapsible=icon]:hidden"
                        iconClassName="size-3.5 text-sidebar-foreground/50"
                        messageClassName="text-xs leading-4 text-sidebar-foreground/60"
                      />
                    )
                  ) : null}
                </SidebarMenuItem>
              )
            })
          ) : (
            <SidebarMenuItem>
              <EmptyState
                message="No projects"
                icon={Folder}
                className="px-2 py-1.5"
                iconClassName="size-3.5"
                messageClassName="text-xs"
              />
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
      <Dialog
        open={archiveConfirmationDialog.isOpen}
        onOpenChange={archiveConfirmationDialog.onOpenChange}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-destructive" />
              Archive and clean up workspace?
            </DialogTitle>
            <DialogDescription>
              This {archiveConfirmationDialog.target ? threadTypeLabel(archiveConfirmationDialog.target.type) : "thread"} has uncommitted or unmerged work in its worktree. Archiving will remove
              that workspace and changes may be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={archiveConfirmationDialog.onClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!archiveConfirmationDialog.target || archiveThread.isPending}
              onClick={confirmArchiveThread}
            >
              Archive anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ThreadRenameDialog
        target={threadRenameDialog.target}
        pending={updateThread.isPending}
        onOpenChange={threadRenameDialog.onOpenChange}
        onRename={submitThreadRename}
      />
      <ThreadDeleteDialog
        target={threadDeleteDialog.target}
        pending={deleteThread.isPending}
        onOpenChange={threadDeleteDialog.onOpenChange}
        onDelete={confirmDeleteThread}
      />
    </SidebarGroup>
  )
}
