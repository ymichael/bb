import type { ThreadEvent, ThreadEventFileChange } from "@bb/domain";
import {
  itemStatusToApprovalStatus,
  itemStatusToFileEditStatus,
} from "./exec-lifecycle.js";
import { getEventParentToolCallId } from "./event-decode.js";
import type { ViewFileEditChange, ViewFileEditMessage } from "@bb/domain";

export function mapFileChanges(changes: ThreadEventFileChange[]): ViewFileEditChange[] {
  return changes.map((change) => ({
    path: change.path,
    kind: change.kind,
    movePath: change.movePath ?? null,
    diff: change.diff,
  }));
}

export interface FileEditPartial extends Partial<ViewFileEditMessage> {
  callId: string;
  appendStdout?: boolean;
  parentToolCallId?: string;
}

export function parseFileEditFromItemEvent(
  decoded: ThreadEvent,
  parentToolCallIdOverride?: string,
): FileEditPartial | null {
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  if (decoded.type === "item/fileChange/outputDelta") {
    const callId = decoded.itemId;
    if (!callId) return null;

    return {
      callId,
      stdout: decoded.delta,
      appendStdout: true,
      status: "pending",
      ...(parentToolCallId ? { parentToolCallId } : {}),
    };
  }

  if (decoded.type !== "item/started" && decoded.type !== "item/completed") {
    return null;
  }
  if (decoded.item.type !== "fileChange") return null;

  const callId = decoded.item.id;
  if (!callId) return null;

  const defaultStatus = decoded.type === "item/completed" ? "completed" : "pending";
  const changes = mapFileChanges(decoded.item.changes);

  return {
    callId,
    changes,
    approvalStatus: itemStatusToApprovalStatus(decoded.item.approvalStatus),
    status: itemStatusToFileEditStatus(decoded.item.status) ?? defaultStatus,
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}
