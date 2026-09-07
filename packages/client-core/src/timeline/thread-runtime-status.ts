import { assertNever } from "@bb/core-ui";
import type { ThreadRuntimeDisplayStatus } from "@bb/domain";

export function isRunningThreadRuntimeDisplayStatus(
  status: ThreadRuntimeDisplayStatus,
): boolean {
  switch (status) {
    case "active":
    case "host-reconnecting":
    case "provisioning":
    case "starting":
    case "stopping":
      return true;
    case "error":
    case "idle":
    // A pending thread has never dispatched: nothing is running until its
    // first attempt clears, so it sorts and filters exactly like idle.
    case "pending":
    case "waiting-for-host":
      return false;
    default:
      return assertNever(status);
  }
}
