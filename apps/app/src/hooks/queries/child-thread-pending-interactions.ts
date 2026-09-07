import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";
import type { PendingInteraction } from "@bb/domain";
import { sdk } from "@/lib/sdk";
import { REALTIME_OWNED_NO_FOCUS_QUERY_POLICY } from "./query-policies";
import { threadPendingInteractionsQueryKey } from "./query-keys";
import { getLatestPendingInteraction } from "./thread-queries";

export interface ChildThreadPendingAttentionSource {
  hasPendingInteraction: boolean;
  href: string;
  id: string;
  title: string;
}

export interface ChildThreadPendingAttention {
  childThreadId: string;
  childTitle: string;
  href: string;
  interaction: PendingInteraction;
}

export const EMPTY_CHILD_THREAD_PENDING_ATTENTION: readonly ChildThreadPendingAttention[] =
  Object.freeze([]);

export function collectChildThreadPendingAttention(
  children: readonly ChildThreadPendingAttentionSource[],
  interactionsByThreadId: ReadonlyMap<
    string,
    readonly PendingInteraction[] | undefined
  >,
): readonly ChildThreadPendingAttention[] {
  const items: ChildThreadPendingAttention[] = [];
  for (const child of children) {
    if (!child.hasPendingInteraction) {
      continue;
    }
    const interaction = getLatestPendingInteraction(
      interactionsByThreadId.get(child.id),
    );
    if (!interaction) {
      continue;
    }
    items.push({
      childThreadId: child.id,
      childTitle: child.title,
      href: child.href,
      interaction,
    });
  }
  return items.length === 0 ? EMPTY_CHILD_THREAD_PENDING_ATTENTION : items;
}

const EMPTY_INTERACTION_LISTS: readonly (
  | readonly PendingInteraction[]
  | undefined
)[] = Object.freeze([]);

function combinePendingInteractionLists(
  results: UseQueryResult<readonly PendingInteraction[]>[],
): readonly (readonly PendingInteraction[] | undefined)[] {
  return results.length === 0
    ? EMPTY_INTERACTION_LISTS
    : results.map((result) => result.data);
}

export function useChildThreadPendingAttention(
  children: readonly ChildThreadPendingAttentionSource[],
): readonly ChildThreadPendingAttention[] {
  const pendingChildIds = useMemo(
    () =>
      children
        .filter((child) => child.hasPendingInteraction)
        .map((child) => child.id),
    [children],
  );

  const interactionLists = useQueries({
    queries: pendingChildIds.map((threadId) => ({
      queryKey: threadPendingInteractionsQueryKey(threadId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        sdk.threads.interactions.list({
          threadId,
          signal,
        }),
      enabled: true,
      refetchOnMount: true,
      ...REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
    })),
    combine: combinePendingInteractionLists,
  });

  const interactionsByThreadId = useMemo(() => {
    const next = new Map<string, readonly PendingInteraction[] | undefined>();
    pendingChildIds.forEach((threadId, index) => {
      next.set(threadId, interactionLists[index]);
    });
    return next;
  }, [pendingChildIds, interactionLists]);

  return useMemo(
    () => collectChildThreadPendingAttention(children, interactionsByThreadId),
    [children, interactionsByThreadId],
  );
}
