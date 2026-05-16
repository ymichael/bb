import { useEffect, useState } from "react";
import type { ThreadTimelineUnreadDividerPlacement } from "@/components/thread/timeline";
import type { ThreadType } from "@bb/domain";

interface ManagerUnreadDividerThreadState {
  id: string;
  lastReadAt: number | null;
  latestAttentionAt: number;
  type: ThreadType;
}

interface ManagerUnreadDividerSnapshot {
  attentionAt: number;
  placement: ThreadTimelineUnreadDividerPlacement | null;
  threadId: string;
}

export interface UseManagerUnreadDividerPlacementArgs {
  routeThreadId: string | undefined;
  thread: ManagerUnreadDividerThreadState | undefined;
  useStandardManagerTimeline: boolean;
}

function buildUnreadDividerPlacement(
  thread: ManagerUnreadDividerThreadState,
): ThreadTimelineUnreadDividerPlacement | null {
  if (thread.lastReadAt === null) {
    return { kind: "before-first" };
  }
  if (thread.lastReadAt < thread.latestAttentionAt) {
    return { kind: "after-cutoff", cutoffAt: thread.lastReadAt };
  }
  return null;
}

export function useManagerUnreadDividerPlacement({
  routeThreadId,
  thread,
  useStandardManagerTimeline,
}: UseManagerUnreadDividerPlacementArgs): ThreadTimelineUnreadDividerPlacement | null {
  const [snapshot, setSnapshot] =
    useState<ManagerUnreadDividerSnapshot | null>(null);
  const threadId = thread?.id;
  const threadLastReadAt = thread?.lastReadAt;
  const threadLatestAttentionAt = thread?.latestAttentionAt;
  const threadType = thread?.type;

  useEffect(() => {
    if (
      threadId === undefined ||
      threadLastReadAt === undefined ||
      threadLatestAttentionAt === undefined ||
      threadType === undefined ||
      routeThreadId !== threadId ||
      threadType !== "manager" ||
      useStandardManagerTimeline
    ) {
      setSnapshot(null);
      return;
    }

    const threadState: ManagerUnreadDividerThreadState = {
      id: threadId,
      lastReadAt: threadLastReadAt,
      latestAttentionAt: threadLatestAttentionAt,
      type: threadType,
    };

    setSnapshot((currentSnapshot) => {
      if (
        currentSnapshot?.threadId === threadId &&
        currentSnapshot.attentionAt === threadLatestAttentionAt
      ) {
        if (threadLastReadAt === null) {
          return {
            attentionAt: threadLatestAttentionAt,
            placement: { kind: "before-first" },
            threadId,
          };
        }
        return currentSnapshot;
      }

      return {
        attentionAt: threadLatestAttentionAt,
        placement: buildUnreadDividerPlacement(threadState),
        threadId,
      };
    });
  }, [
    routeThreadId,
    threadId,
    threadLastReadAt,
    threadLatestAttentionAt,
    threadType,
    useStandardManagerTimeline,
  ]);

  if (
    threadId === undefined ||
    routeThreadId !== threadId ||
    threadType !== "manager" ||
    useStandardManagerTimeline ||
    snapshot?.threadId !== threadId ||
    snapshot.attentionAt !== threadLatestAttentionAt
  ) {
    return null;
  }

  return snapshot.placement;
}
