import {
  createElement,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { appToast } from "@/components/ui/app-toast";
import { AppToastCommitDescription } from "@/components/ui/app-toast-descriptions";
import type { Environment, Thread, WorkspaceStatus } from "@bb/domain";
import type { CommitActionResponse } from "@bb/server-contract";
import { useDialogState } from "@/hooks/useDialogState";
import type { ThreadGitActionDialogTarget } from "@/components/dialogs/ThreadGitActionDialog";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import type { RequestEnvironmentActionMutationLike } from "./threadDetailMutationTypes";

interface EnqueueGitActionParams {
  run: QueuedGitActionRunner;
}

interface RunQueuedGitActionParams {
  toastId: string | number;
}

type QueuedGitActionRunner = (
  params: RunQueuedGitActionParams,
) => Promise<void>;

interface ShowGitActionErrorToastParams {
  error: unknown;
  toastId: string | number;
}

interface ShowGitActionSuccessToastParams {
  response: CommitActionResponse;
  toastId: string | number;
}

interface UseThreadGitActionsParams {
  environment?: Environment;
  requestEnvironmentAction: RequestEnvironmentActionMutationLike;
  thread?: Thread;
  workspaceStatus?: WorkspaceStatus;
}

export interface ThreadHeaderGitAction {
  label: string;
  target: ThreadGitActionDialogTarget;
}

const EMPTY_THREAD_HEADER_GIT_ACTIONS: ThreadHeaderGitAction[] = [];
const COMMIT_THREAD_HEADER_GIT_ACTIONS: ThreadHeaderGitAction[] = [
  { target: { kind: "commit" }, label: "Commit" },
];

function renderGitActionDescription(response: CommitActionResponse): ReactNode {
  return createElement(AppToastCommitDescription, {
    commitSha: response.commitSha,
    commitSubject: response.commitSubject,
  });
}

function showGitActionSuccessToast({
  response,
  toastId,
}: ShowGitActionSuccessToastParams): void {
  appToast.success("Commit created", {
    id: toastId,
    description: renderGitActionDescription(response),
  });
}

function showGitActionErrorToast({
  error,
  toastId,
}: ShowGitActionErrorToastParams): void {
  const title = "Commit failed";
  const message = getMutationErrorMessage({
    error,
    fallbackMessage: "Failed to start git action",
    lifecycleOperation: "commit",
  });
  const description = message === title ? undefined : message;

  appToast.error(title, {
    id: toastId,
    ...(description ? { description } : {}),
  });
}

export function useThreadGitActions({
  environment,
  requestEnvironmentAction,
  thread,
  workspaceStatus,
}: UseThreadGitActionsParams) {
  const threadGitActionDialog = useDialogState<ThreadGitActionDialogTarget>();
  const gitActionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedGitActionCountRef = useRef(0);
  const workspaceWorkingTree = workspaceStatus?.workingTree;
  const isArchivedThread = thread?.archivedAt != null;

  const canCommit =
    Boolean(thread) &&
    Boolean(workspaceStatus) &&
    Boolean(environment) &&
    !isArchivedThread &&
    workspaceWorkingTree?.hasUncommittedChanges === true;
  const threadHeaderGitActions = canCommit
    ? COMMIT_THREAD_HEADER_GIT_ACTIONS
    : EMPTY_THREAD_HEADER_GIT_ACTIONS;

  const enqueueGitAction = useCallback(
    ({ run }: EnqueueGitActionParams): Promise<void> => {
      const isQueuedBehindGitAction = queuedGitActionCountRef.current > 0;
      queuedGitActionCountRef.current += 1;
      const toastId = appToast.loading(
        isQueuedBehindGitAction ? "Commit queued" : "Creating commit",
      );

      const runQueuedGitAction = async (): Promise<void> => {
        if (isQueuedBehindGitAction) {
          appToast.loading("Creating commit", { id: toastId });
        }
        await run({ toastId });
      };

      const queuedAction = gitActionQueueRef.current.then(
        runQueuedGitAction,
        runQueuedGitAction,
      );
      gitActionQueueRef.current = queuedAction
        .catch(() => undefined)
        .finally(() => {
          queuedGitActionCountRef.current -= 1;
        });
      return queuedAction;
    },
    [],
  );

  const runCommitThread = useCallback(
    async ({ toastId }: RunQueuedGitActionParams) => {
      const attachedEnvironmentId = thread?.environmentId;
      if (!thread || !attachedEnvironmentId) {
        appToast.dismiss(toastId);
        return;
      }
      try {
        const response = await requestEnvironmentAction.mutateAsync({
          id: attachedEnvironmentId,
          action: "commit",
        });
        if (response.action !== "commit") {
          throw new Error("Expected commit action response.");
        }
        showGitActionSuccessToast({
          response,
          toastId,
        });
      } catch (nextError) {
        showGitActionErrorToast({
          error: nextError,
          toastId,
        });
      }
    },
    [requestEnvironmentAction, thread],
  );

  const handleCommitThread = useCallback(async () => {
    if (!thread?.environmentId) {
      return;
    }
    await enqueueGitAction({ run: runCommitThread });
  }, [enqueueGitAction, runCommitThread, thread?.environmentId]);

  return {
    handleCommitThread,
    threadGitActionDialog,
    threadHeaderGitActions,
  };
}
