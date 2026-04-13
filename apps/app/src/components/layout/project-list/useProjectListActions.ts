import { useCallback, useEffect } from "react"
import type { Thread } from "@bb/domain"
import type { ProjectResponse } from "@bb/server-contract"
import { useDeleteProject, useUpdateProject } from "@/hooks/mutations/project-mutations"
import { useArchiveThread, useDeleteThread, useMarkThreadRead, useMarkThreadUnread, useUnarchiveThread, useUpdateThread } from "@/hooks/mutations/thread-state-mutations"
import { useDialogState } from "@/hooks/useDialogState"
import { getMutationErrorMessage } from "@/lib/mutation-errors"
import { isArchiveForceRequiredError } from "@/lib/thread-archive"
import { getThreadDisplayTitle, threadTypeLabel } from "@/lib/thread-title"
import { toast } from "sonner"
import type { ThreadRenameDialogTarget } from "@/components/thread/ThreadRenameDialog"
import type { ProjectDeleteDialogTarget } from "./ProjectDeleteDialog"
import type { ProjectRenameDialogTarget } from "./ProjectRenameDialog"
import { getThreadReadToggleAction } from "./threadReadState"

interface UseProjectListActionsParams {
  threads: Thread[]
  onProjectRemoved: (projectId: string) => void
  onThreadArchived: (thread: Thread) => void
  onThreadDeleted: (thread: Thread) => void
}

export function useProjectListActions({
  threads,
  onProjectRemoved,
  onThreadArchived,
  onThreadDeleted,
}: UseProjectListActionsParams) {
  const {
    isPending: isArchivePending,
    mutate: archiveThread,
  } = useArchiveThread()
  const {
    isPending: isMarkThreadReadPending,
    mutate: markThreadRead,
  } = useMarkThreadRead()
  const {
    isPending: isMarkThreadUnreadPending,
    mutate: markThreadUnread,
  } = useMarkThreadUnread()
  const {
    isPending: isThreadRenamePending,
    mutate: updateThread,
  } = useUpdateThread()
  const {
    isPending: isUnarchivePending,
    mutate: unarchiveThread,
  } = useUnarchiveThread()
  const {
    isPending: deleteThreadDialogPending,
    mutate: deleteThread,
  } = useDeleteThread()
  const {
    isPending: isProjectRenamePending,
    mutate: updateProject,
  } = useUpdateProject()
  const {
    isPending: isProjectDeletePending,
    mutate: deleteProject,
  } = useDeleteProject()
  const archiveConfirmationDialog = useDialogState<Thread>()
  const projectRenameDialog = useDialogState<ProjectRenameDialogTarget>()
  const projectDeleteDialog = useDialogState<ProjectDeleteDialogTarget>()
  const threadRenameDialog = useDialogState<ThreadRenameDialogTarget>()
  const threadDeleteDialog = useDialogState<Thread>()
  const {
    onClose: closeArchiveConfirmationDialog,
    onOpen: openArchiveConfirmationDialog,
    target: archiveConfirmationTarget,
  } = archiveConfirmationDialog
  const {
    onClose: closeProjectRenameDialog,
    onOpen: openProjectRenameDialog,
  } = projectRenameDialog
  const {
    onClose: closeProjectDeleteDialog,
    onOpen: openProjectDeleteDialog,
  } = projectDeleteDialog
  const {
    onClose: closeThreadRenameDialog,
    onOpen: openThreadRenameDialog,
  } = threadRenameDialog
  const {
    onClose: closeThreadDeleteDialog,
    onOpen: openThreadDeleteDialog,
  } = threadDeleteDialog

  useEffect(() => {
    if (!archiveConfirmationTarget || threads.length === 0) return

    const nextThread = threads.find((thread) => thread.id === archiveConfirmationTarget.id)
    if (!nextThread || nextThread.archivedAt != null) {
      closeArchiveConfirmationDialog()
    }
  }, [archiveConfirmationTarget, closeArchiveConfirmationDialog, threads])

  const requestRenameProject = useCallback((project: ProjectResponse) => {
    if (isProjectRenamePending) return

    openProjectRenameDialog({
      id: project.id,
      currentName: project.name,
    })
  }, [isProjectRenamePending, openProjectRenameDialog])

  const submitProjectRename = useCallback((projectId: string, name: string) => {
    updateProject(
      {
        id: projectId,
        name,
      },
      {
        onSuccess: () => {
          closeProjectRenameDialog()
        },
      },
    )
  }, [closeProjectRenameDialog, updateProject])

  const requestDeleteProject = useCallback((project: ProjectResponse) => {
    if (isProjectDeletePending) return

    openProjectDeleteDialog({
      id: project.id,
      name: project.name,
    })
  }, [isProjectDeletePending, openProjectDeleteDialog])

  const confirmDeleteProject = useCallback((projectId: string) => {
    deleteProject(projectId, {
      onSuccess: () => {
        closeProjectDeleteDialog()
        onProjectRemoved(projectId)
      },
    })
  }, [closeProjectDeleteDialog, deleteProject, onProjectRemoved])

  const requestArchiveThread = useCallback((thread: Thread) => {
    if (isArchivePending) return

    archiveThread(
      { id: thread.id, force: false },
      {
        onSuccess: () => {
          onThreadArchived(thread)
        },
        onError: (error) => {
          if (isArchiveForceRequiredError(error)) {
            openArchiveConfirmationDialog(thread)
            return
          }

          toast.error(getMutationErrorMessage({
            error,
            fallbackMessage: `Failed to archive ${threadTypeLabel(thread.type)}.`,
          }))
        },
      },
    )
  }, [archiveThread, isArchivePending, onThreadArchived, openArchiveConfirmationDialog])

  const confirmArchiveThread = useCallback((thread: Thread) => {
    if (isArchivePending) return

    const label = threadTypeLabel(thread.type)
    closeArchiveConfirmationDialog()
    archiveThread(
      { id: thread.id, force: true },
      {
        onSuccess: () => {
          onThreadArchived(thread)
        },
        onError: (error) => {
          toast.error(getMutationErrorMessage({
            error,
            fallbackMessage: `Failed to archive ${label}.`,
          }))
        },
      },
    )
  }, [archiveThread, closeArchiveConfirmationDialog, isArchivePending, onThreadArchived])

  const requestRenameThread = useCallback((thread: Thread) => {
    if (isThreadRenamePending) return

    openThreadRenameDialog({
      id: thread.id,
      currentTitle: getThreadDisplayTitle(thread),
      threadType: thread.type,
    })
  }, [isThreadRenamePending, openThreadRenameDialog])

  const submitThreadRename = useCallback((threadId: string, title: string) => {
    updateThread(
      {
        id: threadId,
        title,
      },
      {
        onSuccess: () => {
          closeThreadRenameDialog()
        },
      },
    )
  }, [closeThreadRenameDialog, updateThread])

  const requestDeleteThread = useCallback((thread: Thread) => {
    if (deleteThreadDialogPending) return
    openThreadDeleteDialog(thread)
  }, [deleteThreadDialogPending, openThreadDeleteDialog])

  const confirmDeleteThread = useCallback((thread: Thread) => {
    deleteThread(
      { id: thread.id },
      {
        onSuccess: () => {
          closeThreadDeleteDialog()
          onThreadDeleted(thread)
        },
      },
    )
  }, [closeThreadDeleteDialog, deleteThread, onThreadDeleted])

  const toggleThreadArchive = useCallback((thread: Thread) => {
    if (thread.archivedAt != null) {
      unarchiveThread({ id: thread.id })
      return
    }

    requestArchiveThread(thread)
  }, [requestArchiveThread, unarchiveThread])

  const toggleThreadRead = useCallback((thread: Thread) => {
    if (getThreadReadToggleAction(thread) === "mark_unread") {
      markThreadUnread(thread.id, {
        onError: (error) => {
          toast.error(getMutationErrorMessage({
            error,
            fallbackMessage: "Failed to mark thread unread.",
          }))
        },
      })
      return
    }

    markThreadRead(thread.id, {
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
    deleteThreadDialogPending,
    isArchivePending,
    isProjectDeletePending,
    isProjectRenamePending,
    isThreadRenamePending,
    projectDeleteDialog,
    projectRenameDialog,
    requestDeleteProject,
    requestDeleteThread,
    requestRenameProject,
    requestRenameThread,
    submitProjectRename,
    submitThreadRename,
    threadActionsDisabled:
      isArchivePending ||
      isUnarchivePending ||
      deleteThreadDialogPending ||
      isThreadRenamePending ||
      isMarkThreadReadPending ||
      isMarkThreadUnreadPending,
    threadDeleteDialog,
    threadRenameDialog,
    toggleThreadArchive,
    toggleThreadRead,
  }
}
