import { assertNever } from "@bb/core-ui"
import type { Thread, ThreadStatus } from "@bb/domain"
import { isThreadRead } from "@/lib/thread-read-state"

type ThreadStatusShape = Pick<
  Thread,
  "status" | "lastReadAt" | "latestAttentionAt" | "parentThreadId"
>

export function isRunningThreadStatus(status: ThreadStatus): boolean {
  switch (status) {
    case "active":
    case "created":
    case "provisioning":
      return true
    case "error":
    case "idle":
      return false
    default:
      return assertNever(status)
  }
}

export function isBusyThread(thread: Pick<Thread, "status">): boolean {
  return isRunningThreadStatus(thread.status)
}

export function isUnreadDoneThread(thread: ThreadStatusShape): boolean {
  if (thread.parentThreadId != null) {
    return false
  }

  switch (thread.status) {
    case "error":
    case "idle":
      return !isThreadRead(thread)
    case "active":
    case "created":
    case "provisioning":
      return false
    default:
      return assertNever(thread.status)
  }
}

