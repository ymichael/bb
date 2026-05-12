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
import {
  ThreadDeleteDialog,
  type ThreadDeleteDialogTarget,
} from "@/components/dialogs/ThreadDeleteDialog";
import {
  ThreadArchiveDialog,
  type ThreadArchiveDialogTarget,
} from "@/components/dialogs/ThreadArchiveDialog";

type ManagerChildThreadsAction = "archive" | "delete";
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
  action: ManagerChildThreadsAction;
  onAssignedChildren: (count: number) => void;
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
  const deleteDialog = useDialogState<ThreadDeleteDialogTarget>();
  const archiveDialog = useDialogState<ThreadArchiveDialogTarget>();

  const { onClose: closeRenameDialog, onOpen: openRenameDialog } = renameDialog;
  const { onClose: closeDeleteDialog, onOpen: openDeleteDialog } = deleteDialog;
  const { onClose: closeArchiveDialog, onOpen: openArchiveDialog } =
    archiveDialog;

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
      onAssignedChildren,
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
            onAssignedChildren(summary.nonDeletedAssignedChildCount);
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
    [],
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
        onAssignedChildren: (assignedChildCount) => {
          openDeleteDialog({
            kind: "assigned-children",
            thread,
            assignedChildCount,
          });
        },
        onNoAssignedChildren: () => {
          openDeleteDialog({ kind: "standard", thread });
        },
        thread,
      });
    },
    [checkManagerChildThreadsBeforeAction, openDeleteDialog],
  );

  const confirmDelete = useCallback(
    (target: ThreadDeleteDialogTarget) => {
      performDelete({
        closeDialog: closeDeleteDialog,
        managerChildThreadsConfirmed: target.kind === "assigned-children",
        thread: target.thread,
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
              openArchiveDialog({
                kind: "workspace-dirty",
                thread,
                managerChildThreadsConfirmed,
              });
              return;
            }
            showArchiveError(thread, error);
          },
        },
      );
    },
    [archiveMutate, navigateAwayIfViewing, openArchiveDialog, showArchiveError],
  );

  const requestArchive = useCallback(
    (thread: Thread) => {
      checkManagerChildThreadsBeforeAction({
        action: "archive",
        onAssignedChildren: (assignedChildCount) => {
          openArchiveDialog({
            kind: "assigned-children",
            thread,
            assignedChildCount,
          });
        },
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
    [checkManagerChildThreadsBeforeAction, openArchiveDialog, submitArchive],
  );

  const confirmArchive = useCallback(
    (target: ThreadArchiveDialogTarget) => {
      closeArchiveDialog();
      switch (target.kind) {
        case "assigned-children":
          submitArchive({
            force: false,
            managerChildThreadsConfirmed: true,
            thread: target.thread,
          });
          return;
        case "workspace-dirty":
          submitArchive({
            force: true,
            managerChildThreadsConfirmed: target.managerChildThreadsConfirmed,
            thread: target.thread,
          });
          return;
      }
    },
    [closeArchiveDialog, submitArchive],
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
      <ThreadArchiveDialog
        target={archiveDialog.target}
        pending={archiveThread.isPending}
        onOpenChange={archiveDialog.onOpenChange}
        onArchive={confirmArchive}
      />
    </ThreadActionsContext.Provider>
  );
}
