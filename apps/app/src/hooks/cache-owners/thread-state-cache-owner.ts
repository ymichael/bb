import type { QueryClient } from "@tanstack/react-query";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import type {
  ProjectResponse,
  ReorderPinnedThreadRequest,
  ThreadArchiveAllResponse,
} from "@bb/server-contract";
import { applyNeighborReorder } from "@bb/client-core";
import {
  projectsQueryKey,
  sidebarNavigationQueryKey,
  threadQueryKey,
  threadSearchQueryKeyPrefix,
  threadsQueryKey,
} from "../queries/query-keys";
import { removeEnvironmentScopedQueries } from "./environment-cache-effects";
import {
  invalidateThreadDeleteQueries,
  invalidateThreadListMembershipQueries,
  invalidateThreadListQueries,
  removeThreadScopedQueries,
} from "./mutation-cache-effects";
import {
  applyToCachedThreadListsAndSidebarNavigation,
  restoreCachedSidebarNavigation,
  snapshotCachedSidebarNavigation,
  type CachedSidebarNavigationSnapshot,
} from "./query-cache";
import {
  getCachedThreadLists,
  restoreCachedThreadLists,
  type CachedThreadListSnapshot,
} from "./thread-list-cache-data";
import {
  getCachedLiveThreadIdsMatching,
  getCachedThreadSnapshots,
  optimisticallyArchiveThreads,
  removeLiveThreadsFromCachedLists,
  type CachedThreadSnapshot,
} from "./thread-archive-cache";

interface ThreadIdCacheArgs {
  queryClient: QueryClient;
  threadId: string;
}

interface ThreadRuntimeCacheArgs {
  queryClient: QueryClient;
  thread: ThreadWithRuntime;
}

interface ThreadPinSuccessArgs extends ThreadRuntimeCacheArgs {
  pinSortKey: string | null;
}

interface BeginThreadPinTransactionArgs extends ThreadIdCacheArgs {
  pinnedAt: number;
}

interface BeginUnpinAndMoveThreadTransactionArgs extends ThreadIdCacheArgs {
  sectionId: string | null;
}

interface BeginThreadReadStateTransactionArgs extends ThreadIdCacheArgs {
  lastReadAt: number | null;
}

interface BeginThreadMetadataTransactionArgs extends ThreadIdCacheArgs {
  sectionId?: string | null;
  title?: string | null;
}

interface ReorderPinnedThreadTransactionRequest extends ReorderPinnedThreadRequest {
  id: string;
}

interface ReorderPinnedThreadTransactionArgs {
  queryClient: QueryClient;
  request: ReorderPinnedThreadTransactionRequest;
}

interface PinnedRootResponseArgs {
  orderedRoots: readonly ThreadListEntry[];
  queryClient: QueryClient;
}

interface PinnedRootOrderListArgs {
  list: ThreadListEntry[];
  request: ReorderPinnedThreadTransactionRequest;
}

interface RollbackThreadListMutationTransactionArgs extends ThreadIdCacheArgs {
  transaction: ThreadListMutationTransaction | undefined;
}

interface RollbackPinnedThreadOrderTransactionArgs {
  queryClient: QueryClient;
  transaction: PinnedThreadOrderTransaction | undefined;
}

interface ArchiveThreadAndChildrenTransactionArgs {
  queryClient: QueryClient;
  threadId: string;
}

interface RollbackArchiveThreadsTransactionArgs {
  queryClient: QueryClient;
  transaction: ArchiveThreadsTransaction | undefined;
}

interface SettleArchiveThreadsTransactionArgs {
  queryClient: QueryClient;
  response: ThreadArchiveAllResponse | undefined;
  transaction: ArchiveThreadsTransaction | undefined;
}

interface RollbackDeleteThreadTransactionArgs extends ThreadIdCacheArgs {
  transaction: DeleteThreadTransaction | undefined;
}

interface SettleDeleteThreadTransactionArgs extends ThreadIdCacheArgs {
  transaction: DeleteThreadTransaction | undefined;
}

export interface ThreadListMutationTransaction {
  previousSidebarNavigation: CachedSidebarNavigationSnapshot;
  previousThread: ThreadWithRuntime | undefined;
  previousThreadLists: CachedThreadListSnapshot;
}

export interface PinnedThreadOrderTransaction {
  previousSidebarNavigation: CachedSidebarNavigationSnapshot;
  previousThreadLists: CachedThreadListSnapshot;
}

export interface ArchiveThreadsTransaction {
  archivedThreadIds: string[];
  previousSidebarNavigation: CachedSidebarNavigationSnapshot;
  previousThreadLists: CachedThreadListSnapshot;
  previousThreads: CachedThreadSnapshot[];
}

export interface DeleteThreadTransaction {
  environmentId: string | null | undefined;
  previousProjects: ProjectResponse[] | undefined;
  previousSidebarNavigation: CachedSidebarNavigationSnapshot;
  previousThread: ThreadWithRuntime | undefined;
  previousThreadLists: CachedThreadListSnapshot;
}

function removeThreadFromLists(queryClient: QueryClient, id: string): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    list.filter((thread) => thread.id !== id),
  );
}

function updateThreadInLists({
  queryClient,
  thread,
}: ThreadRuntimeCacheArgs): void {
  const updateThread = (list: ThreadListEntry[]) =>
    list.map((candidate) =>
      candidate.id === thread.id ? { ...candidate, ...thread } : candidate,
    );
  applyToCachedThreadListsAndSidebarNavigation(queryClient, updateThread);
}

function updateThreadPinStateInLists({
  pinSortKey,
  queryClient,
  thread,
}: ThreadPinSuccessArgs): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    list.map((candidate) =>
      candidate.id === thread.id
        ? { ...candidate, ...thread, pinSortKey }
        : candidate,
    ),
  );
}

function getOptimisticLastReadAt(
  thread: Pick<ThreadWithRuntime, "latestAttentionAt">,
  lastReadAt: number | null,
): number | null {
  if (lastReadAt === null) {
    return null;
  }
  return Math.max(lastReadAt, thread.latestAttentionAt);
}

function applyPinnedRootResponseToLists({
  orderedRoots,
  queryClient,
}: PinnedRootResponseArgs): void {
  const rootsById = new Map(orderedRoots.map((thread) => [thread.id, thread]));
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    list.map((candidate) => rootsById.get(candidate.id) ?? candidate),
  );
}

function applyPinnedRootOrderToList({
  list,
  request,
}: PinnedRootOrderListArgs): ThreadListEntry[] {
  const pinnedRoots = list.filter(
    (thread) => thread.pinnedAt !== null && thread.pinSortKey !== null,
  );
  const reorderedRoots = applyNeighborReorder({
    items: pinnedRoots,
    request: {
      itemId: request.id,
      previousItemId: request.previousThreadId,
      nextItemId: request.nextThreadId,
    },
  });
  const reorderedRootKeysById = new Map(
    reorderedRoots.map((thread, index) => [
      thread.id,
      pinnedRoots[index]?.pinSortKey ?? thread.pinSortKey,
    ]),
  );
  return list.map((thread) => {
    const pinSortKey = reorderedRootKeysById.get(thread.id);
    return pinSortKey === undefined ? thread : { ...thread, pinSortKey };
  });
}

function applyOptimisticPinnedRootOrder({
  queryClient,
  request,
}: ReorderPinnedThreadTransactionArgs): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    applyPinnedRootOrderToList({ list, request }),
  );
}

export function applyThreadUpdateResult({
  queryClient,
  thread,
}: ThreadRuntimeCacheArgs): void {
  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(thread.id),
    thread,
  );
  invalidateThreadListQueries({ queryClient });
}

interface OptimisticThreadFieldTransactionArgs extends ThreadIdCacheArgs {
  patch?: Partial<ThreadWithRuntime>;
  patchThread?: (thread: ThreadWithRuntime) => ThreadWithRuntime;
  applyToLists: (queryClient: QueryClient, threadId: string) => void;
}

async function runOptimisticThreadFieldTransaction({
  applyToLists,
  patch,
  patchThread,
  queryClient,
  threadId,
}: OptimisticThreadFieldTransactionArgs): Promise<ThreadListMutationTransaction> {
  await queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) });
  await queryClient.cancelQueries({ queryKey: threadsQueryKey() });
  await queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() });

  const previousThread = queryClient.getQueryData<ThreadWithRuntime>(
    threadQueryKey(threadId),
  );
  const previousThreadLists = getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  });
  const previousSidebarNavigation =
    snapshotCachedSidebarNavigation(queryClient);

  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(threadId),
    (thread) => {
      if (!thread) {
        return thread;
      }

      if (patchThread) {
        return patchThread(thread);
      }

      return {
        ...thread,
        ...(patch ?? {}),
      };
    },
  );
  applyToLists(queryClient, threadId);

  return {
    previousSidebarNavigation,
    previousThread,
    previousThreadLists,
  };
}

export function beginPinThreadTransaction({
  pinnedAt,
  queryClient,
  threadId,
}: BeginThreadPinTransactionArgs): Promise<ThreadListMutationTransaction> {
  return runOptimisticThreadFieldTransaction({
    applyToLists: (queryClient, threadId) =>
      applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
        list.map((thread) =>
          thread.id === threadId
            ? { ...thread, pinnedAt, pinSortKey: null }
            : thread,
        ),
      ),
    patch: { pinnedAt },
    queryClient,
    threadId,
  });
}

export function beginUnpinThreadTransaction({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): Promise<ThreadListMutationTransaction> {
  return runOptimisticThreadFieldTransaction({
    applyToLists: (queryClient, threadId) =>
      applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
        list.map((thread) =>
          thread.id === threadId
            ? { ...thread, pinnedAt: null, pinSortKey: null }
            : thread,
        ),
      ),
    patch: { pinnedAt: null },
    queryClient,
    threadId,
  });
}

export function beginUnpinAndMoveThreadTransaction({
  sectionId,
  queryClient,
  threadId,
}: BeginUnpinAndMoveThreadTransactionArgs): Promise<ThreadListMutationTransaction> {
  return runOptimisticThreadFieldTransaction({
    applyToLists: (queryClient, threadId) =>
      applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
        list.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                sectionId,
                pinnedAt: null,
                pinSortKey: null,
              }
            : thread,
        ),
      ),
    patch: { sectionId, pinnedAt: null },
    queryClient,
    threadId,
  });
}

export function beginThreadReadStateTransaction({
  lastReadAt,
  queryClient,
  threadId,
}: BeginThreadReadStateTransactionArgs): Promise<ThreadListMutationTransaction> {
  return runOptimisticThreadFieldTransaction({
    applyToLists: (queryClient, threadId) =>
      applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
        list.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                lastReadAt: getOptimisticLastReadAt(thread, lastReadAt),
              }
            : thread,
        ),
      ),
    patchThread: (thread) => ({
      ...thread,
      lastReadAt: getOptimisticLastReadAt(thread, lastReadAt),
    }),
    queryClient,
    threadId,
  });
}

export function beginThreadMetadataTransaction({
  sectionId,
  queryClient,
  threadId,
  title,
}: BeginThreadMetadataTransactionArgs): Promise<ThreadListMutationTransaction> {
  const patch = {
    ...(title !== undefined ? { title } : {}),
    ...(sectionId !== undefined ? { sectionId } : {}),
  };
  return runOptimisticThreadFieldTransaction({
    applyToLists: (queryClient, threadId) =>
      applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
        list.map((thread) =>
          thread.id === threadId ? { ...thread, ...patch } : thread,
        ),
      ),
    patch,
    queryClient,
    threadId,
  });
}

export function rollbackThreadListMutationTransaction({
  queryClient,
  threadId,
  transaction,
}: RollbackThreadListMutationTransactionArgs): void {
  if (!transaction) {
    return;
  }

  queryClient.setQueryData(
    threadQueryKey(threadId),
    transaction.previousThread,
  );
  restoreCachedThreadLists(queryClient, transaction.previousThreadLists);
  restoreCachedSidebarNavigation(
    queryClient,
    transaction.previousSidebarNavigation,
  );
}

export function applyThreadPinStateResult({
  pinSortKey,
  queryClient,
  thread,
}: ThreadPinSuccessArgs): void {
  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(thread.id),
    thread,
  );
  updateThreadPinStateInLists({ queryClient, thread, pinSortKey });
}

export function settleThreadListMembershipMutation({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): void {
  invalidateThreadListMembershipQueries({ queryClient, threadId });
}

export async function beginReorderPinnedThreadTransaction({
  queryClient,
  request,
}: ReorderPinnedThreadTransactionArgs): Promise<PinnedThreadOrderTransaction> {
  await queryClient.cancelQueries({ queryKey: threadsQueryKey() });
  await queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() });
  const previousThreadLists = getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  });
  const previousSidebarNavigation =
    snapshotCachedSidebarNavigation(queryClient);
  applyOptimisticPinnedRootOrder({ queryClient, request });
  return { previousSidebarNavigation, previousThreadLists };
}

export function rollbackReorderPinnedThreadTransaction({
  queryClient,
  transaction,
}: RollbackPinnedThreadOrderTransactionArgs): void {
  if (!transaction) {
    return;
  }
  restoreCachedThreadLists(queryClient, transaction.previousThreadLists);
  restoreCachedSidebarNavigation(
    queryClient,
    transaction.previousSidebarNavigation,
  );
}

export function applyReorderPinnedThreadResult({
  orderedRoots,
  queryClient,
}: PinnedRootResponseArgs): void {
  applyPinnedRootResponseToLists({ orderedRoots, queryClient });
}

export function beginUnarchiveThreadTransaction({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): Promise<ThreadListMutationTransaction> {
  return runOptimisticThreadFieldTransaction({
    applyToLists: removeThreadFromLists,
    patch: { archivedAt: null },
    queryClient,
    threadId,
  });
}

export async function beginArchiveThreadAndChildrenTransaction({
  queryClient,
  threadId,
}: ArchiveThreadAndChildrenTransactionArgs): Promise<ArchiveThreadsTransaction> {
  await queryClient.cancelQueries({ queryKey: threadsQueryKey() });
  await queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() });
  const archivedThreadIds = getCachedLiveThreadIdsMatching({
    matchesThread: (thread) =>
      thread.id === threadId || thread.parentThreadId === threadId,
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
    matchesThread: (thread) =>
      thread.id === threadId || thread.parentThreadId === threadId,
    queryClient,
  });

  return {
    archivedThreadIds,
    previousSidebarNavigation,
    previousThreadLists,
    previousThreads,
  };
}

export function rollbackArchiveThreadsTransaction({
  queryClient,
  transaction,
}: RollbackArchiveThreadsTransactionArgs): void {
  if (!transaction) {
    return;
  }

  restoreCachedThreadLists(queryClient, transaction.previousThreadLists);
  restoreCachedSidebarNavigation(
    queryClient,
    transaction.previousSidebarNavigation,
  );
  for (const snapshot of transaction.previousThreads) {
    queryClient.setQueryData(threadQueryKey(snapshot.id), snapshot.thread);
  }
}

export function settleArchiveThreadsTransaction({
  queryClient,
  response,
  transaction,
}: SettleArchiveThreadsTransactionArgs): void {
  queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
  queryClient.invalidateQueries({ queryKey: sidebarNavigationQueryKey() });
  queryClient.invalidateQueries({ queryKey: threadSearchQueryKeyPrefix() });
  for (const threadId of response?.archivedThreadIds ??
    transaction?.archivedThreadIds ??
    []) {
    queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });
  }
}

export async function beginDeleteThreadTransaction({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): Promise<DeleteThreadTransaction> {
  await queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) });
  await queryClient.cancelQueries({ queryKey: threadsQueryKey() });
  await queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() });
  await queryClient.cancelQueries({ queryKey: projectsQueryKey() });

  const previousThread = queryClient.getQueryData<ThreadWithRuntime>(
    threadQueryKey(threadId),
  );
  const previousThreadLists = getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  });
  const previousSidebarNavigation =
    snapshotCachedSidebarNavigation(queryClient);
  const previousProjects =
    queryClient.getQueryData<ProjectResponse[]>(projectsQueryKey());
  const environmentId = previousThread?.environmentId;

  removeThreadScopedQueries({ queryClient, threadId });
  removeEnvironmentScopedQueries({ environmentId, queryClient });
  removeThreadFromLists(queryClient, threadId);

  return {
    environmentId,
    previousSidebarNavigation,
    previousThread,
    previousThreadLists,
    previousProjects,
  };
}

export function rollbackDeleteThreadTransaction({
  queryClient,
  threadId,
  transaction,
}: RollbackDeleteThreadTransactionArgs): void {
  if (!transaction) {
    return;
  }

  queryClient.setQueryData(
    threadQueryKey(threadId),
    transaction.previousThread,
  );
  restoreCachedThreadLists(queryClient, transaction.previousThreadLists);
  restoreCachedSidebarNavigation(
    queryClient,
    transaction.previousSidebarNavigation,
  );
  queryClient.setQueryData(projectsQueryKey(), transaction.previousProjects);
}

export function settleDeleteThreadTransaction({
  queryClient,
  threadId,
  transaction,
}: SettleDeleteThreadTransactionArgs): void {
  removeThreadScopedQueries({ queryClient, threadId });
  removeEnvironmentScopedQueries({
    environmentId: transaction?.environmentId,
    queryClient,
  });
  invalidateThreadDeleteQueries({ queryClient });
}

export function applyThreadReadStateResult({
  queryClient,
  thread,
}: ThreadRuntimeCacheArgs): void {
  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(thread.id),
    thread,
  );
  updateThreadInLists({ queryClient, thread });
}
