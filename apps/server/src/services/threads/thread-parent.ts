import { getThread } from "@bb/db";
import type { Thread } from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";

export type ManagerParentThread = Pick<
  Thread,
  "archivedAt" | "deletedAt" | "id" | "projectId" | "type"
>;

export interface IsLiveManagerParentThreadArgs {
  parentThread: ManagerParentThread | null;
  projectId: string;
}

export interface AssertValidManagerParentThreadArgs {
  parentThreadId: string;
  projectId: string;
}

const INVALID_MANAGER_PARENT_THREAD_MESSAGE =
  "parentThreadId must reference a live manager thread in the same project";

export function isLiveManagerParentThread(
  args: IsLiveManagerParentThreadArgs,
): boolean {
  return (
    args.parentThread !== null &&
    args.parentThread.projectId === args.projectId &&
    args.parentThread.type === "manager" &&
    args.parentThread.archivedAt === null &&
    args.parentThread.deletedAt === null
  );
}

export function assertValidManagerParentThread(
  deps: Pick<AppDeps, "db">,
  args: AssertValidManagerParentThreadArgs,
): Thread {
  const parentThread = getThread(deps.db, args.parentThreadId);
  if (parentThread === null) {
    throw new ApiError(
      400,
      "invalid_request",
      INVALID_MANAGER_PARENT_THREAD_MESSAGE,
    );
  }
  const liveParentThread: Thread = parentThread;

  if (
    !isLiveManagerParentThread({
      parentThread: liveParentThread,
      projectId: args.projectId,
    })
  ) {
    throw new ApiError(400, "invalid_request", INVALID_MANAGER_PARENT_THREAD_MESSAGE);
  }

  return liveParentThread;
}
