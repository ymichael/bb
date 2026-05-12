import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { Thread } from "@bb/domain";
import {
  useArchiveThread,
  useDeleteThread,
  useMarkThreadRead,
  useMarkThreadUnread,
  useUnarchiveThread,
  useUpdateThread,
} from "@/hooks/mutations/thread-state-mutations";
import { getThreadAssignedChildSummary } from "@/lib/api";
import { useAppRoute } from "@/hooks/useAppRoute";
import { useDialogState } from "@/hooks/useDialogState";
import {
  getMutationErrorMessage,
  shouldShowMutationErrorToast,
} from "@/lib/mutation-errors";
import { isArchiveForceRequiredError } from "@/lib/thread-archive";
import { getThreadDisplayTitle, threadTypeLabel } from "@/lib/thread-title";
import {
  ThreadRenameDialog,
  type ThreadRenameDialogTarget,
} from "@/components/dialogs/ThreadRenameDialog";
import { ThreadDeleteDialog } from "@/components/dialogs/ThreadDeleteDialog";
import {
  ThreadArchiveConfirmationDialog,
  type ThreadArchiveConfirmationDialogTarget,
} from "@/components/dialogs/ThreadArchiveConfirmationDialog";
import {
  ThreadManagerChildThreadsConfirmationDialog,
  type ThreadManagerChildThreadsAction,
  type ThreadManagerChildThreadsDialogTarget,
} from "@/components/dialogs/ThreadManagerChildThreadsConfirmationDialog";
import { getThreadReadToggleAction } from "@/components/sidebar/threadReadState";

export interface ThreadActionsContextValue {
  requestRename: (thread: Thread) => void;
  requestDelete: (thread: Thread) => void;
  toggleArchive: (thread: Thread) => void;
  toggleRead: (thread: Thread) => void;
}

const ThreadActionsContext = createContext<ThreadActionsContextValue | null>(
  null,
);

export function useThreadActions(): ThreadActionsContextValue {
  const value = useContext(ThreadActionsContext);
  if (!value) {
    throw new Error(
      "useThreadActions must be used within a <ThreadActionsProvider>",
    );
  }
  return value;
}

interface ThreadActionsProviderProps {
  children: ReactNode;
}

interface ArchiveThreadActionRequest {
  force: boolean;
  managerChildThreadsConfirmed: boolean;
  thread: Thread;
}

interface DeleteThreadActionRequest {
  closeDialog: () => void;
  managerChildThreadsConfirmed: boolean;
  thread: Thread;
}

interface ManagerChildThreadsCheckRequest {
  action: ThreadManagerChildThreadsAction;
  onNoAssignedChildren: () => void;
  thread: Thread;
}

export function ThreadActionsProvider({
  children,
}: ThreadActionsProviderProps) {
  const navigate = useNavigate();
  const { threadId: viewedThreadId } = useAppRoute();
  const archiveThread = useArchiveThread();
  const unarchiveThread = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
  const markThreadUnread = useMarkThreadUnread();
  const deleteThread = useDeleteThread();
  const updateThread = useUpdateThread();
  const managerChildThreadsCheckAbortRef = useRef<AbortController | null>(null);
  // Destructure `.mutate` so useCallback deps see stable references across
  // renders. Depending on the full mutation objects would churn callback
  // identities on every isPending flip and force every useThreadActions()
  // consumer to re-render whenever any mutation fires.
  const { mutate: archiveMutate } = archiveThread;
  const { mutate: unarchiveMutate } = unarchiveThread;
  const { mutate: markReadMutate } = markThreadRead;
  const { mutate: markUnreadMutate } = markThreadUnread;
  const { mutate: deleteMutate } = deleteThread;
  const { mutate: updateMutate } = updateThread;

  const renameDialog = useDialogState<ThreadRenameDialogTarget>();
  const deleteDialog = useDialogState<Thread>();
  const archiveConfirmationDialog =
    useDialogState<ThreadArchiveConfirmationDialogTarget>();
  const managerChildThreadsConfirmationDialog =
    useDialogState<ThreadManagerChildThreadsDialogTarget>();

  const { onClose: closeRenameDialog, onOpen: openRenameDialog } = renameDialog;
  const { onClose: closeDeleteDialog, onOpen: openDeleteDialog } = deleteDialog;
  const {
    onClose: closeArchiveConfirmationDialog,
    onOpen: openArchiveConfirmationDialog,
  } = archiveConfirmationDialog;
  const {
    onClose: closeManagerChildThreadsConfirmationDialog,
    onOpen: openManagerChildThreadsConfirmationDialog,
  } = managerChildThreadsConfirmationDialog;

  useEffect(() => {
    return () => {
      managerChildThreadsCheckAbortRef.current?.abort();
      managerChildThreadsCheckAbortRef.current = null;
    };
  }, []);

  const navigateAwayIfViewing = useCallback(
    (thread: Thread) => {
      if (viewedThreadId === thread.id) {
        // Push (not replace) so the back button still returns the user to the
        // archived/deleted thread's URL if they want to re-open it.
        navigate(`/projects/${thread.projectId}`);
      }
    },
    [navigate, viewedThreadId],
  );

  const requestRename = useCallback(
    (thread: Thread) => {
      openRenameDialog({
        id: thread.id,
        currentTitle: getThreadDisplayTitle(thread),
        threadType: thread.type,
      });
    },
    [openRenameDialog],
  );

  const submitRename = useCallback(
    (threadId: string, title: string) => {
      updateMutate(
        { id: threadId, title },
        {
          onSuccess: () => {
            closeRenameDialog();
          },
        },
      );
    },
    [closeRenameDialog, updateMutate],
  );

  const checkManagerChildThreadsBeforeAction = useCallback(
    ({
      action,
      onNoAssignedChildren,
      thread,
    }: ManagerChildThreadsCheckRequest) => {
      managerChildThreadsCheckAbortRef.current?.abort();
      managerChildThreadsCheckAbortRef.current = null;

      if (thread.type !== "manager") {
        onNoAssignedChildren();
        return;
      }

      const abortController = new AbortController();
      managerChildThreadsCheckAbortRef.current = abortController;

      void getThreadAssignedChildSummary(thread.id, abortController.signal)
        .then((summary) => {
          if (
            managerChildThreadsCheckAbortRef.current !== abortController ||
            abortController.signal.aborted
          ) {
            return;
          }
          managerChildThreadsCheckAbortRef.current = null;

          if (summary.nonDeletedAssignedChildCount > 0) {
            openManagerChildThreadsConfirmationDialog({
              action,
              nonDeletedAssignedChildCount:
                summary.nonDeletedAssignedChildCount,
              thread,
            });
            return;
          }

          onNoAssignedChildren();
        })
        .catch((error) => {
          if (
            managerChildThreadsCheckAbortRef.current !== abortController ||
            abortController.signal.aborted
          ) {
            return;
          }
          managerChildThreadsCheckAbortRef.current = null;

          if (!shouldShowMutationErrorToast(error)) {
            return;
          }

          toast.error(
            getMutationErrorMessage({
              error,
              fallbackMessage: "Failed to check assigned child threads.",
            }),
          );
        });
    },
    [openManagerChildThreadsConfirmationDialog],
  );

  const performDelete = useCallback(
    ({
      closeDialog,
      managerChildThreadsConfirmed,
      thread,
    }: DeleteThreadActionRequest) => {
      deleteMutate(
        { id: thread.id, managerChildThreadsConfirmed },
        {
          onSuccess: () => {
            closeDialog();
            navigateAwayIfViewing(thread);
          },
        },
      );
    },
    [deleteMutate, navigateAwayIfViewing],
  );

  const requestDelete = useCallback(
    (thread: Thread) => {
      checkManagerChildThreadsBeforeAction({
        action: "delete",
        onNoAssignedChildren: () => {
          openDeleteDialog(thread);
        },
        thread,
      });
    },
    [checkManagerChildThreadsBeforeAction, openDeleteDialog],
  );

  const confirmDelete = useCallback(
    (thread: Thread) => {
      performDelete({
        closeDialog: closeDeleteDialog,
        managerChildThreadsConfirmed: false,
        thread,
      });
    },
    [closeDeleteDialog, performDelete],
  );

  const showArchiveError = useCallback((thread: Thread, error: unknown) => {
    toast.error(
      getMutationErrorMessage({
        error,
        fallbackMessage: `Failed to archive ${threadTypeLabel(thread.type)}.`,
      }),
    );
  }, []);

  const submitArchive = useCallback(
    ({
      force,
      managerChildThreadsConfirmed,
      thread,
    }: ArchiveThreadActionRequest) => {
      archiveMutate(
        { id: thread.id, force, managerChildThreadsConfirmed },
        {
          onSuccess: () => {
            navigateAwayIfViewing(thread);
          },
          onError: (error) => {
            if (!force && isArchiveForceRequiredError(error)) {
              openArchiveConfirmationDialog({
                managerChildThreadsConfirmed,
                thread,
              });
              return;
            }
            showArchiveError(thread, error);
          },
        },
      );
    },
    [
      archiveMutate,
      navigateAwayIfViewing,
      openArchiveConfirmationDialog,
      showArchiveError,
    ],
  );

  const requestArchive = useCallback(
    (thread: Thread) => {
      checkManagerChildThreadsBeforeAction({
        action: "archive",
        onNoAssignedChildren: () => {
          submitArchive({
            force: false,
            managerChildThreadsConfirmed: false,
            thread,
          });
        },
        thread,
      });
    },
    [checkManagerChildThreadsBeforeAction, submitArchive],
  );

  const confirmArchive = useCallback(
    (target: ThreadArchiveConfirmationDialogTarget) => {
      closeArchiveConfirmationDialog();
      submitArchive({
        force: true,
        managerChildThreadsConfirmed: target.managerChildThreadsConfirmed,
        thread: target.thread,
      });
    },
    [closeArchiveConfirmationDialog, submitArchive],
  );

  const confirmManagerChildThreadsAction = useCallback(
    (target: ThreadManagerChildThreadsDialogTarget) => {
      if (target.action === "archive") {
        closeManagerChildThreadsConfirmationDialog();
        submitArchive({
          force: false,
          managerChildThreadsConfirmed: true,
          thread: target.thread,
        });
        return;
      }

      performDelete({
        closeDialog: closeManagerChildThreadsConfirmationDialog,
        managerChildThreadsConfirmed: true,
        thread: target.thread,
      });
    },
    [closeManagerChildThreadsConfirmationDialog, performDelete, submitArchive],
  );

  const toggleArchive = useCallback(
    (thread: Thread) => {
      if (thread.archivedAt != null) {
        unarchiveMutate({ id: thread.id });
        return;
      }
      requestArchive(thread);
    },
    [requestArchive, unarchiveMutate],
  );

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
            );
          },
        });
        return;
      }
      markReadMutate(thread.id, {
        onError: (error) => {
          toast.error(
            getMutationErrorMessage({
              error,
              fallbackMessage: "Failed to mark thread read.",
            }),
          );
        },
      });
    },
    [markReadMutate, markUnreadMutate],
  );

  const value = useMemo<ThreadActionsContextValue>(
    () => ({
      requestRename,
      requestDelete,
      toggleArchive,
      toggleRead,
    }),
    [requestRename, requestDelete, toggleArchive, toggleRead],
  );

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
      <ThreadManagerChildThreadsConfirmationDialog
        target={managerChildThreadsConfirmationDialog.target}
        pending={
          managerChildThreadsConfirmationDialog.target?.action === "delete" &&
          deleteThread.isPending
        }
        onOpenChange={managerChildThreadsConfirmationDialog.onOpenChange}
        onConfirm={confirmManagerChildThreadsAction}
      />
    </ThreadActionsContext.Provider>
  );
}
