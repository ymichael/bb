import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  PromptInput,
  Thread,
  TimelineRow,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import { collectPromptAttachments } from "@/lib/prompt-attachments";
import {
  environmentGitDiffQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  statusQueryKey,
  THREADS_QUERY_KEY,
  threadQueryKey,
  threadsQueryKey,
  type ThreadListQueryFilters,
} from "./query-keys";

export interface EnvironmentActionInvalidationParams {
  environmentId: string;
}

function getThreadListFiltersFromQueryKey(
  queryKey: QueryKey,
): ThreadListQueryFilters | undefined {
  if (queryKey[0] !== THREADS_QUERY_KEY) {
    return undefined;
  }

  const candidate = queryKey[1];
  if (candidate === undefined) {
    return undefined;
  }

  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }

  return candidate;
}

export function getEnvironmentStateInvalidationQueryKeys({
  environmentId,
}: EnvironmentActionInvalidationParams): QueryKey[] {
  return [
    environmentQueryKey(environmentId),
    environmentWorkStatusQueryKeyPrefix(environmentId),
    environmentGitDiffQueryKeyPrefix(environmentId),
    environmentMergeBaseBranchesQueryKeyPrefix(environmentId),
  ];
}

export function getEnvironmentActionInvalidationQueryKeys({
  environmentId,
}: EnvironmentActionInvalidationParams): QueryKey[] {
  return [
    ...getEnvironmentStateInvalidationQueryKeys({ environmentId }),
    threadsQueryKey(),
    statusQueryKey(),
  ];
}

export function getCachedThreadListPlaceholder(
  queryClient: QueryClient,
  threadId: string,
): Thread | undefined {
  if (!threadId) {
    return undefined;
  }

  const threadLists = queryClient.getQueriesData<Thread[]>({
    queryKey: threadsQueryKey(),
  });
  for (const [, threads] of threadLists) {
    const match = threads?.find((thread) => thread.id === threadId);
    if (match) {
      return match;
    }
  }

  return undefined;
}

export function updateCachedThread(
  queryClient: QueryClient,
  threadId: string,
  updater: (thread: Thread) => Thread,
): void {
  queryClient.setQueryData<Thread>(threadQueryKey(threadId), (thread) => {
    if (!thread) {
      return thread;
    }

    return updater(thread);
  });
}

function buildOptimisticUserMessageText(input: PromptInput[]): string {
  return input
    .filter((entry): entry is Extract<PromptInput, { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text.trim())
    .filter((entry) => entry.length > 0)
    .join("\n\n");
}

export function buildOptimisticUserThreadRow(
  threadId: string,
  input: PromptInput[],
  createdAt: number,
): TimelineRow {
  const id = `optimistic-user-${createdAt}`;

  return {
    kind: "message",
    id,
    message: {
      id,
      kind: "user",
      threadId,
      text: buildOptimisticUserMessageText(input),
      attachments: collectPromptAttachments(input),
      sourceSeqStart: Number.MAX_SAFE_INTEGER,
      sourceSeqEnd: Number.MAX_SAFE_INTEGER,
      createdAt,
    },
  };
}

export function appendOptimisticUserRowToTimeline(
  timeline: ThreadTimelineResponse | undefined,
  threadId: string,
  input: PromptInput[],
  createdAt: number,
): ThreadTimelineResponse | undefined {
  if (!timeline) {
    return timeline;
  }

  return {
    ...timeline,
    rows: [...timeline.rows, buildOptimisticUserThreadRow(threadId, input, createdAt)],
  };
}

function threadMatchesListFilters(
  thread: Thread,
  filters: ThreadListQueryFilters | undefined,
): boolean {
  if (filters?.archived === true && thread.archivedAt == null) {
    return false;
  }
  if (filters?.archived !== true && thread.archivedAt != null) {
    return false;
  }
  if (filters?.projectId && thread.projectId !== filters.projectId) {
    return false;
  }
  if (filters?.type && thread.type !== filters.type) {
    return false;
  }
  if (
    filters?.parentThreadId !== undefined &&
    thread.parentThreadId !== filters.parentThreadId
  ) {
    return false;
  }

  return true;
}

export function optimisticallyInsertThread(
  queryClient: QueryClient,
  thread: Thread,
): void {
  const threadLists = queryClient.getQueriesData<Thread[]>({
    queryKey: threadsQueryKey(),
  });

  for (const [queryKey, list] of threadLists) {
    if (!list) {
      continue;
    }

    const filters = getThreadListFiltersFromQueryKey(queryKey);
    if (!threadMatchesListFilters(thread, filters)) {
      continue;
    }
    if (list.some((candidate) => candidate.id === thread.id)) {
      continue;
    }

    queryClient.setQueryData<Thread[]>(queryKey, [thread, ...list]);
  }
}
