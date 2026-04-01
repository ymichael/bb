import type { Thread } from "@bb/domain";

export type ThreadReadToggleAction = "mark_read" | "mark_unread";

export function getThreadReadToggleAction(
  thread: Pick<Thread, "lastReadAt" | "updatedAt">,
): ThreadReadToggleAction {
  return (thread.lastReadAt ?? 0) >= thread.updatedAt
    ? "mark_unread"
    : "mark_read";
}
