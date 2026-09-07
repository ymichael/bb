import type { ArchiveThreadsTransaction } from "./thread-state-cache-owner";
import type { QueryClient } from "@tanstack/react-query";
import { threadQueryKey, threadsQueryKey } from "../queries/query-keys";
import { snapshotCachedSidebarNavigation } from "./query-cache";
import { getCachedThreadLists } from "./thread-list-cache-data";
import {
  getCachedLiveThreadIdsMatching,
  getCachedThreadSnapshots,
  optimisticallyArchiveThreads,
  removeLiveThreadsFromCachedLists,
} from "./thread-archive-cache";

interface ArchiveEnvironmentThreadsTransactionArgs {
  environmentId: string;
  queryClient: QueryClient;
}

export async function beginArchiveEnvironmentThreadsTransaction({
  environmentId,
  queryClient,
}: ArchiveEnvironmentThreadsTransactionArgs): Promise<ArchiveThreadsTransaction> {
  await queryClient.cancelQueries({ queryKey: threadsQueryKey() });
  const archivedThreadIds = getCachedLiveThreadIdsMatching({
    matchesThread: (thread) => thread.environmentId === environmentId,
    queryClient,
  });
  await Promise.all(
    archivedThreadIds.map((threadId) =>
      queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) }),
    ),
  );

  const previousThreadLists = getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  });
  const previousSidebarNavigation =
    snapshotCachedSidebarNavigation(queryClient);
  const previousThreads = getCachedThreadSnapshots({
    queryClient,
    threadIds: archivedThreadIds,
  });

  optimisticallyArchiveThreads({
    queryClient,
    threadIds: archivedThreadIds,
  });
  removeLiveThreadsFromCachedLists({
    matchesThread: (thread) => thread.environmentId === environmentId,
    queryClient,
  });

  return {
    archivedThreadIds,
    previousSidebarNavigation,
    previousThreadLists,
    previousThreads,
  };
}
