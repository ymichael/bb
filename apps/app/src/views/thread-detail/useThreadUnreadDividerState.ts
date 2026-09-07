import { useEffect, useRef, useState } from "react";
import type { ThreadTimelineUnreadDividerPlacement } from "@/components/thread/timeline";

interface ThreadUnreadDividerThreadState {
  id: string;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

interface ThreadUnreadDividerSnapshot {
  attentionAt: number;
  autoScroll: boolean;
  placement: ThreadTimelineUnreadDividerPlacement | null;
  threadId: string;
}

interface ThreadUnreadDividerState {
  autoScroll: boolean;
  placement: ThreadTimelineUnreadDividerPlacement | null;
}

interface ShouldTrackThreadUnreadDividerArgs {
  routeThreadId: string | undefined;
  threadId: string | undefined;
}

interface IsThreadUnreadArgs {
  lastReadAt: number | null | undefined;
  latestAttentionAt: number | undefined;
}

interface UseThreadUnreadDividerStateArgs {
  routeThreadId: string | undefined;
  thread: ThreadUnreadDividerThreadState | undefined;
}

const NO_UNREAD_DIVIDER_STATE: ThreadUnreadDividerState = {
  autoScroll: false,
  placement: null,
};

function shouldTrackThreadUnreadDivider({
  routeThreadId,
  threadId,
}: ShouldTrackThreadUnreadDividerArgs): boolean {
  if (threadId === undefined || routeThreadId !== threadId) {
    return false;
  }

  return true;
}

function isThreadUnread({
  lastReadAt,
  latestAttentionAt,
}: IsThreadUnreadArgs): boolean {
  if (lastReadAt === undefined || latestAttentionAt === undefined) {
    return false;
  }
  return lastReadAt === null || lastReadAt < latestAttentionAt;
}

function buildUnreadDividerPlacement(
  thread: ThreadUnreadDividerThreadState,
): ThreadTimelineUnreadDividerPlacement | null {
  if (thread.lastReadAt === null) {
    return { kind: "before-first" };
  }
  if (thread.lastReadAt < thread.latestAttentionAt) {
    return { kind: "after-cutoff", cutoffAt: thread.lastReadAt };
  }
  return null;
}

export function useThreadUnreadDividerState({
  routeThreadId,
  thread,
}: UseThreadUnreadDividerStateArgs): ThreadUnreadDividerState {
  const [snapshot, setSnapshot] = useState<ThreadUnreadDividerSnapshot | null>(
    null,
  );
  const trackedThreadIdRef = useRef<string | null>(null);
  const threadId = thread?.id;
  const threadLastReadAt = thread?.lastReadAt;
  const threadLatestAttentionAt = thread?.latestAttentionAt;

  useEffect(() => {
    if (
      threadId === undefined ||
      threadLastReadAt === undefined ||
      threadLatestAttentionAt === undefined ||
      !shouldTrackThreadUnreadDivider({
        routeThreadId,
        threadId,
      })
    ) {
      trackedThreadIdRef.current = null;
      setSnapshot(null);
      return;
    }

    const isFirstTrackedThreadState = trackedThreadIdRef.current !== threadId;
    trackedThreadIdRef.current = threadId;
    const threadState: ThreadUnreadDividerThreadState = {
      id: threadId,
      lastReadAt: threadLastReadAt,
      latestAttentionAt: threadLatestAttentionAt,
    };

    setSnapshot((currentSnapshot) => {
      if (
        currentSnapshot?.threadId === threadId &&
        currentSnapshot.attentionAt === threadLatestAttentionAt
      ) {
        if (threadLastReadAt === null) {
          const autoScroll =
            currentSnapshot.placement !== null && currentSnapshot.autoScroll;
          return {
            attentionAt: threadLatestAttentionAt,
            autoScroll,
            placement: { kind: "before-first" },
            threadId,
          };
        }
        return currentSnapshot;
      }

      const placement = buildUnreadDividerPlacement(threadState);
      return {
        attentionAt: threadLatestAttentionAt,
        autoScroll: isFirstTrackedThreadState && placement !== null,
        placement,
        threadId,
      };
    });
  }, [routeThreadId, threadId, threadLastReadAt, threadLatestAttentionAt]);

  if (
    !shouldTrackThreadUnreadDivider({
      routeThreadId,
      threadId,
    }) ||
    snapshot === null ||
    snapshot.threadId !== threadId ||
    (snapshot.attentionAt !== threadLatestAttentionAt &&
      !isThreadUnread({
        lastReadAt: threadLastReadAt,
        latestAttentionAt: threadLatestAttentionAt,
      }))
  ) {
    return NO_UNREAD_DIVIDER_STATE;
  }

  return {
    autoScroll: snapshot.autoScroll && snapshot.placement !== null,
    placement: snapshot.placement,
  };
}
