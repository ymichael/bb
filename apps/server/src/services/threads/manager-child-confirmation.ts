import { countNonDeletedAssignedChildThreads } from "@bb/db";
import type { Thread } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";

export type ManagerChildThreadsDestructiveAction = "archive" | "delete";

export interface RequireManagerChildThreadsConfirmationRequest {
  action: ManagerChildThreadsDestructiveAction;
  confirmed: boolean;
  deps: AppDeps;
  thread: Thread;
}

function managerChildThreadsConfirmationMessage(
  action: ManagerChildThreadsDestructiveAction,
): string {
  const actionLabel = action === "archive" ? "Archiving" : "Deleting";
  return `${actionLabel} this manager requires confirmation because it has non-deleted assigned child threads.`;
}

export function requireManagerChildThreadsConfirmation({
  action,
  confirmed,
  deps,
  thread,
}: RequireManagerChildThreadsConfirmationRequest): void {
  if (thread.type !== "manager" || confirmed) {
    return;
  }

  const nonDeletedAssignedChildCount = countNonDeletedAssignedChildThreads(
    deps.db,
    {
      parentThreadId: thread.id,
    },
  );
  if (nonDeletedAssignedChildCount === 0) {
    return;
  }

  throw new ApiError(
    409,
    "manager_child_threads_confirmation_required",
    managerChildThreadsConfirmationMessage(action),
  );
}
