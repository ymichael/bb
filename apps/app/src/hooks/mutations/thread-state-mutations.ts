import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { ThreadWithRuntime } from "@bb/domain";
import type { ProjectResponse, UpdateThreadRequest } from "@bb/server-contract";
import * as api from "@/lib/api";
import {
  invalidateThreadDeleteQueries,
  invalidateThreadListMembershipQueries,
  invalidateThreadListQueries,
  removeEnvironmentScopedQueries,
  removeThreadScopedQueries,
} from "../cache-effects";
import {
  projectsQueryKey,
  threadQueryKey,
  threadsQueryKey,
} from "../queries/query-keys";
import {
  applyToCachedThreadLists,
  getCachedThreadLists,
  type ThreadListCacheData,
} from "../queries/thread-list-cache-data";

interface ThreadMutationRequest {
  id: string;
}

type UpdateThreadMutationRequest = ThreadMutationRequest & UpdateThreadRequest;

type ThreadListSnapshot = Array<{
  queryKey: QueryKey;
  data: ThreadListCacheData;
}>;

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
  previousThread: ThreadWithRuntime | undefined;
  previousThreadLists: ThreadListSnapshot;
}

interface UpdateThreadInListsArgs {
  queryClient: QueryClient;
  thread: ThreadWithRuntime;
}

function snapshotThreadLists(queryClient: QueryClient): ThreadListSnapshot {
  return getCachedThreadLists(queryClient, { queryKey: threadsQueryKey() });
}

function removeThreadFromLists(queryClient: QueryClient, id: string): void {
  applyToCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
    mapper: (list) => list.filter((thread) => thread.id !== id),
  });
}

function restoreThreadLists(
  queryClient: QueryClient,
  threadLists: ThreadListSnapshot,
): void {
  for (const { queryKey, data } of threadLists) {
    queryClient.setQueryData(queryKey, data);
  }
}

function updateThreadInLists({
  queryClient,
  thread,
}: UpdateThreadInListsArgs): void {
  applyToCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
    mapper: (list) =>
      list.map((candidate) =>
        candidate.id === thread.id ? { ...candidate, ...thread } : candidate,
      ),
  });
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
      invalidateThreadListQueries({ queryClient });
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
      const previousThreadLists = snapshotThreadLists(queryClient);

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

      removeThreadFromLists(queryClient, id);

      return {
        previousThread,
        previousThreadLists,
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
    onSettled: (_data, _error, variables) => {
      invalidateThreadListMembershipQueries({
        queryClient,
        threadId: variables.id,
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
      const previousThreadLists = snapshotThreadLists(queryClient);

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

      removeThreadFromLists(queryClient, id);

      return {
        previousThread,
        previousThreadLists,
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
    onSettled: (_data, _error, variables) => {
      invalidateThreadListMembershipQueries({
        queryClient,
        threadId: variables.id,
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
      const previousThreadLists = snapshotThreadLists(queryClient);
      const previousProjects =
        queryClient.getQueryData<ProjectResponse[]>(projectsQueryKey());
      const environmentId = previousThread?.environmentId;

      removeThreadScopedQueries({ queryClient, threadId: id });
      removeEnvironmentScopedQueries({ environmentId, queryClient });

      removeThreadFromLists(queryClient, id);

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
      updateThreadInLists({ queryClient, thread });
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
      updateThreadInLists({ queryClient, thread });
    },
  });
}
