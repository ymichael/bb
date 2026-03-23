import type { ThreadEvent, ThreadEventFileChange } from "@bb/domain";
import { itemStatusToFileEditStatus } from "./exec-lifecycle.js";
import type { UIFileEditChange, UIFileEditMessage } from "@bb/domain";

export function mapFileChanges(changes: ThreadEventFileChange[]): UIFileEditChange[] {
  return changes.map((change) => ({
    path: change.path,
    kind: change.kind,
    movePath: change.movePath ?? null,
    diff: change.diff,
  }));
}

export interface FileEditPartial extends Partial<UIFileEditMessage> {
  callId: string;
  appendStdout?: boolean;
}

export function parseFileEditFromItemEvent(
  decoded: ThreadEvent,
): FileEditPartial | null {
  if (decoded.type === "item/fileChange/outputDelta") {
    const callId = decoded.itemId;
    if (!callId) return null;

    return {
      callId,
      stdout: decoded.delta,
      appendStdout: true,
      status: "pending",
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
    status: itemStatusToFileEditStatus(decoded.item.status) ?? defaultStatus,
  };
}
