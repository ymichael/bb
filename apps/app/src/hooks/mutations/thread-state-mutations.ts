import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import type { ProjectResponse, UpdateThreadRequest } from "@bb/server-contract";
import * as api from "@/lib/api";
import {
  invalidateProjectPromptHistoryQueries,
  invalidateThreadDeleteQueries,
  invalidateThreadListMembershipQueries,
  invalidateThreadReadStateQueries,
  invalidateThreadListAndStatusQueries,
  removeEnvironmentScopedQueries,
  removeThreadScopedQueries,
} from "../cache-effects";
import {
  projectsQueryKey,
  threadQueryKey,
  threadsQueryKey,
} from "../queries/query-keys";

interface ThreadMutationRequest {
  id: string;
}

type UpdateThreadMutationRequest = ThreadMutationRequest & UpdateThreadRequest;

type ThreadListSnapshot = Array<
  readonly [QueryKey, ThreadListEntry[] | undefined]
>;

interface ArchiveThreadMutationRequest {
  id: string;
  force: boolean;
  managerChildThreadsConfirmed: boolean;
}

interface DeleteThreadMutationRequest {
  id: string;
  managerChildThreadsConfirmed: boolean;
}

interface DeleteThreadMutationContext {
  previousThread: ThreadWithRuntime | undefined;
  previousThreadLists: ThreadListSnapshot;
  previousProjects: ProjectResponse[] | undefined;
  environmentId: string | null | undefined;
}

interface ThreadListMutationContext {
  projectId: string | null;
  previousThread: ThreadWithRuntime | undefined;
  previousThreadLists: ThreadListSnapshot;
}

function resolveProjectIdForThread(args: {
  previousThread: ThreadWithRuntime | undefined;
  previousThreadLists: ThreadListSnapshot;
  threadId: string;
}): string | null {
  if (args.previousThread) {
    return args.previousThread.projectId;
  }

  for (const [, list] of args.previousThreadLists) {
    const thread = list?.find((entry) => entry.id === args.threadId);
    if (thread) {
      return thread.projectId;
    }
  }

  return null;
}

function archiveThreadInLists(
  queryClient: QueryClient,
  threadLists: ThreadListSnapshot,
  id: string,
): void {
  for (const [queryKey, list] of threadLists) {
    if (!list) {
      continue;
    }

    queryClient.setQueryData<ThreadListEntry[]>(
      queryKey,
      list.filter((thread) => thread.id !== id),
    );
  }
}

function restoreThreadLists(
  queryClient: QueryClient,
  threadLists: ThreadListSnapshot,
): void {
  for (const [queryKey, data] of threadLists) {
    queryClient.setQueryData(queryKey, data);
  }
}

export function useUpdateThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update thread.",
    },
    mutationFn: ({ id, ...request }: UpdateThreadMutationRequest) =>
      api.updateThread(id, request),
    onSuccess: (thread) => {
      queryClient.setQueryData<ThreadWithRuntime>(
        threadQueryKey(thread.id),
        thread,
      );
      invalidateThreadListAndStatusQueries({ queryClient });
    },
  });
}

export function useArchiveThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to archive thread.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      force,
      managerChildThreadsConfirmed,
    }: ArchiveThreadMutationRequest) =>
      api.archiveThread(id, { force, managerChildThreadsConfirmed }),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: threadQueryKey(id) });
      await queryClient.cancelQueries({ queryKey: threadsQueryKey() });

      const previousThread = queryClient.getQueryData<ThreadWithRuntime>(
        threadQueryKey(id),
      );
      const previousThreadLists = queryClient.getQueriesData<ThreadListEntry[]>(
        {
          queryKey: threadsQueryKey(),
        },
      );

      const archivedAt = Date.now();

      queryClient.setQueryData<ThreadWithRuntime>(
        threadQueryKey(id),
        (thread) => {
          if (!thread) {
            return thread;
          }

          return {
            ...thread,
            archivedAt,
          };
        },
      );

      archiveThreadInLists(queryClient, previousThreadLists, id);

      return {
        previousThread,
        previousThreadLists,
        projectId: resolveProjectIdForThread({
          previousThread,
          previousThreadLists,
          threadId: id,
        }),
      };
    },
    onError: (_error, variables, context?: ThreadListMutationContext) => {
      if (!context) {
        return;
      }

      queryClient.setQueryData(
        threadQueryKey(variables.id),
        context.previousThread,
      );
      restoreThreadLists(queryClient, context.previousThreadLists);
    },
    onSettled: (_data, _error, variables, context) => {
      invalidateThreadListMembershipQueries({
        queryClient,
        threadId: variables.id,
      });
      if (!context?.projectId) {
        return;
      }
      invalidateProjectPromptHistoryQueries({
        queryClient,
        projectId: context.projectId,
      });
    },
  });
}

export function useUnarchiveThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to unarchive thread.",
    },
    mutationFn: ({ id }: ThreadMutationRequest) => api.unarchiveThread(id),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: threadQueryKey(id) });
      await queryClient.cancelQueries({ queryKey: threadsQueryKey() });

      const previousThread = queryClient.getQueryData<ThreadWithRuntime>(
        threadQueryKey(id),
      );
      const previousThreadLists = queryClient.getQueriesData<ThreadListEntry[]>(
        {
          queryKey: threadsQueryKey(),
        },
      );

      queryClient.setQueryData<ThreadWithRuntime>(
        threadQueryKey(id),
        (thread) => {
          if (!thread) {
            return thread;
          }

          return {
            ...thread,
            archivedAt: null,
          };
        },
      );

      for (const [queryKey, list] of previousThreadLists) {
        if (!list) {
          continue;
        }

        queryClient.setQueryData<ThreadListEntry[]>(
          queryKey,
          list.map((thread) =>
            thread.id === id
              ? {
                  ...thread,
                  archivedAt: null,
                }
              : thread,
          ),
        );
      }

      return {
        previousThread,
        previousThreadLists,
        projectId: resolveProjectIdForThread({
          previousThread,
          previousThreadLists,
          threadId: id,
        }),
      };
    },
    onError: (_error, variables, context?: ThreadListMutationContext) => {
      if (!context) {
        return;
      }

      queryClient.setQueryData(
        threadQueryKey(variables.id),
        context.previousThread,
      );
      restoreThreadLists(queryClient, context.previousThreadLists);
    },
    onSettled: (_data, _error, variables, context) => {
      invalidateThreadListMembershipQueries({
        queryClient,
        threadId: variables.id,
      });
      if (!context?.projectId) {
        return;
      }
      invalidateProjectPromptHistoryQueries({
        queryClient,
        projectId: context.projectId,
      });
    },
  });
}

export function useDeleteThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to delete thread.",
    },
    mutationFn: ({
      id,
      managerChildThreadsConfirmed,
    }: DeleteThreadMutationRequest) =>
      api.deleteThread(id, { managerChildThreadsConfirmed }),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: threadQueryKey(id) });
      await queryClient.cancelQueries({ queryKey: threadsQueryKey() });
      await queryClient.cancelQueries({ queryKey: projectsQueryKey() });

      const previousThread = queryClient.getQueryData<ThreadWithRuntime>(
        threadQueryKey(id),
      );
      const previousThreadLists = queryClient.getQueriesData<ThreadListEntry[]>(
        {
          queryKey: threadsQueryKey(),
        },
      );
      const previousProjects =
        queryClient.getQueryData<ProjectResponse[]>(projectsQueryKey());
      const environmentId = previousThread?.environmentId;

      removeThreadScopedQueries({ queryClient, threadId: id });
      removeEnvironmentScopedQueries({ environmentId, queryClient });

      for (const [queryKey, list] of previousThreadLists) {
        if (!list) {
          continue;
        }

        queryClient.setQueryData<ThreadListEntry[]>(
          queryKey,
          list.filter((thread) => thread.id !== id),
        );
      }

      return {
        previousThread,
        previousThreadLists,
        previousProjects,
        environmentId,
      };
    },
    onError: (_error, variables, context?: DeleteThreadMutationContext) => {
      if (!context) {
        return;
      }

      queryClient.setQueryData(
        threadQueryKey(variables.id),
        context.previousThread,
      );
      restoreThreadLists(queryClient, context.previousThreadLists);
      queryClient.setQueryData(projectsQueryKey(), context.previousProjects);
    },
    onSettled: (_data, _error, variables, context) => {
      removeThreadScopedQueries({ queryClient, threadId: variables.id });
      removeEnvironmentScopedQueries({
        environmentId: context?.environmentId,
        queryClient,
      });
      invalidateThreadDeleteQueries({ queryClient });
    },
  });
}

export function useMarkThreadRead() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to mark thread read.",
      showErrorToast: false,
    },
    mutationFn: (threadId: string) => api.markThreadRead(threadId),
    onSuccess: (thread) => {
      queryClient.setQueryData<ThreadWithRuntime>(
        threadQueryKey(thread.id),
        thread,
      );
      invalidateThreadReadStateQueries({ queryClient });
    },
  });
}

export function useMarkThreadUnread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to mark thread unread.",
      showErrorToast: false,
    },
    mutationFn: (threadId: string) => api.markThreadUnread(threadId),
    onSuccess: (thread) => {
      queryClient.setQueryData<ThreadWithRuntime>(
        threadQueryKey(thread.id),
        thread,
      );
      invalidateThreadReadStateQueries({ queryClient });
    },
  });
}
