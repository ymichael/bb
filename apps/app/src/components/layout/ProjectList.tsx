import { useEffect, useMemo, useState } from "react"
import { assertNever, type Thread } from "@beanbag/agent-core"
import {
  AlertTriangle,
  Archive,
  ChevronRight,
  Folder,
  FolderOpen,
  LoaderCircle,
  SquarePen,
  Wrench,
} from "lucide-react"
import {
  useArchiveThread,
  useProjects,
  useThreads,
  useUpdateProject,
} from "@/hooks/useApi"
import { NavLink, useLocation } from "react-router-dom"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/formatting"
import {
  deriveProjectNameFromPath,
  requestProjectRootPath,
} from "@/lib/projectPathInput"
import {
  SidebarGroup,
  SidebarGroupLabel,
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

export function ProjectList({
  onNewProject,
  onProjectSelect,
  selectedProjectId,
  isCreatingProject = false,
}: ProjectListProps) {
  const { data: projects, isLoading: projectsLoading } = useProjects()
  const { data: threads, isLoading: threadsLoading } = useThreads()
  const archiveThread = useArchiveThread()
  const updateProject = useUpdateProject()
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

  const threadsByProject = useMemo(() => {
    const grouped = new Map<string, Thread[]>()

    for (const thread of threads ?? []) {
      if (!isVisibleProjectThread(thread)) continue
      const existing = grouped.get(thread.projectId)
      if (existing) {
        existing.push(thread)
      } else {
        grouped.set(thread.projectId, [thread])
      }
    }

    for (const projectThreads of grouped.values()) {
      projectThreads.sort((a, b) => b.updatedAt - a.updatedAt)
    }

    return grouped
  }, [threads])

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

  const repairProjectPath = async (projectId: string, fallbackName: string) => {
    if (updateProject.isPending) return

    const rootPath = await requestProjectRootPath()
    if (!rootPath) return

    const nextName = deriveProjectNameFromPath(rootPath).trim() || fallbackName
    updateProject.mutate({
      id: projectId,
      rootPath,
      name: nextName,
    })
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Projects</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {projectsLoading ? (
            <>
              <SidebarMenuSkeleton />
              <SidebarMenuSkeleton />
            </>
          ) : projects && projects.length > 0 ? (
            projects.map((project) => {
              const projectThreads = threadsByProject.get(project.id) ?? []
              const isProjectCollapsed = collapsedProjectIds.has(project.id)
              const isProjectActive =
                selectedProjectId === project.id && !selectedThreadId
              const isProjectPathMissing = project.rootPathExists === false

              return (
                <SidebarMenuItem key={project.id} className="space-y-1">
                  <div
                    className={cn(
                      "group/project-row flex h-8 w-full items-center rounded-md text-sm transition-colors",
                      isProjectPathMissing
                        ? "border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15"
                        : isProjectActive
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
                        isProjectCollapsed ? "Expand project threads" : "Collapse project threads"
                      }
                      onClick={() => toggleProjectCollapsed(project.id)}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2"
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
                    <NavLink
                      to={`/projects/${project.id}`}
                      onClick={onProjectSelect}
                      className="flex min-w-0 flex-1 items-center"
                    >
                      <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                      {isProjectPathMissing ? (
                        <AlertTriangle
                          className="ml-1 size-3.5 shrink-0 text-destructive"
                          aria-hidden
                        />
                      ) : null}
                    </NavLink>
                    {isProjectPathMissing ? (
                      <button
                        type="button"
                        title="Project folder is missing. Choose a new folder."
                        aria-label="Repair project path"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-destructive outline-none ring-sidebar-ring transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={updateProject.isPending}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void repairProjectPath(project.id, project.name)
                        }}
                      >
                        {updateProject.isPending ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Wrench className="size-4" />
                        )}
                      </button>
                    ) : null}
                    <NavLink
                      to={`/projects/${project.id}`}
                      state={{ focusPrompt: true }}
                      onClick={(event) => {
                        event.stopPropagation()
                        onProjectSelect?.()
                      }}
                      title={`Open ${project.name}`}
                      aria-label={`Open ${project.name}`}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2"
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
                        {projectThreads.map((thread) => {
                          const isBusyThread = isBusyThreadStatus(thread.status)

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
                                {isBusyThread ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
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
                        })}
                      </div>
                    ) : null
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
          <SidebarMenuItem>
            <button
              type="button"
              onClick={onNewProject}
              disabled={isCreatingProject}
              title={isCreatingProject ? "Creating Project..." : "Add Project"}
              className="flex h-8 w-full items-center justify-center rounded-md border border-sidebar-border/80 bg-sidebar-accent/10 px-2 text-xs font-medium text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreatingProject ? "Adding Project..." : "Add Project"}
            </button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function isBusyThreadStatus(status: Thread["status"]): boolean {
  switch (status) {
    case "active":
    case "created":
    case "provisioning":
      return true
    case "idle":
    case "provisioning_failed":
      return false
    default:
      return assertNever(status)
  }
}

function isVisibleProjectThread(thread: Thread): boolean {
  return thread.archivedAt === undefined && thread.parentThreadId === undefined
}
