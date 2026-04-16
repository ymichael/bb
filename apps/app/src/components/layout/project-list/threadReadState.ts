import type { Thread } from "@bb/domain";
import { isThreadRead } from "@/lib/thread-read-state";

export type ThreadReadToggleAction = "mark_read" | "mark_unread";

export function getThreadReadToggleAction(
  thread: Pick<Thread, "lastReadAt" | "latestAttentionAt">,
): ThreadReadToggleAction {
  return isThreadRead(thread) ? "mark_unread" : "mark_read";
}
