import {
  allProjectFilesQueryKeyPrefix,
  allProjectGithubBranchesQueryKeyPrefix,
  allProjectSourceBranchesQueryKeyPrefix,
  localPathExistenceQueryKeyPrefix,
  projectFilesQueryKeyPrefix,
  projectGithubBranchesQueryKey,
  projectPromptHistoryQueryKey,
  projectPromptHistoryQueryKeyPrefix,
  projectSourceBranchesQueryKeyPrefix,
  projectsQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadDraftsQueryKey,
  threadPendingInteractionsQueryKey,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadsQueryKey,
  threadStorageFilePreviewQueryKeyPrefix,
  threadStorageFilesForThreadQueryKeyPrefix,
  threadTimelineQueryKeyPrefix,
} from "./queries/query-keys";
import type {
  ProjectArg,
  QueryClientArg,
  ThreadArg,
} from "./cache-effect-types";
import { removeEnvironmentScopedQueries } from "./environment-cache-effects";

interface ProjectSourceInvalidationArg extends QueryClientArg {
  projectId?: string;
}

export function invalidateProjectListQueries({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
}

export function invalidateProjectUpdateQueries({
  projectId,
  queryClient,
}: ProjectArg): void {
  queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
  queryClient.invalidateQueries({
    queryKey: projectFilesQueryKeyPrefix(projectId),
  });
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
}

export function invalidateProjectDeleteQueries({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
}

export function invalidateProjectSourceQueries({
  projectId,
  queryClient,
}: ProjectSourceInvalidationArg): void {
  queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
  queryClient.invalidateQueries({
    queryKey: localPathExistenceQueryKeyPrefix(),
  });
  if (!projectId) {
    queryClient.invalidateQueries({
      queryKey: allProjectFilesQueryKeyPrefix(),
    });
    queryClient.invalidateQueries({
      queryKey: allProjectSourceBranchesQueryKeyPrefix(),
    });
    queryClient.invalidateQueries({
      queryKey: allProjectGithubBranchesQueryKeyPrefix(),
    });
    return;
  }
  queryClient.invalidateQueries({
    queryKey: projectFilesQueryKeyPrefix(projectId),
  });
  queryClient.invalidateQueries({
    queryKey: projectSourceBranchesQueryKeyPrefix(projectId),
  });
  queryClient.invalidateQueries({
    queryKey: projectGithubBranchesQueryKey(projectId),
  });
}

export function refetchThreadListsAfterComposerThreadCreate({
  queryClient,
}: QueryClientArg): void {
  void queryClient.refetchQueries({
    queryKey: threadsQueryKey(),
    type: "active",
  });
}

export function invalidateProjectManagerHireQueries({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
  invalidateBackgroundThreadCreateQueries({ queryClient });
}

export function invalidateThreadListQueries({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
}

export function invalidateThreadListMembershipQueries({
  queryClient,
  threadId,
}: ThreadArg): void {
  queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
}

export function invalidateProjectPromptHistoryQueries({
  projectId,
  queryClient,
}: ProjectArg): void {
  queryClient.invalidateQueries({
    queryKey: projectPromptHistoryQueryKey(projectId),
  });
}

export function invalidateAllProjectsPromptHistoryQueries({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({
    queryKey: projectPromptHistoryQueryKeyPrefix(),
  });
}

export function invalidateThreadDeleteQueries({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
  invalidateAllProjectsPromptHistoryQueries({ queryClient });
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
}

export function invalidateThreadQueueQueries({
  queryClient,
  threadId,
}: ThreadArg): void {
  queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });
  queryClient.invalidateQueries({ queryKey: threadDraftsQueryKey(threadId) });
  queryClient.invalidateQueries({
    queryKey: threadPromptHistoryQueryKey(threadId),
  });
}

export function invalidateThreadDraftSendQueries({
  queryClient,
  threadId,
}: ThreadArg): void {
  invalidateThreadQueueQueries({ queryClient, threadId });
  queryClient.invalidateQueries({
    queryKey: threadTimelineQueryKeyPrefix(threadId),
  });
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
}

export function invalidateThreadAcceptedMessageQueries({
  queryClient,
  threadId,
}: ThreadArg): void {
  queryClient.invalidateQueries({
    queryKey: threadDefaultExecutionOptionsQueryKey(threadId),
  });
  queryClient.invalidateQueries({
    queryKey: threadPromptHistoryQueryKey(threadId),
  });
}

export function invalidateThreadAcceptedMessageQueriesWithoutRealtime({
  queryClient,
  threadId,
}: ThreadArg): void {
  invalidateThreadAcceptedMessageQueries({ queryClient, threadId });
  queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });
  queryClient.invalidateQueries({
    queryKey: threadTimelineQueryKeyPrefix(threadId),
  });
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
}

export function invalidateThreadStopQueries({
  queryClient,
  threadId,
}: ThreadArg): void {
  queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
}

export function invalidateThreadPendingInteractionResolutionQueries({
  queryClient,
  threadId,
}: ThreadArg): void {
  queryClient.invalidateQueries({
    queryKey: threadPendingInteractionsQueryKey(threadId),
  });
  queryClient.invalidateQueries({
    queryKey: threadTimelineQueryKeyPrefix(threadId),
  });
  queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
}

export function removeThreadScopedQueries({
  queryClient,
  threadId,
}: ThreadArg): void {
  queryClient.removeQueries({ queryKey: threadQueryKey(threadId) });
  queryClient.removeQueries({
    queryKey: threadTimelineQueryKeyPrefix(threadId),
  });
  queryClient.removeQueries({
    queryKey: threadDefaultExecutionOptionsQueryKey(threadId),
  });
  queryClient.removeQueries({ queryKey: threadDraftsQueryKey(threadId) });
  queryClient.removeQueries({
    queryKey: threadPromptHistoryQueryKey(threadId),
  });
  queryClient.removeQueries({
    queryKey: threadStorageFilesForThreadQueryKeyPrefix(threadId),
  });
  queryClient.removeQueries({
    queryKey: threadStorageFilePreviewQueryKeyPrefix(threadId),
  });
}

export { removeEnvironmentScopedQueries };

function invalidateBackgroundThreadCreateQueries({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
}
