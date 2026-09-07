import type { ThreadListEntry } from "@bb/domain";
import { isSidebarProjectThread } from "@bb/client-core";
import { isThreadRead, type ThreadReadState } from "@bb/client-core";

type FaviconSidebarThread = ThreadReadState &
  Pick<
    ThreadListEntry,
    | "hasPendingInteraction"
    | "id"
    | "originKind"
    | "parentThreadId"
    | "visibility"
  >;

interface ShouldShowFaviconAttentionDotArgs {
  currentThreadHasPendingInteraction: boolean;
  currentThreadId?: string | null;
  isThreadView: boolean;
  sidebarThreads: readonly FaviconSidebarThread[];
  thread: ThreadReadState | null | undefined;
}

function isUnreadSidebarThread(thread: FaviconSidebarThread): boolean {
  return isSidebarProjectThread(thread) && !isThreadRead(thread);
}

function isPendingSidebarThread(thread: FaviconSidebarThread): boolean {
  return isSidebarProjectThread(thread) && thread.hasPendingInteraction;
}

function isPendingDelegatedChildOfCurrentThread(
  thread: FaviconSidebarThread,
  currentThreadId: string,
): boolean {
  return (
    thread.parentThreadId === currentThreadId &&
    thread.originKind === null &&
    thread.hasPendingInteraction
  );
}

export function shouldShowFaviconAttentionDot({
  currentThreadHasPendingInteraction,
  currentThreadId,
  isThreadView,
  sidebarThreads,
  thread,
}: ShouldShowFaviconAttentionDotArgs): boolean {
  if (isThreadView) {
    const childNeedsAttention =
      currentThreadId != null &&
      sidebarThreads.some((candidate) =>
        isPendingDelegatedChildOfCurrentThread(candidate, currentThreadId),
      );
    return (
      currentThreadHasPendingInteraction ||
      childNeedsAttention ||
      Boolean(thread && !isThreadRead(thread))
    );
  }

  return sidebarThreads.some(
    (candidate) =>
      isPendingSidebarThread(candidate) || isUnreadSidebarThread(candidate),
  );
}
