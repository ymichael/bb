import { useCallback, useMemo } from "react"
import { useAtom } from "jotai"
import { useQueries } from "@tanstack/react-query"
import type { Thread } from "@bb/domain"
import { Folder, Plus } from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { atomWithStorage } from "jotai/utils"
import { useProjects } from "@/hooks/queries/project-queries"
import { threadListQueryKey } from "@/hooks/queries/query-keys"
import { useHostDaemon } from "@/hooks/useHostDaemon"
import * as api from "@/lib/api"
import { createJsonLocalStorage } from "@/lib/browser-storage"
import { EmptyState } from "@/components/shared/EmptyState"
import { ThreadArchiveConfirmationDialog } from "@/components/thread/ThreadArchiveConfirmationDialog"
import { ThreadDeleteDialog } from "@/components/thread/ThreadDeleteDialog"
import { ThreadRenameDialog } from "@/components/thread/ThreadRenameDialog"
import { ProjectPathDialog } from "@/components/project/ProjectPathDialog"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"
import { ProjectDeleteDialog } from "./project-list/ProjectDeleteDialog"
import { ProjectRenameDialog } from "./project-list/ProjectRenameDialog"
import { ProjectRow } from "./project-list/ProjectRow"
import { useProjectListActions } from "./project-list/useProjectListActions"

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
  const { localHostId, pickFolder } = useHostDaemon()
  const location = useLocation()
  const navigate = useNavigate()
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
    const grouped = new Map<string, Thread[]>()

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

  const handleProjectRemoved = useCallback((projectId: string) => {
    setCollapsedProjectIdList((current) => {
      const next = new Set(current)
      next.delete(projectId)
      return Array.from(next)
    })

    if (selectedProjectId === projectId) {
      navigate("/", { replace: true })
    }
  }, [navigate, selectedProjectId, setCollapsedProjectIdList])

  const handleThreadDeleted = useCallback((thread: Thread) => {
    if (selectedThreadId === thread.id) {
      navigate(`/projects/${thread.projectId}`, { replace: true })
    }
  }, [navigate, selectedThreadId])

  const actions = useProjectListActions({
    localHostId,
    projects,
    threads,
    onProjectRemoved: handleProjectRemoved,
    onThreadDeleted: handleThreadDeleted,
  })

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
            className="inline-flex size-5 items-center justify-center rounded text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground disabled:opacity-50"
          >
            <Plus className="size-4" />
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
            projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                projectThreads={threadsByProject.get(project.id) ?? []}
                threadsLoading={threadsLoading}
                localHostId={localHostId}
                selectedThreadId={selectedThreadId}
                isActive={selectedProjectId === project.id && !selectedThreadId}
                isCollapsed={collapsedProjectIds.has(project.id)}
                collapsedManagerIds={collapsedManagerIds}
                isProjectRenamePending={actions.isProjectRenamePending}
                isProjectDeletePending={actions.isProjectDeletePending}
                isPathUpdating={actions.pathUpdateProjectId === project.id}
                areThreadActionsDisabled={actions.threadActionsDisabled}
                onProjectSelect={onProjectSelect}
                onToggleProjectCollapsed={toggleProjectCollapsed}
                onToggleManagerCollapsed={toggleManagerCollapsed}
                onRenameProject={actions.requestRenameProject}
                onChangeProjectPath={actions.updateProjectPath}
                onRepairProjectPath={actions.updateProjectPath}
                onDeleteProject={actions.requestDeleteProject}
                onRenameThread={actions.requestRenameThread}
                onToggleThreadArchive={actions.toggleThreadArchive}
                onDeleteThread={actions.requestDeleteThread}
                onToggleThreadRead={actions.toggleThreadRead}
              />
            ))
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
      <ThreadArchiveConfirmationDialog
        target={actions.archiveConfirmationDialog.target}
        pending={actions.isArchivePending}
        onOpenChange={actions.archiveConfirmationDialog.onOpenChange}
        onArchive={actions.confirmArchiveThread}
      />
      <ProjectRenameDialog
        target={actions.projectRenameDialog.target}
        pending={actions.isProjectRenamePending}
        onOpenChange={actions.projectRenameDialog.onOpenChange}
        onRename={actions.submitProjectRename}
      />
      <ProjectDeleteDialog
        target={actions.projectDeleteDialog.target}
        pending={actions.isProjectDeletePending}
        onOpenChange={actions.projectDeleteDialog.onOpenChange}
        onDelete={actions.confirmDeleteProject}
      />
      <ProjectPathDialog
        target={actions.projectPathDialog.target}
        pending={actions.pathUpdateProjectId !== null}
        pickFolder={pickFolder}
        onOpenChange={actions.projectPathDialog.onOpenChange}
        onSubmit={actions.submitProjectPath}
      />
      <ThreadRenameDialog
        target={actions.threadRenameDialog.target}
        pending={actions.isThreadRenamePending}
        onOpenChange={actions.threadRenameDialog.onOpenChange}
        onRename={actions.submitThreadRename}
      />
      <ThreadDeleteDialog
        target={actions.threadDeleteDialog.target}
        pending={actions.deleteThreadDialogPending}
        onOpenChange={actions.threadDeleteDialog.onOpenChange}
        onDelete={actions.confirmDeleteThread}
      />
    </SidebarGroup>
  )
}
