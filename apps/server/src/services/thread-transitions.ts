import { transitionThreadStatus } from "@bb/db";
import type { DbConnection } from "@bb/db";
import type { ThreadStatus } from "@bb/domain";
import type { NotificationHub } from "../ws/hub.js";

export function tryTransition(
  db: DbConnection,
  hub: NotificationHub,
  threadId: string,
  targetStatus: ThreadStatus,
): boolean {
  try {
    transitionThreadStatus(db, hub, threadId, targetStatus);
    return true;
  } catch {
    return false;
  }
}
