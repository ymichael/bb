import { useCallback, useEffect, useState } from "react"
import type { Thread } from "@bb/domain"
import type { ProjectResponse } from "@bb/server-contract"
import { useDeleteProject, useUpdateProject } from "@/hooks/mutations/project-mutations"
import { useArchiveThread, useDeleteThread, useMarkThreadRead, useMarkThreadUnread, useUnarchiveThread, useUpdateThread } from "@/hooks/mutations/thread-state-mutations"
import { useApiClient } from "@/hooks/queries/query-client"
import { projectsQueryKey } from "@/hooks/queries/query-keys"
import { useDialogState } from "@/hooks/useDialogState"
import * as api from "@/lib/api"
import { findLocalPathProjectSourceForHost } from "@bb/domain"
import { isArchiveForceRequiredError } from "@/lib/thread-archive"
import { getThreadDisplayTitle, threadTypeLabel } from "@/lib/thread-title"
import { toast } from "sonner"
import type { ThreadRenameDialogTarget } from "@/components/thread/ThreadRenameDialog"
import type { ProjectDeleteDialogTarget } from "./ProjectDeleteDialog"
import type { ProjectRenameDialogTarget } from "./ProjectRenameDialog"

interface UseProjectListActionsParams {
  localHostId: string | null | undefined
  pickFolder: (() => Promise<string | null>) | null
  projects: ProjectResponse[] | undefined
  threads: Thread[]
  onProjectRemoved: (projectId: string) => void
  onThreadDeleted: (thread: Thread) => void
}

export function useProjectListActions({
  localHostId,
  pickFolder,
  projects,
  threads,
  onProjectRemoved,
  onThreadDeleted,
}: UseProjectListActionsParams) {
  const archiveThread = useArchiveThread()
  const markThreadRead = useMarkThreadRead()
  const markThreadUnread = useMarkThreadUnread()
  const updateThread = useUpdateThread()
  const unarchiveThread = useUnarchiveThread()
  const deleteThread = useDeleteThread()
  const updateProject = useUpdateProject()
  const deleteProject = useDeleteProject()
  const queryClient = useApiClient()
  const [pathUpdateProjectId, setPathUpdateProjectId] = useState<string | null>(null)
  const archiveConfirmationDialog = useDialogState<Thread>()
  const projectRenameDialog = useDialogState<ProjectRenameDialogTarget>()
  const projectDeleteDialog = useDialogState<ProjectDeleteDialogTarget>()
  const threadRenameDialog = useDialogState<ThreadRenameDialogTarget>()
  const threadDeleteDialog = useDialogState<Thread>()

  useEffect(() => {
    const archiveConfirmationTarget = archiveConfirmationDialog.target
    if (!archiveConfirmationTarget || threads.length === 0) return

    const nextThread = threads.find((thread) => thread.id === archiveConfirmationTarget.id)
    if (!nextThread || nextThread.archivedAt != null) {
      archiveConfirmationDialog.onClose()
    }
  }, [archiveConfirmationDialog, threads])

  const requestRenameProject = useCallback((project: ProjectResponse) => {
    if (updateProject.isPending) return

    projectRenameDialog.onOpen({
      id: project.id,
      currentName: project.name,
    })
  }, [projectRenameDialog, updateProject.isPending])

  const submitProjectRename = useCallback((projectId: string, name: string) => {
    updateProject.mutate(
      {
        id: projectId,
        name,
      },
      {
        onSuccess: () => {
          projectRenameDialog.onClose()
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : "Failed to rename project.")
        },
      },
    )
  }, [projectRenameDialog, updateProject])

  const upsertProjectSourcePath = useCallback(async (projectId: string) => {
    if (!pickFolder || !localHostId) return

    const selectedPath = await pickFolder()
    if (!selectedPath) return

    const project = projects?.find((candidate) => candidate.id === projectId)
    const existingSource = project?.sources
      ? findLocalPathProjectSourceForHost(project.sources, localHostId)
      : undefined

    setPathUpdateProjectId(projectId)
    try {
      if (existingSource) {
        await api.updateProjectSource(projectId, existingSource.id, {
          type: "local_path",
          path: selectedPath,
        })
      } else {
        await api.addProjectSource(projectId, {
          hostId: localHostId,
          type: "local_path",
          path: selectedPath,
        })
      }
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update project source.")
    } finally {
      setPathUpdateProjectId((currentProjectId) =>
        currentProjectId === projectId ? null : currentProjectId,
      )
    }
  }, [localHostId, pickFolder, projects, queryClient])

  const requestDeleteProject = useCallback((project: ProjectResponse) => {
    if (deleteProject.isPending) return

    projectDeleteDialog.onOpen({
      id: project.id,
      name: project.name,
    })
  }, [deleteProject.isPending, projectDeleteDialog])

  const confirmDeleteProject = useCallback((projectId: string) => {
    deleteProject.mutate(projectId, {
      onSuccess: () => {
        projectDeleteDialog.onClose()
        onProjectRemoved(projectId)
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Failed to remove project.")
      },
    })
  }, [deleteProject, onProjectRemoved, projectDeleteDialog])

  const requestArchiveThread = useCallback((thread: Thread) => {
    if (archiveThread.isPending) return

    archiveThread.mutate(
      { id: thread.id, force: false },
      {
        onError: (error) => {
          if (isArchiveForceRequiredError(error)) {
            archiveConfirmationDialog.onOpen(thread)
            return
          }

          toast.error(
            error instanceof Error ? error.message : `Failed to archive ${threadTypeLabel(thread.type)}.`,
          )
        },
      },
    )
  }, [archiveConfirmationDialog, archiveThread])

  const confirmArchiveThread = useCallback((thread: Thread) => {
    if (archiveThread.isPending) return

    const label = threadTypeLabel(thread.type)
    archiveConfirmationDialog.onClose()
    archiveThread.mutate(
      { id: thread.id, force: true },
      {
        onError: (error) => {
          toast.error(
            error instanceof Error ? error.message : `Failed to archive ${label}.`,
          )
        },
      },
    )
  }, [archiveConfirmationDialog, archiveThread])

  const requestRenameThread = useCallback((thread: Thread) => {
    if (updateThread.isPending) return

    threadRenameDialog.onOpen({
      id: thread.id,
      currentTitle: getThreadDisplayTitle(thread),
      threadType: thread.type,
    })
  }, [threadRenameDialog, updateThread.isPending])

  const submitThreadRename = useCallback((threadId: string, title: string) => {
    updateThread.mutate(
      {
        id: threadId,
        title,
      },
      {
        onSuccess: () => {
          threadRenameDialog.onClose()
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : "Failed to rename thread.")
        },
      },
    )
  }, [threadRenameDialog, updateThread])

  const requestDeleteThread = useCallback((thread: Thread) => {
    if (deleteThread.isPending) return
    threadDeleteDialog.onOpen(thread)
  }, [deleteThread.isPending, threadDeleteDialog])

  const confirmDeleteThread = useCallback((thread: Thread) => {
    deleteThread.mutate(
      { id: thread.id },
      {
        onSuccess: () => {
          threadDeleteDialog.onClose()
          onThreadDeleted(thread)
        },
        onError: (error) => {
          toast.error(
            error instanceof Error ? error.message : `Failed to delete ${threadTypeLabel(thread.type)}.`,
          )
        },
      },
    )
  }, [deleteThread, onThreadDeleted, threadDeleteDialog])

  const toggleThreadArchive = useCallback((thread: Thread) => {
    if (thread.archivedAt != null) {
      unarchiveThread.mutate({ id: thread.id })
      return
    }

    requestArchiveThread(thread)
  }, [requestArchiveThread, unarchiveThread])

  const toggleThreadRead = useCallback((thread: Thread) => {
    if ((thread.lastReadAt ?? 0) >= thread.updatedAt) {
      markThreadUnread.mutate(thread.id)
      return
    }

    markThreadRead.mutate(thread.id)
  }, [markThreadRead, markThreadUnread])

  return {
    archiveConfirmationDialog,
    confirmArchiveThread,
    confirmDeleteProject,
    confirmDeleteThread,
    deleteThreadDialogPending: deleteThread.isPending,
    isArchivePending: archiveThread.isPending,
    isProjectDeletePending: deleteProject.isPending,
    isProjectRenamePending: updateProject.isPending,
    isThreadRenamePending: updateThread.isPending,
    pathUpdateProjectId,
    projectDeleteDialog,
    projectRenameDialog,
    requestDeleteProject,
    requestDeleteThread,
    requestRenameProject,
    requestRenameThread,
    submitProjectRename,
    submitThreadRename,
    threadActionsDisabled:
      archiveThread.isPending ||
      unarchiveThread.isPending ||
      deleteThread.isPending ||
      updateThread.isPending ||
      markThreadRead.isPending ||
      markThreadUnread.isPending,
    threadDeleteDialog,
    threadRenameDialog,
    toggleThreadArchive,
    toggleThreadRead,
    updateProjectPath: upsertProjectSourcePath,
  }
}
