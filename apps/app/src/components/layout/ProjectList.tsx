import { useCallback, useMemo } from "react"
import { useAtom } from "jotai"
import { useQueries } from "@tanstack/react-query"
import {
  findLocalPathProjectSourceForHost,
  type ThreadListEntry,
} from "@bb/domain"
import { Folder, Plus } from "lucide-react"
import { useLocation } from "react-router-dom"
import { useProjects } from "@/hooks/queries/project-queries"
import {
  isLocalPathMissing,
  useLocalPathExistence,
} from "@/hooks/queries/host-path-queries"
import { threadListQueryKey } from "@/hooks/queries/query-keys"
import { useHostDaemon } from "@/hooks/useHostDaemon"
import * as api from "@/lib/api"
import { EmptyState } from "@/components/shared/EmptyState"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"
import { ProjectRow } from "./project-list/ProjectRow"
import {
  collapsedManagerIdsAtom,
  collapsedProjectIdsAtom,
} from "./project-list/collapsedState"

interface ProjectListProps {
  onNewProject?: () => void
  onProjectSelect?: () => void
  selectedProjectId?: string
  isCreatingProject?: boolean
}

export function ProjectList({
  onNewProject,
  onProjectSelect,
  selectedProjectId,
  isCreatingProject = false,
}: ProjectListProps) {
  const { data: projects, isLoading: projectsLoading } = useProjects()
  const projectIds = useMemo(() => (projects ?? []).map((project) => project.id), [projects])
  const { threads, threadsLoading } = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: threadListQueryKey({ projectId, archived: false }),
      queryFn: ({ signal }) => api.listThreads({ projectId, archived: false }, signal),
      staleTime: 10_000,
    })),
    combine: (results) => ({
      threads: results.flatMap((result) => result.data ?? []),
      threadsLoading: results.some((result) => result.isLoading),
    }),
  })
  const { localHostId } = useHostDaemon()
  const location = useLocation()

  const localPaths = useMemo(() => {
    if (!localHostId || !projects) return []
    return projects
      .map((project) => findLocalPathProjectSourceForHost(project.sources, localHostId)?.path)
      .filter((path): path is string => typeof path === "string")
  }, [localHostId, projects])
  const pathExistence = useLocalPathExistence(localPaths)

  const [collapsedProjectIdList, setCollapsedProjectIdList] = useAtom(collapsedProjectIdsAtom)
  const [collapsedManagerIdList, setCollapsedManagerIdList] = useAtom(collapsedManagerIdsAtom)
  const selectedThreadId = location.pathname.match(/^\/projects\/[^/]+\/threads\/([^/]+)/)?.[1]
  const collapsedProjectIds = useMemo(
    () => new Set(collapsedProjectIdList),
    [collapsedProjectIdList],
  )
  const collapsedManagerIds = useMemo(
    () => new Set(collapsedManagerIdList),
    [collapsedManagerIdList],
  )
  const threadsByProject = useMemo(() => {
    const grouped = new Map<string, ThreadListEntry[]>()

    for (const thread of threads) {
      const existing = grouped.get(thread.projectId)
      if (existing) {
        existing.push(thread)
      } else {
        grouped.set(thread.projectId, [thread])
      }
    }

    return grouped
  }, [threads])

  const toggleProjectCollapsed = useCallback((projectId: string) => {
    setCollapsedProjectIdList((current) => {
      const next = new Set(current)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }

      return Array.from(next)
    })
  }, [setCollapsedProjectIdList])

  const toggleManagerCollapsed = useCallback((threadId: string) => {
    setCollapsedManagerIdList((current) => {
      const next = new Set(current)
      if (next.has(threadId)) {
        next.delete(threadId)
      } else {
        next.add(threadId)
      }

      return Array.from(next)
    })
  }, [setCollapsedManagerIdList])

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="mb-1 flex items-center justify-between pr-1">
        Projects
        {onNewProject ? (
          <button
            type="button"
            onClick={onNewProject}
            disabled={isCreatingProject}
            title={isCreatingProject ? "Creating project..." : "Add project"}
            aria-label="Add project"
            className="inline-flex size-7 items-center justify-center rounded text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground disabled:opacity-50 md:size-5"
          >
            <Plus className="size-5 md:size-4" />
          </button>
        ) : null}
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
              const localSourcePath = localHostId
                ? findLocalPathProjectSourceForHost(project.sources, localHostId)?.path
                : undefined
              const isLocalPathInvalid = isLocalPathMissing(pathExistence, localSourcePath)
              return (
                <ProjectRow
                  key={project.id}
                  project={project}
                  projectThreads={threadsByProject.get(project.id) ?? []}
                  threadsLoading={threadsLoading}
                  selectedThreadId={selectedThreadId}
                  isActive={selectedProjectId === project.id && !selectedThreadId}
                  isCollapsed={collapsedProjectIds.has(project.id)}
                  collapsedManagerIds={collapsedManagerIds}
                  isLocalPathInvalid={isLocalPathInvalid}
                  onProjectSelect={onProjectSelect}
                  onToggleProjectCollapsed={toggleProjectCollapsed}
                  onToggleManagerCollapsed={toggleManagerCollapsed}
                />
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
    </SidebarGroup>
  )
}
