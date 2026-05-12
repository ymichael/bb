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
import {
  getEnvironment,
  getEnvironmentWorkStatus,
  getThreadAssignedChildSummary,
} from "@/lib/api";
import { useAppRoute } from "@/hooks/useAppRoute";
import { useDialogState } from "@/hooks/useDialogState";
import {
  getMutationErrorMessage,
  shouldShowMutationErrorToast,
} from "@/lib/mutation-errors";
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
  type ThreadDirtyWorkspaceWarning,
} from "@/components/dialogs/ThreadArchiveDialog";
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

interface ThreadActionContext {
  assignedChildCount: number;
  workspaceWarning: ThreadDirtyWorkspaceWarning | null;
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
  const threadActionContextAbortRef = useRef<AbortController | null>(null);
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
      threadActionContextAbortRef.current?.abort();
      threadActionContextAbortRef.current = null;
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

  // Fetches everything the consolidated dialog needs in one pass: how many
  // child threads are still assigned (for managers), and whether the workspace
  // has uncommitted/unmerged work that the action would destroy. Returns null
  // when the caller's request was superseded (a newer click aborted us) or the
  // fetch errored — in the error case, also surfaces a toast before returning.
  const loadThreadActionContext = useCallback(
    async (
      thread: Thread,
      signal: AbortSignal,
    ): Promise<ThreadActionContext | null> => {
      try {
        const childSummaryPromise =
          thread.type === "manager"
            ? getThreadAssignedChildSummary(thread.id, signal)
            : Promise.resolve(null);
        const envPromise = thread.environmentId
          ? getEnvironment(thread.environmentId, signal)
          : Promise.resolve(null);

        const [childSummary, environment] = await Promise.all([
          childSummaryPromise,
          envPromise,
        ]);
        if (signal.aborted) return null;

        let workspaceWarning: ThreadDirtyWorkspaceWarning | null = null;
        // Workspace cleanup only needs a warning when there is a ready managed
        // workspace to inspect; destroyed/provisioning environments cannot
        // return workspace status and should not block archive.
        if (
          environment?.managed &&
          environment.status === "ready" &&
          environment.path !== null &&
          thread.environmentId
        ) {
          const workspace = await getEnvironmentWorkStatus(
            thread.environmentId,
            undefined,
            signal,
          );
          if (signal.aborted) return null;
          if (workspace) {
            const hasUncommittedChanges =
              workspace.workingTree.hasUncommittedChanges;
            const hasCommittedUnmergedChanges =
              workspace.mergeBase?.hasCommittedUnmergedChanges === true;
            if (hasUncommittedChanges || hasCommittedUnmergedChanges) {
              workspaceWarning = {
                hasUncommittedChanges,
                hasCommittedUnmergedChanges,
              };
            }
          }
        }

        return {
          assignedChildCount: childSummary?.nonDeletedAssignedChildCount ?? 0,
          workspaceWarning,
        };
      } catch (error) {
        if (signal.aborted) return null;
        if (shouldShowMutationErrorToast(error)) {
          toast.error(
            getMutationErrorMessage({
              error,
              fallbackMessage: "Failed to check thread state.",
            }),
          );
        }
        return null;
      }
    },
    [],
  );

  const claimThreadActionContextAbortController =
    useCallback((): AbortController => {
      threadActionContextAbortRef.current?.abort();
      const controller = new AbortController();
      threadActionContextAbortRef.current = controller;
      return controller;
    }, []);

  function buildDialogTargetFromContext<T extends { thread: Thread }>(
    base: T,
    context: ThreadActionContext,
  ): T & {
    assignedChildCount?: number;
    workspaceWarning?: ThreadDirtyWorkspaceWarning;
  } {
    return {
      ...base,
      ...(context.assignedChildCount > 0
        ? { assignedChildCount: context.assignedChildCount }
        : {}),
      ...(context.workspaceWarning
        ? { workspaceWarning: context.workspaceWarning }
        : {}),
    };
  }

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
    async (thread: Thread) => {
      const controller = claimThreadActionContextAbortController();
      const context = await loadThreadActionContext(thread, controller.signal);
      if (context === null || controller.signal.aborted) return;
      if (threadActionContextAbortRef.current === controller) {
        threadActionContextAbortRef.current = null;
      }
      openDeleteDialog(buildDialogTargetFromContext({ thread }, context));
    },
    [
      claimThreadActionContextAbortController,
      loadThreadActionContext,
      openDeleteDialog,
    ],
  );

  const confirmDelete = useCallback(
    (target: ThreadDeleteDialogTarget) => {
      performDelete({
        closeDialog: closeDeleteDialog,
        managerChildThreadsConfirmed: target.assignedChildCount !== undefined,
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
            showArchiveError(thread, error);
          },
        },
      );
    },
    [archiveMutate, navigateAwayIfViewing, showArchiveError],
  );

  const requestArchive = useCallback(
    async (thread: Thread) => {
      const controller = claimThreadActionContextAbortController();
      const context = await loadThreadActionContext(thread, controller.signal);
      if (context === null || controller.signal.aborted) return;
      if (threadActionContextAbortRef.current === controller) {
        threadActionContextAbortRef.current = null;
      }
      // Archive only prompts when there's something to warn about.
      if (
        context.assignedChildCount === 0 &&
        context.workspaceWarning === null
      ) {
        submitArchive({
          force: false,
          managerChildThreadsConfirmed: false,
          thread,
        });
        return;
      }
      openArchiveDialog(buildDialogTargetFromContext({ thread }, context));
    },
    [
      claimThreadActionContextAbortController,
      loadThreadActionContext,
      openArchiveDialog,
      submitArchive,
    ],
  );

  const confirmArchive = useCallback(
    (target: ThreadArchiveDialogTarget) => {
      closeArchiveDialog();
      submitArchive({
        force: target.workspaceWarning !== undefined,
        managerChildThreadsConfirmed: target.assignedChildCount !== undefined,
        thread: target.thread,
      });
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
