import { assertNever } from "@bb/core-ui";
import type {
  Thread,
  ThreadRuntimeDisplayStatus,
  ThreadWithRuntime,
} from "@bb/domain";
import { isThreadRead } from "@/lib/thread-read-state";

type ThreadStatusShape = Pick<
  Thread,
  "status" | "lastReadAt" | "latestAttentionAt" | "parentThreadId"
>;

type ThreadRuntimeShape = Pick<ThreadWithRuntime, "runtime">;

export function isRunningThreadRuntimeDisplayStatus(
  status: ThreadRuntimeDisplayStatus,
): boolean {
  switch (status) {
    case "active":
    case "created":
    case "host-reconnecting":
    case "provisioning":
      return true;
    case "error":
    case "idle":
    case "waiting-for-host":
      return false;
    default:
      return assertNever(status);
  }
}

export function isBusyThread(thread: ThreadRuntimeShape): boolean {
  return isRunningThreadRuntimeDisplayStatus(thread.runtime.displayStatus);
}

export function isUnreadDoneThread(thread: ThreadStatusShape): boolean {
  if (thread.parentThreadId != null) {
    return false;
  }

  switch (thread.status) {
    case "error":
    case "idle":
      return !isThreadRead(thread);
    case "active":
    case "created":
    case "provisioning":
      return false;
    default:
      return assertNever(thread.status);
  }
}
