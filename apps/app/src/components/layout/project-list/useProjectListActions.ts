import { useCallback, useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Thread } from "@bb/domain"
import type { ProjectResponse } from "@bb/server-contract"
import { useDeleteProject, useUpdateProject } from "@/hooks/mutations/project-mutations"
import { useArchiveThread, useDeleteThread, useMarkThreadRead, useMarkThreadUnread, useUnarchiveThread, useUpdateThread } from "@/hooks/mutations/thread-state-mutations"
import { projectsQueryKey } from "@/hooks/queries/query-keys"
import { useDialogState } from "@/hooks/useDialogState"
import type { ProjectPathDialogTarget } from "@/components/project/ProjectPathDialog"
import * as api from "@/lib/api"
import { findLocalPathProjectSourceForHost } from "@bb/domain"
import { getMutationErrorMessage } from "@/lib/mutation-errors"
import { isArchiveForceRequiredError } from "@/lib/thread-archive"
import { getThreadDisplayTitle, threadTypeLabel } from "@/lib/thread-title"
import { toast } from "sonner"
import type { ThreadRenameDialogTarget } from "@/components/thread/ThreadRenameDialog"
import type { ProjectDeleteDialogTarget } from "./ProjectDeleteDialog"
import type { ProjectRenameDialogTarget } from "./ProjectRenameDialog"
import { getThreadReadToggleAction } from "./threadReadState"

interface UseProjectListActionsParams {
  localHostId: string | null | undefined
  projects: ProjectResponse[] | undefined
  threads: Thread[]
  onProjectRemoved: (projectId: string) => void
  onThreadDeleted: (thread: Thread) => void
}

export function useProjectListActions({
  localHostId,
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
  const queryClient = useQueryClient()
  const [pathUpdateProjectId, setPathUpdateProjectId] = useState<string | null>(null)
  const archiveConfirmationDialog = useDialogState<Thread>()
  const projectPathDialog = useDialogState<ProjectPathDialogTarget>()
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
  }, [archiveConfirmationDialog.onClose, archiveConfirmationDialog.target, threads])

  const requestRenameProject = useCallback((project: ProjectResponse) => {
    if (updateProject.isPending) return

    projectRenameDialog.onOpen({
      id: project.id,
      currentName: project.name,
    })
  }, [projectRenameDialog.onOpen, updateProject.isPending])

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
      },
    )
  }, [projectRenameDialog.onClose, updateProject.mutate])

  const openProjectPathDialog = useCallback((projectId: string) => {
    if (!localHostId) return

    const project = projects?.find((candidate) => candidate.id === projectId)
    const existingSource = project?.sources
      ? findLocalPathProjectSourceForHost(project.sources, localHostId)
      : undefined

    projectPathDialog.onOpen({
      kind: "update",
      projectId,
      projectName: project?.name ?? "Project",
      currentPath: existingSource?.path ?? "",
    })
  }, [localHostId, projectPathDialog, projects])

  const submitProjectPath = useCallback(async (target: ProjectPathDialogTarget, nextPath: string) => {
    if (!localHostId || target.kind !== "update") return

    const project = projects?.find((candidate) => candidate.id === target.projectId)
    const existingSource = project?.sources
      ? findLocalPathProjectSourceForHost(project.sources, localHostId)
      : undefined

    const projectId = target.projectId
    setPathUpdateProjectId(projectId)
    try {
      if (existingSource) {
        await api.updateProjectSource(projectId, existingSource.id, {
          type: "local_path",
          path: nextPath,
        })
      } else {
        await api.addProjectSource(projectId, {
          hostId: localHostId,
          type: "local_path",
          path: nextPath,
        })
      }
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() })
      projectPathDialog.onClose()
    } catch (error) {
      toast.error(getMutationErrorMessage({
        error,
        fallbackMessage: "Failed to update project source.",
      }))
    } finally {
      setPathUpdateProjectId((currentProjectId) =>
        currentProjectId === projectId ? null : currentProjectId,
      )
    }
  }, [localHostId, projectPathDialog, projects, queryClient])

  const requestDeleteProject = useCallback((project: ProjectResponse) => {
    if (deleteProject.isPending) return

    projectDeleteDialog.onOpen({
      id: project.id,
      name: project.name,
    })
  }, [deleteProject.isPending, projectDeleteDialog.onOpen])

  const confirmDeleteProject = useCallback((projectId: string) => {
    deleteProject.mutate(projectId, {
      onSuccess: () => {
        projectDeleteDialog.onClose()
        onProjectRemoved(projectId)
      },
    })
  }, [deleteProject.mutate, onProjectRemoved, projectDeleteDialog.onClose])

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

          toast.error(getMutationErrorMessage({
            error,
            fallbackMessage: `Failed to archive ${threadTypeLabel(thread.type)}.`,
          }))
        },
      },
    )
  }, [archiveConfirmationDialog.onOpen, archiveThread.isPending, archiveThread.mutate])

  const confirmArchiveThread = useCallback((thread: Thread) => {
    if (archiveThread.isPending) return

    const label = threadTypeLabel(thread.type)
    archiveConfirmationDialog.onClose()
    archiveThread.mutate(
      { id: thread.id, force: true },
      {
        onError: (error) => {
          toast.error(getMutationErrorMessage({
            error,
            fallbackMessage: `Failed to archive ${label}.`,
          }))
        },
      },
    )
  }, [archiveConfirmationDialog.onClose, archiveThread.isPending, archiveThread.mutate])

  const requestRenameThread = useCallback((thread: Thread) => {
    if (updateThread.isPending) return

    threadRenameDialog.onOpen({
      id: thread.id,
      currentTitle: getThreadDisplayTitle(thread),
      threadType: thread.type,
    })
  }, [threadRenameDialog.onOpen, updateThread.isPending])

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
      },
    )
  }, [threadRenameDialog.onClose, updateThread.mutate])

  const requestDeleteThread = useCallback((thread: Thread) => {
    if (deleteThread.isPending) return
    threadDeleteDialog.onOpen(thread)
  }, [deleteThread.isPending, threadDeleteDialog.onOpen])

  const confirmDeleteThread = useCallback((thread: Thread) => {
    deleteThread.mutate(
      { id: thread.id },
      {
        onSuccess: () => {
          threadDeleteDialog.onClose()
          onThreadDeleted(thread)
        },
      },
    )
  }, [deleteThread.mutate, onThreadDeleted, threadDeleteDialog.onClose])

  const toggleThreadArchive = useCallback((thread: Thread) => {
    if (thread.archivedAt != null) {
      unarchiveThread.mutate({ id: thread.id })
      return
    }

    requestArchiveThread(thread)
  }, [requestArchiveThread, unarchiveThread])

  const toggleThreadRead = useCallback((thread: Thread) => {
    if (getThreadReadToggleAction(thread) === "mark_unread") {
      markThreadUnread.mutate(thread.id, {
        onError: (error) => {
          toast.error(getMutationErrorMessage({
            error,
            fallbackMessage: "Failed to mark thread unread.",
          }))
        },
      })
      return
    }

    markThreadRead.mutate(thread.id, {
      onError: (error) => {
        toast.error(getMutationErrorMessage({
          error,
          fallbackMessage: "Failed to mark thread read.",
        }))
      },
    })
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
    projectPathDialog,
    projectDeleteDialog,
    projectRenameDialog,
    requestDeleteProject,
    requestDeleteThread,
    requestRenameProject,
    requestRenameThread,
    submitProjectPath,
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
    updateProjectPath: openProjectPathDialog,
  }
}
