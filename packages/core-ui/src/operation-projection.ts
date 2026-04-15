import type {
  ThreadEvent,
  ViewFileEditChange,
  ViewFileEditMessage,
  ViewMessage,
  ViewOperationMessage,
} from "@bb/domain";
import type { CompactionLifecycleEvent } from "./compaction-lifecycle.js";
import { getEventTurnId } from "./event-decode.js";
import type { EventMeta } from "./event-decode.js";
import type { FileEditPartial } from "./file-edit-parsing.js";
import { messageId } from "./format-helpers.js";
import {
  applyApprovalStatusDelta,
  buildApprovalStatusDelta,
} from "./tool-activity-projection.js";

export interface OperationProjectionState {
  messages: ViewMessage[];
  fileEditsByCallId: Map<string, ViewFileEditMessage>;
  openCompactionsByKey: Map<string, ViewOperationMessage>;
  finalizedCompactionKeys: Set<string>;
  lastCompletedCompactionKeyByThreadId: Map<string, string>;
}

function mergeFileChanges(
  existing: ViewFileEditChange[],
  incoming: ViewFileEditChange[],
): ViewFileEditChange[] {
  const byPath = new Map<string, ViewFileEditChange>();

  for (const change of existing) {
    byPath.set(change.path, { ...change });
  }

  for (const change of incoming) {
    const prev = byPath.get(change.path);
    if (!prev) {
      byPath.set(change.path, { ...change });
      continue;
    }

    byPath.set(change.path, {
      path: change.path,
      kind: change.kind ?? prev.kind,
      movePath: change.movePath ?? prev.movePath,
      diff: change.diff ?? prev.diff,
    });
  }

  return [...byPath.values()];
}

export function upsertFileEdit(
  state: OperationProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  partial: FileEditPartial,
): void {
  const existing = state.fileEditsByCallId.get(partial.callId);

  if (!existing) {
    const message: ViewFileEditMessage = {
      kind: "file-edit",
      id: messageId(threadId, "file-edit", partial.callId),
      threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      ...(turnId ? { turnId } : {}),
      ...(partial.parentToolCallId ? { parentToolCallId: partial.parentToolCallId } : {}),
      callId: partial.callId,
      changes: partial.changes ?? [],
      stdout: partial.stdout,
      stderr: partial.stderr,
      approvalStatus: partial.approvalStatus ?? null,
      status: partial.status ?? "pending",
    };
    state.fileEditsByCallId.set(partial.callId, message);
    state.messages.push(message);
    return;
  }

  existing.sourceSeqEnd = meta.seq;
  existing.createdAt = meta.createdAt;

  if (!existing.turnId && turnId) existing.turnId = turnId;
  if (!existing.parentToolCallId && partial.parentToolCallId) {
    existing.parentToolCallId = partial.parentToolCallId;
  }

  if (partial.changes && partial.changes.length > 0) {
    existing.changes = mergeFileChanges(existing.changes, partial.changes);
  }

  if (partial.stdout) {
    if (partial.appendStdout) {
      existing.stdout = `${existing.stdout ?? ""}${partial.stdout}`;
    } else {
      existing.stdout = partial.stdout;
    }
  }

  if (partial.stderr) {
    existing.stderr = partial.stderr;
  }

  existing.approvalStatus = applyApprovalStatusDelta(
    existing.approvalStatus,
    buildApprovalStatusDelta(partial.approvalStatus, partial.status),
  );

  if (partial.status) {
    if (partial.status === "error") {
      existing.status = "error";
    } else if (existing.status === "pending" || existing.status === "interrupted") {
      existing.status = partial.status;
    } else if (existing.status !== "error" && partial.status === "completed") {
      existing.status = "completed";
    }
  }
}

export function onCompactionBegin(
  state: OperationProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: CompactionLifecycleEvent,
): void {
  if (state.finalizedCompactionKeys.has(payload.key)) {
    return;
  }

  const existing = state.openCompactionsByKey.get(payload.key);
  if (existing) {
    existing.sourceSeqEnd = Math.max(existing.sourceSeqEnd, meta.seq);
    existing.createdAt = Math.max(existing.createdAt, meta.createdAt);
    existing.status = "pending";
    existing.title = "Context compacting...";
    existing.detail = payload.detail ?? existing.detail;
    return;
  }

  const message: ViewOperationMessage = {
    kind: "operation",
    id: messageId(threadId, "op", `compaction:${payload.key}`),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...(turnId ? { turnId } : {}),
    opType: "compaction",
    title: "Context compacting...",
    detail: payload.detail,
    status: "pending",
  };
  state.openCompactionsByKey.set(payload.key, message);
  state.messages.push(message);
}

export function onCompactionEnd(
  state: OperationProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: CompactionLifecycleEvent,
): void {
  const existing = state.openCompactionsByKey.get(payload.key);
  if (existing) {
    existing.sourceSeqEnd = Math.max(existing.sourceSeqEnd, meta.seq);
    existing.createdAt = Math.max(existing.createdAt, meta.createdAt);
    existing.status = "completed";
    existing.title = "Context compacted";
    existing.detail = payload.detail ?? existing.detail;
    state.openCompactionsByKey.delete(payload.key);
    state.finalizedCompactionKeys.add(payload.key);
    state.lastCompletedCompactionKeyByThreadId.set(threadId, payload.key);
    return;
  }

  if (state.finalizedCompactionKeys.has(payload.key)) {
    return;
  }

  state.messages.push({
    kind: "operation",
    id: messageId(threadId, "op", `compaction:${payload.key}`),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...(turnId ? { turnId } : {}),
    opType: "compaction",
    title: "Context compacted",
    detail: payload.detail,
    status: "completed",
  });
  state.finalizedCompactionKeys.add(payload.key);
  state.lastCompletedCompactionKeyByThreadId.set(threadId, payload.key);
}

export function resolveProjectedCompactionEvent(
  state: OperationProjectionState,
  decoded: ThreadEvent,
  payload: CompactionLifecycleEvent,
): CompactionLifecycleEvent {
  if (
    decoded.type === "thread/compacted" &&
    getEventTurnId(decoded) === undefined
  ) {
    if (state.openCompactionsByKey.size === 1) {
      const [onlyOpenKey] = state.openCompactionsByKey.keys();
      if (onlyOpenKey) {
        return {
          ...payload,
          key: onlyOpenKey,
        };
      }
    }
    const lastCompletedKey = state.lastCompletedCompactionKeyByThreadId.get(
      decoded.threadId,
    );
    if (lastCompletedKey) {
      return {
        ...payload,
        key: lastCompletedKey,
      };
    }
  }
  return payload;
}
