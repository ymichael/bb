import { useCallback, useMemo } from "react";
import type {
  Environment,
  PromptInput,
  Thread,
  WorkspaceStatus,
} from "@bb/domain";
import type { EnvironmentActionFailureDetails } from "@bb/server-contract";
import { environmentActionFailureDetailsSchema } from "@bb/server-contract";
import { useDialogState } from "@/hooks/useDialogState";
import {
  ThreadGitActionDialogError,
  type ThreadGitActionDialogTarget,
} from "@/components/thread/ThreadGitActionDialog";
import {
  buildCommitFailureFollowUpInstruction,
  buildSquashMergeCommitFailureFollowUpInstruction,
  buildSquashMergeConflictFollowUpInstruction,
} from "@/lib/thread-operation-prompts";
import { HttpError } from "@/lib/api";
import type {
  RequestEnvironmentActionMutationLike,
  SendMessageMutationLike,
} from "./threadDetailMutationTypes";

interface BuildAskAgentInputForGitOperationParams {
  error: unknown;
  mergeBaseBranch?: string;
}

interface ToThreadGitActionDialogErrorParams {
  error: unknown;
  mergeBaseBranch?: string;
}

interface SquashMergeThreadParams {
  mergeBaseBranch: string;
}

interface UseThreadGitActionsParams {
  environment?: Environment;
  requestEnvironmentAction: RequestEnvironmentActionMutationLike;
  sendMessage: SendMessageMutationLike;
  thread?: Thread;
  workspaceStatus?: WorkspaceStatus;
}

interface ThreadHeaderGitAction {
  label: string;
  target: ThreadGitActionDialogTarget;
}

function toEnvironmentActionFailureDetails(
  error: unknown,
): EnvironmentActionFailureDetails | undefined {
  if (!(error instanceof HttpError) || typeof error.body !== "object" || error.body === null) {
    return undefined;
  }
  if (!("details" in error.body)) {
    return undefined;
  }

  const result = environmentActionFailureDetailsSchema.safeParse(error.body.details);
  return result.success ? result.data : undefined;
}

function buildAskAgentInputForGitOperation({
  error,
  mergeBaseBranch,
}: BuildAskAgentInputForGitOperationParams): PromptInput[] | undefined {
  const details = toEnvironmentActionFailureDetails(error);
  if (!details) {
    return undefined;
  }

  switch (details.kind) {
    case "commit_failed":
      return [
        {
          type: "text",
          text: buildCommitFailureFollowUpInstruction({
            errorMessage: details.errorMessage,
          }),
        },
      ];
    case "squash_merge_conflict":
      if (!mergeBaseBranch) {
        return undefined;
      }
      return [
        {
          type: "text",
          text: buildSquashMergeConflictFollowUpInstruction(
            {
              action: "squash_merge",
              options: {
                mergeBaseBranch,
              },
            },
            { conflictFiles: details.conflictFiles },
          ),
        },
      ];
    case "squash_merge_commit_failed":
      if (!mergeBaseBranch) {
        return undefined;
      }
      return [
        {
          type: "text",
          text: buildSquashMergeCommitFailureFollowUpInstruction(
            {
              action: "squash_merge",
              options: {
                mergeBaseBranch,
              },
            },
            {
              stage: details.stage,
              errorMessage: details.errorMessage,
            },
          ),
        },
      ];
    default:
      return undefined;
  }
}

function toThreadGitActionDialogError({
  error,
  mergeBaseBranch,
}: ToThreadGitActionDialogErrorParams): ThreadGitActionDialogError {
  const message =
    error instanceof Error ? error.message : "Failed to start git action";

  return new ThreadGitActionDialogError(message, {
    askAgentInput: buildAskAgentInputForGitOperation({
      error,
      mergeBaseBranch,
    }),
  });
}

export function useThreadGitActions({
  environment,
  requestEnvironmentAction,
  sendMessage,
  thread,
  workspaceStatus,
}: UseThreadGitActionsParams) {
  const threadGitActionDialog = useDialogState<ThreadGitActionDialogTarget>();
  const workspaceWorkingTree = workspaceStatus?.workingTree;
  const workspaceMergeBase = workspaceStatus?.mergeBase;
  const canUseGitUi = thread?.type !== "manager";
  const isArchivedThread = thread?.archivedAt != null;
  const isDirectThreadEnvironment = environment?.managed === false;

  const threadHeaderGitAction = useMemo<ThreadHeaderGitAction | null>(() => {
    if (!thread || !canUseGitUi || !workspaceStatus || isArchivedThread) {
      return null;
    }

    if (isDirectThreadEnvironment) {
      if (!workspaceWorkingTree?.hasUncommittedChanges) {
        return null;
      }

      return {
        target: { kind: "commit" },
        label: "Commit",
      };
    }

    if (
      environment?.managed &&
      (
        workspaceMergeBase?.hasCommittedUnmergedChanges ||
        workspaceWorkingTree?.hasUncommittedChanges
      )
    ) {
      return {
        target: {
          kind: workspaceWorkingTree?.hasUncommittedChanges
            ? "commit_and_squash_merge"
            : "squash_merge",
        },
        label: "Squash merge",
      };
    }

    return null;
  }, [
    canUseGitUi,
    environment?.managed,
    isArchivedThread,
    isDirectThreadEnvironment,
    thread,
    workspaceMergeBase?.hasCommittedUnmergedChanges,
    workspaceStatus,
    workspaceWorkingTree?.hasUncommittedChanges,
  ]);

  const handleCommitThread = useCallback(async () => {
    const attachedEnvironmentId = thread?.environmentId;
    if (!thread || !attachedEnvironmentId) {
      return;
    }

    try {
      await requestEnvironmentAction.mutateAsync({
        id: attachedEnvironmentId,
        action: "commit",
      });
    } catch (nextError) {
      throw toThreadGitActionDialogError({ error: nextError });
    }
  }, [requestEnvironmentAction, thread]);

  const handleSquashMergeThread = useCallback(async ({
    mergeBaseBranch,
  }: SquashMergeThreadParams) => {
    const attachedEnvironmentId = thread?.environmentId;
    if (!thread || !attachedEnvironmentId) {
      return;
    }

    try {
      await requestEnvironmentAction.mutateAsync({
        id: attachedEnvironmentId,
        action: "squash_merge",
        options: {
          mergeBaseBranch,
        },
      });
    } catch (nextError) {
      throw toThreadGitActionDialogError({
        error: nextError,
        mergeBaseBranch,
      });
    }
  }, [requestEnvironmentAction, thread]);

  const handleAskAgentToFixGitAction = useCallback(async (input: PromptInput[]) => {
    if (!thread) {
      return;
    }

    await sendMessage.mutateAsync({
      id: thread.id,
      input,
      mode: "auto",
    });
  }, [sendMessage, thread]);

  return {
    handleAskAgentToFixGitAction,
    handleCommitThread,
    handleSquashMergeThread,
    isThreadGitActionPending: requestEnvironmentAction.isPending,
    threadGitActionDialog,
    threadHeaderGitAction,
  };
}
