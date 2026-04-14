import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import type { Thread } from "@bb/domain"
import {
  useArchiveThread,
  useDeleteThread,
  useMarkThreadRead,
  useMarkThreadUnread,
  useUnarchiveThread,
  useUpdateThread,
} from "@/hooks/mutations/thread-state-mutations"
import { useAppRoute } from "@/hooks/useAppRoute"
import { useDialogState } from "@/hooks/useDialogState"
import { getMutationErrorMessage } from "@/lib/mutation-errors"
import { isArchiveForceRequiredError } from "@/lib/thread-archive"
import { getThreadDisplayTitle, threadTypeLabel } from "@/lib/thread-title"
import {
  ThreadRenameDialog,
  type ThreadRenameDialogTarget,
} from "@/components/thread/ThreadRenameDialog"
import { ThreadDeleteDialog } from "@/components/thread/ThreadDeleteDialog"
import { ThreadArchiveConfirmationDialog } from "@/components/thread/ThreadArchiveConfirmationDialog"
import { getThreadReadToggleAction } from "@/components/layout/project-list/threadReadState"

export interface ThreadActionsContextValue {
  requestRename: (thread: Thread) => void
  requestDelete: (thread: Thread) => void
  toggleArchive: (thread: Thread) => void
  toggleRead: (thread: Thread) => void
}

const ThreadActionsContext = createContext<ThreadActionsContextValue | null>(
  null,
)

export function useThreadActions(): ThreadActionsContextValue {
  const value = useContext(ThreadActionsContext)
  if (!value) {
    throw new Error(
      "useThreadActions must be used within a <ThreadActionsProvider>",
    )
  }
  return value
}

interface ThreadActionsProviderProps {
  children: ReactNode
}

export function ThreadActionsProvider({ children }: ThreadActionsProviderProps) {
  const navigate = useNavigate()
  const { threadId: viewedThreadId } = useAppRoute()
  const archiveThread = useArchiveThread()
  const unarchiveThread = useUnarchiveThread()
  const markThreadRead = useMarkThreadRead()
  const markThreadUnread = useMarkThreadUnread()
  const deleteThread = useDeleteThread()
  const updateThread = useUpdateThread()
  // Destructure `.mutate` so useCallback deps see stable references across
  // renders. Depending on the full mutation objects would churn callback
  // identities on every isPending flip and force every useThreadActions()
  // consumer to re-render whenever any mutation fires.
  const { mutate: archiveMutate } = archiveThread
  const { mutate: unarchiveMutate } = unarchiveThread
  const { mutate: markReadMutate } = markThreadRead
  const { mutate: markUnreadMutate } = markThreadUnread
  const { mutate: deleteMutate } = deleteThread
  const { mutate: updateMutate } = updateThread

  const renameDialog = useDialogState<ThreadRenameDialogTarget>()
  const deleteDialog = useDialogState<Thread>()
  const archiveConfirmationDialog = useDialogState<Thread>()

  const {
    onClose: closeRenameDialog,
    onOpen: openRenameDialog,
  } = renameDialog
  const {
    onClose: closeDeleteDialog,
    onOpen: openDeleteDialog,
  } = deleteDialog
  const {
    onClose: closeArchiveConfirmationDialog,
    onOpen: openArchiveConfirmationDialog,
  } = archiveConfirmationDialog

  const navigateAwayIfViewing = useCallback(
    (thread: Thread) => {
      if (viewedThreadId === thread.id) {
        // Push (not replace) so the back button still returns the user to the
        // archived/deleted thread's URL if they want to re-open it.
        navigate(`/projects/${thread.projectId}`)
      }
    },
    [navigate, viewedThreadId],
  )

  const requestRename = useCallback(
    (thread: Thread) => {
      openRenameDialog({
        id: thread.id,
        currentTitle: getThreadDisplayTitle(thread),
        threadType: thread.type,
      })
    },
    [openRenameDialog],
  )

  const submitRename = useCallback(
    (threadId: string, title: string) => {
      updateMutate(
        { id: threadId, title },
        {
          onSuccess: () => {
            closeRenameDialog()
          },
        },
      )
    },
    [closeRenameDialog, updateMutate],
  )

  const requestDelete = useCallback(
    (thread: Thread) => {
      openDeleteDialog(thread)
    },
    [openDeleteDialog],
  )

  const confirmDelete = useCallback(
    (thread: Thread) => {
      deleteMutate(
        { id: thread.id },
        {
          onSuccess: () => {
            closeDeleteDialog()
            navigateAwayIfViewing(thread)
          },
        },
      )
    },
    [closeDeleteDialog, deleteMutate, navigateAwayIfViewing],
  )

  const showArchiveError = useCallback((thread: Thread, error: unknown) => {
    toast.error(
      getMutationErrorMessage({
        error,
        fallbackMessage: `Failed to archive ${threadTypeLabel(thread.type)}.`,
      }),
    )
  }, [])

  const requestArchive = useCallback(
    (thread: Thread) => {
      archiveMutate(
        { id: thread.id, force: false },
        {
          onSuccess: () => {
            navigateAwayIfViewing(thread)
          },
          onError: (error) => {
            if (isArchiveForceRequiredError(error)) {
              openArchiveConfirmationDialog(thread)
              return
            }
            showArchiveError(thread, error)
          },
        },
      )
    },
    [archiveMutate, navigateAwayIfViewing, openArchiveConfirmationDialog, showArchiveError],
  )

  const confirmArchive = useCallback(
    (thread: Thread) => {
      closeArchiveConfirmationDialog()
      archiveMutate(
        { id: thread.id, force: true },
        {
          onSuccess: () => {
            navigateAwayIfViewing(thread)
          },
          onError: (error) => {
            showArchiveError(thread, error)
          },
        },
      )
    },
    [archiveMutate, closeArchiveConfirmationDialog, navigateAwayIfViewing, showArchiveError],
  )

  const toggleArchive = useCallback(
    (thread: Thread) => {
      if (thread.archivedAt != null) {
        unarchiveMutate({ id: thread.id })
        return
      }
      requestArchive(thread)
    },
    [requestArchive, unarchiveMutate],
  )

  const toggleRead = useCallback(
    (thread: Thread) => {
      if (getThreadReadToggleAction(thread) === "mark_unread") {
        markUnreadMutate(thread.id, {
          onError: (error) => {
            toast.error(
              getMutationErrorMessage({
                error,
                fallbackMessage: "Failed to mark thread unread.",
              }),
            )
          },
        })
        return
      }
      markReadMutate(thread.id, {
        onError: (error) => {
          toast.error(
            getMutationErrorMessage({
              error,
              fallbackMessage: "Failed to mark thread read.",
            }),
          )
        },
      })
    },
    [markReadMutate, markUnreadMutate],
  )

  const value = useMemo<ThreadActionsContextValue>(
    () => ({
      requestRename,
      requestDelete,
      toggleArchive,
      toggleRead,
    }),
    [requestRename, requestDelete, toggleArchive, toggleRead],
  )

  return (
    <ThreadActionsContext.Provider value={value}>
      {children}
      <ThreadRenameDialog
        target={renameDialog.target}
        pending={updateThread.isPending}
        onOpenChange={renameDialog.onOpenChange}
        onRename={submitRename}
      />
      <ThreadDeleteDialog
        target={deleteDialog.target}
        pending={deleteThread.isPending}
        onOpenChange={deleteDialog.onOpenChange}
        onDelete={confirmDelete}
      />
      <ThreadArchiveConfirmationDialog
        target={archiveConfirmationDialog.target}
        pending={archiveThread.isPending}
        onOpenChange={archiveConfirmationDialog.onOpenChange}
        onArchive={confirmArchive}
      />
    </ThreadActionsContext.Provider>
  )
}
