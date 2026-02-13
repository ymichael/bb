import { useEffect, useMemo, useState } from "react"
import type { Task, Thread } from "@beanbag/core"
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Circle,
  Folder,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  Plus,
  SquarePen,
} from "lucide-react"
import { useArchiveThread, useProjects, useTasks, useThreads } from "@/hooks/useApi"
import { NavLink, useLocation } from "react-router-dom"
import { cn } from "@/lib/utils"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"

interface ProjectListProps {
  onNewProject: () => void
  onProjectSelect?: () => void
  selectedProjectId?: string
  isCreatingProject?: boolean
}

const COLLAPSED_PROJECTS_STORAGE_KEY = "beanbag.sidebar.collapsedProjects"

type ProjectItem =
  | { kind: "thread"; thread: Thread; updatedAt: number }
  | { kind: "task"; task: Task; updatedAt: number }

export function ProjectList({
  onNewProject,
  onProjectSelect,
  selectedProjectId,
  isCreatingProject = false,
}: ProjectListProps) {
  const { data: projects, isLoading: projectsLoading } = useProjects()
  const { data: threads, isLoading: threadsLoading } = useThreads()
  const { data: tasks, isLoading: tasksLoading } = useTasks()
  const archiveThread = useArchiveThread()
  const location = useLocation()
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    () => {
      if (typeof window === "undefined") return new Set()

      try {
        const raw = window.localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY)
        if (!raw) return new Set()
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return new Set()
        return new Set(parsed.filter((value): value is string => typeof value === "string"))
      } catch {
        return new Set()
      }
    }
  )

  const selectedThreadId = location.pathname.match(
    /^\/projects\/[^/]+\/threads\/([^/]+)/
  )?.[1]
  const selectedTaskId = location.pathname.match(
    /^\/projects\/[^/]+\/tasks\/([^/]+)/
  )?.[1]

  const itemsByProject = useMemo(() => {
    const grouped = new Map<string, ProjectItem[]>()

    for (const projectThread of threads ?? []) {
      const existing = grouped.get(projectThread.projectId)
      const item: ProjectItem = {
        kind: "thread",
        thread: projectThread,
        updatedAt: projectThread.updatedAt,
      }
      if (existing) {
        existing.push(item)
      } else {
        grouped.set(projectThread.projectId, [item])
      }
    }

    for (const projectTask of tasks ?? []) {
      const existing = grouped.get(projectTask.projectId)
      const item: ProjectItem = {
        kind: "task",
        task: projectTask,
        updatedAt: projectTask.updatedAt,
      }
      if (existing) {
        existing.push(item)
      } else {
        grouped.set(projectTask.projectId, [item])
      }
    }

    for (const projectItems of grouped.values()) {
      projectItems.sort((a, b) => b.updatedAt - a.updatedAt)
    }

    return grouped
  }, [tasks, threads])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(
      COLLAPSED_PROJECTS_STORAGE_KEY,
      JSON.stringify(Array.from(collapsedProjectIds))
    )
  }, [collapsedProjectIds])

  const toggleProjectCollapsed = (projectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Projects</SidebarGroupLabel>
      <SidebarGroupAction
        onClick={onNewProject}
        title={isCreatingProject ? "Creating project..." : "New project"}
        disabled={isCreatingProject}
      >
        <Plus />
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {projectsLoading ? (
            <>
              <SidebarMenuSkeleton />
              <SidebarMenuSkeleton />
            </>
          ) : projects && projects.length > 0 ? (
            projects.map((project) => {
              const projectItems = itemsByProject.get(project.id) ?? []
              const isProjectItemsLoading = threadsLoading || tasksLoading
              const isProjectCollapsed = collapsedProjectIds.has(project.id)
              const isProjectActive =
                selectedProjectId === project.id && !selectedThreadId && !selectedTaskId

              return (
                <SidebarMenuItem key={project.id} className="space-y-1">
                  <div
                    className={cn(
                      "group/project-row flex h-8 w-full items-center rounded-md text-sm transition-colors",
                      isProjectActive
                        ? "bg-sidebar-border/80 text-sidebar-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    )}
                    title={project.rootPath}
                  >
                    <button
                      type="button"
                      aria-expanded={!isProjectCollapsed}
                      aria-label={
                        isProjectCollapsed
                          ? `Expand ${project.name}`
                          : `Collapse ${project.name}`
                      }
                      title={
                        isProjectCollapsed ? "Expand project items" : "Collapse project items"
                      }
                      onClick={() => toggleProjectCollapsed(project.id)}
                      className="flex min-w-0 flex-1 items-center"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2">
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
                      </span>
                      <span className="min-w-0 flex-1 truncate pr-2 text-left">
                        {project.name}
                      </span>
                    </button>
                    <NavLink
                      to={`/projects/${project.id}`}
                      state={{ focusPrompt: true }}
                      onClick={(event) => {
                        event.stopPropagation()
                        onProjectSelect?.()
                      }}
                      title={`Open ${project.name}`}
                      aria-label={`Open ${project.name}`}
                      className="mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2"
                    >
                      <SquarePen className="size-4" />
                    </NavLink>
                  </div>

                  {!isProjectCollapsed && !isProjectItemsLoading && projectItems.length > 0 ? (
                    <div className="space-y-1 group-data-[collapsible=icon]:hidden">
                      {projectItems.map((item) => {
                        if (item.kind === "thread") {
                          const thread = item.thread
                          const isBusyThread =
                            thread.status === "active" ||
                            thread.status === "created" ||
                            thread.status === "provisioning"

                          return (
                            <NavLink
                              key={thread.id}
                              to={`/projects/${project.id}/threads/${thread.id}`}
                              onClick={onProjectSelect}
                              className={({ isActive }) =>
                                cn(
                                  "group/thread-row flex h-8 w-full items-center gap-2 rounded-md p-2 text-sm transition-colors",
                                  isActive
                                    ? "bg-sidebar-border/80 text-sidebar-foreground"
                                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                                )
                              }
                            >
                              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-sidebar-foreground/60">
                                {isBusyThread ? (
                                  <LoaderCircle className="size-3.5 animate-spin" />
                                ) : (
                                  <MessageSquare className="size-3.5" />
                                )}
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {thread.title ?? `Thread ${thread.id.slice(0, 8)}`}
                              </span>
                              <span className="relative shrink-0 text-xs text-sidebar-foreground/60">
                                <span className="inline-block min-w-8 text-right transition-opacity group-hover/thread-row:opacity-0">
                                  {formatRelativeTime(thread.updatedAt)}
                                </span>
                                <button
                                  type="button"
                                  title="Archive thread"
                                  aria-label="Archive thread"
                                  className="pointer-events-none absolute inset-0 flex items-center justify-end opacity-0 transition-opacity group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100"
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    if (archiveThread.isPending) return
                                    archiveThread.mutate(thread.id)
                                  }}
                                >
                                  <Archive className="size-3.5" />
                                </button>
                              </span>
                            </NavLink>
                          )
                        }

                        const task = item.task
                        return (
                          <NavLink
                            key={task.id}
                            to={`/projects/${project.id}/tasks/${task.id}`}
                            onClick={onProjectSelect}
                            className={({ isActive }) =>
                              cn(
                                "group/task-row flex h-8 w-full items-center gap-2 rounded-md p-2 text-sm transition-colors",
                                isActive
                                  ? "bg-sidebar-border/80 text-sidebar-foreground"
                                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                              )
                            }
                          >
                            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-sidebar-foreground/60">
                              <TaskStatusIcon status={task.status} />
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                              {task.title}
                            </span>
                            <span className="shrink-0 text-xs text-sidebar-foreground/60">
                              {formatRelativeTime(task.updatedAt)}
                            </span>
                          </NavLink>
                        )
                      })}
                    </div>
                  ) : null}
                </SidebarMenuItem>
              )
            })
          ) : (
            <SidebarMenuItem>
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No projects
              </div>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function TaskStatusIcon({ status }: { status: Task["status"] }) {
  switch (status) {
    case "in_progress":
      return <LoaderCircle className="size-3.5 animate-spin" />
    case "blocked":
      return <AlertTriangle className="size-3.5 text-destructive" />
    case "closed":
      return <CheckCircle2 className="size-3.5" />
    case "open":
    default:
      return <Circle className="size-3.5" />
  }
}

function formatRelativeTime(timestamp: number): string {
  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000))

  if (elapsedSeconds < 60) return `${elapsedSeconds}s`
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h`
  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 7) return `${elapsedDays}d`
  const elapsedWeeks = Math.floor(elapsedDays / 7)
  return `${elapsedWeeks}w`
}
