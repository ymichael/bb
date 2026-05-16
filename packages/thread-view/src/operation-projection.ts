import type {
  EventProjectionApprovalLifecycleStatus,
  EventProjectionFileEditChange,
  EventProjectionFileEditMessage,
  EventProjectionMessage,
  EventProjectionOperationMessage,
  EventProjectionPermissionGrantLifecycleMessage,
  EventProjectionUserQuestionLifecycleMessage,
} from "./event-projection-types.js";
import type { CompactionLifecycleEvent } from "./compaction-lifecycle.js";
import type { EventMeta } from "./event-decode.js";
import type { FileEditPartial } from "./file-edit-parsing.js";
import { messageId } from "./format-helpers.js";
import {
  mergeProvisioningMetadata,
  provisioningKey,
  provisioningTitleForStatus,
} from "./provisioning-helpers.js";
import {
  applyApprovalStatusDelta,
  buildApprovalStatusDelta,
} from "./tool-activity-projection.js";
import {
  haveCompatibleEventProjectionMessageScope,
  eventProjectionMessageThreadScopeFields,
  eventProjectionMessageTurnScopeFields,
} from "./message-scope.js";
import {
  appendVisibleTextBuffer,
  createVisibleTextBuffer,
  flushVisibleTextBuffer,
  getVisibleTextBufferText,
  setVisibleTextBuffer,
  type VisibleTextBuffer,
} from "./visible-text-buffer.js";

export interface OperationProjectionState {
  messages: EventProjectionMessage[];
  fileEditsByCallId: Map<string, EventProjectionFileEditMessage[]>;
  fileEditStdoutBuffersByCallId: Map<string, VisibleTextBuffer>;
  openCompactionsByKey: Map<string, EventProjectionOperationMessage>;
  finalizedCompactionKeys: Set<string>;
  provisioningOperationsByKey: Map<string, EventProjectionOperationMessage>;
  permissionGrantsByInteractionId: Map<
    string,
    EventProjectionPermissionGrantLifecycleMessage
  >;
  userQuestionsByInteractionId: Map<
    string,
    EventProjectionUserQuestionLifecycleMessage
  >;
  threadOperationsById: Map<string, EventProjectionOperationMessage>;
}

export function createOperationProjectionState(
  messages: EventProjectionMessage[],
): OperationProjectionState {
  return {
    messages,
    openCompactionsByKey: new Map(),
    finalizedCompactionKeys: new Set(),
    provisioningOperationsByKey: new Map(),
    permissionGrantsByInteractionId: new Map(),
    userQuestionsByInteractionId: new Map(),
    threadOperationsById: new Map(),
    fileEditsByCallId: new Map(),
    fileEditStdoutBuffersByCallId: new Map(),
  };
}

export type CompactionTurnFinalizationStatus = Extract<
  EventProjectionOperationMessage["status"],
  "error" | "interrupted"
>;

interface FinalizeOpenCompactionsForTurnArgs {
  state: OperationProjectionState;
  meta: EventMeta;
  threadId: string;
  turnId: string | undefined;
  status: CompactionTurnFinalizationStatus;
  detail: string | undefined;
}

type LifecycleStatus = Extract<
  EventProjectionOperationMessage["status"],
  "pending" | "completed" | "error" | "interrupted"
>;

type LifecycleEventProjectionMessage =
  | EventProjectionOperationMessage
  | EventProjectionPermissionGrantLifecycleMessage
  | EventProjectionUserQuestionLifecycleMessage;
type EventProjectionMessageScopeFields = ReturnType<
  | typeof eventProjectionMessageThreadScopeFields
  | typeof eventProjectionMessageTurnScopeFields
>;

interface OperationDetailMergeArgs {
  existing: string | undefined;
  incoming: string | undefined;
}

interface UpsertKeyedLifecycleMessageArgs<
  TMessage extends LifecycleEventProjectionMessage,
> {
  index: Map<string, TMessage>;
  incoming: TMessage;
  key: string | null | undefined;
  mergeExisting: (existing: TMessage, incoming: TMessage) => void;
  state: OperationProjectionState;
}

function isTerminalLifecycleStatus(status: LifecycleStatus): boolean {
  return status !== "pending";
}

function mergeLifecycleStatus(
  existing: LifecycleStatus,
  incoming: LifecycleStatus,
): LifecycleStatus {
  if (isTerminalLifecycleStatus(existing)) {
    return existing;
  }
  return incoming;
}

function mergeOperationDetail(
  args: OperationDetailMergeArgs,
): string | undefined {
  const details = [args.existing, args.incoming].filter(
    (value): value is string => Boolean(value),
  );
  if (details.length === 0) {
    return undefined;
  }
  return [...new Set(details)].join("\n");
}

function upsertKeyedLifecycleMessage<
  TMessage extends LifecycleEventProjectionMessage,
>(args: UpsertKeyedLifecycleMessageArgs<TMessage>): void {
  if (!args.key) {
    args.state.messages.push(args.incoming);
    return;
  }

  const scopedKey = lifecycleMessageKey(args.key, args.incoming);
  const existing = args.index.get(scopedKey);
  if (!existing) {
    args.index.set(scopedKey, args.incoming);
    args.state.messages.push(args.incoming);
    return;
  }

  updateMessageBounds(existing, args.incoming);
  args.mergeExisting(existing, args.incoming);
}

function lifecycleMessageKey(
  key: string,
  message: LifecycleEventProjectionMessage,
): string {
  if (message.scope.kind === "thread") {
    return `thread:${key}`;
  }
  return `turn:${message.scope.turnId}:${key}`;
}

function mergeProvisioningOperation(
  existing: EventProjectionOperationMessage,
  incoming: EventProjectionOperationMessage,
): void {
  const wasPending = (existing.status ?? "pending") === "pending";
  existing.status = mergeLifecycleStatus(
    existing.status ?? "pending",
    incoming.status ?? "pending",
  );
  existing.title = provisioningTitleForStatus(existing.status);
  if (wasPending && existing.status !== "pending") {
    existing.completedAt = incoming.completedAt ?? incoming.createdAt;
  }
  existing.provisioning = mergeProvisioningMetadata(
    existing.provisioning,
    incoming.provisioning,
  );
  existing.detail = mergeOperationDetail({
    existing: existing.detail,
    incoming: incoming.detail,
  });
}

export function upsertProvisioningOperation(
  state: OperationProjectionState,
  incoming: EventProjectionOperationMessage,
): void {
  upsertKeyedLifecycleMessage({
    index: state.provisioningOperationsByKey,
    incoming,
    key: provisioningKey(incoming),
    mergeExisting: mergeProvisioningOperation,
    state,
  });
}

function updateMessageBounds(
  existing: LifecycleEventProjectionMessage,
  incoming: LifecycleEventProjectionMessage,
): void {
  if (!haveCompatibleEventProjectionMessageScope(existing, incoming)) {
    throw new Error(
      `Cannot merge ${existing.kind} messages with different scopes`,
    );
  }
  existing.sourceSeqStart = Math.min(
    existing.sourceSeqStart,
    incoming.sourceSeqStart,
  );
  existing.sourceSeqEnd = Math.max(
    existing.sourceSeqEnd,
    incoming.sourceSeqEnd,
  );
  existing.createdAt = Math.max(existing.createdAt, incoming.createdAt);
  existing.startedAt = Math.min(
    existing.startedAt ?? existing.createdAt,
    incoming.startedAt ?? incoming.createdAt,
  );
}

export function upsertThreadOperationMessage(
  state: OperationProjectionState,
  incoming: EventProjectionOperationMessage,
): void {
  upsertKeyedLifecycleMessage({
    index: state.threadOperationsById,
    incoming,
    key: incoming.threadOperation?.operationId,
    mergeExisting: mergeThreadOperationMessage,
    state,
  });
}

function mergeThreadOperationMessage(
  existing: EventProjectionOperationMessage,
  incoming: EventProjectionOperationMessage,
): void {
  const mergedStatus = mergeLifecycleStatus(
    existing.status ?? "pending",
    incoming.status ?? "pending",
  );
  const shouldUseIncomingLifecycle = existing.status !== mergedStatus;
  existing.status = mergedStatus;
  if (shouldUseIncomingLifecycle) {
    existing.title = incoming.title;
    existing.threadOperation = incoming.threadOperation;
    if (mergedStatus !== "pending") {
      existing.completedAt = incoming.completedAt ?? incoming.createdAt;
    }
  }
  existing.detail = mergeOperationDetail({
    existing: existing.detail,
    incoming: incoming.detail,
  });
}

export function upsertPermissionGrantLifecycleMessage(
  state: OperationProjectionState,
  incoming: EventProjectionPermissionGrantLifecycleMessage,
): void {
  upsertKeyedLifecycleMessage({
    index: state.permissionGrantsByInteractionId,
    incoming,
    key: incoming.interactionId,
    mergeExisting: mergePermissionGrantLifecycleMessage,
    state,
  });
}

export function upsertUserQuestionLifecycleMessage(
  state: OperationProjectionState,
  incoming: EventProjectionUserQuestionLifecycleMessage,
): void {
  upsertKeyedLifecycleMessage({
    index: state.userQuestionsByInteractionId,
    incoming,
    key: incoming.interactionId,
    mergeExisting: mergeUserQuestionLifecycleMessage,
    state,
  });
}

function mergeUserQuestionLifecycleMessage(
  existing: EventProjectionUserQuestionLifecycleMessage,
  incoming: EventProjectionUserQuestionLifecycleMessage,
): void {
  const wasTerminal = isTerminalLifecycleStatus(existing.status);
  const mergedStatus = mergeLifecycleStatus(existing.status, incoming.status);
  existing.status = mergedStatus;
  if (wasTerminal) {
    return;
  }

  existing.lifecycle = incoming.lifecycle;
  existing.questions = incoming.questions;
  existing.answers = incoming.answers;
  existing.statusReason = incoming.statusReason;
}

function mergePermissionGrantLifecycleMessage(
  existing: EventProjectionPermissionGrantLifecycleMessage,
  incoming: EventProjectionPermissionGrantLifecycleMessage,
): void {
  const wasTerminal = isTerminalLifecycleStatus(existing.status);
  const mergedStatus = mergeLifecycleStatus(existing.status, incoming.status);
  existing.status = mergedStatus;
  if (!wasTerminal) {
    existing.lifecycle = incoming.lifecycle;
  }
  existing.approvalTarget = incoming.approvalTarget;
}

function mergeFileChange(
  existing: EventProjectionFileEditChange | undefined,
  incoming: EventProjectionFileEditChange,
): EventProjectionFileEditChange {
  if (!existing) {
    return { ...incoming };
  }

  return {
    path: incoming.path,
    kind: incoming.kind ?? existing.kind,
    movePath: incoming.movePath ?? existing.movePath,
    diff: incoming.diff ?? existing.diff,
  };
}

function fileEditPartialApprovalStatus(
  partial: FileEditPartial,
): EventProjectionApprovalLifecycleStatus | null | undefined {
  return "approvalStatus" in partial ? partial.approvalStatus : undefined;
}

function fileEditPartialChanges(
  partial: FileEditPartial,
): EventProjectionFileEditChange[] | undefined {
  return "changes" in partial ? partial.changes : undefined;
}

function fileEditPartialHasAppendedStdout(partial: FileEditPartial): boolean {
  return "appendStdout" in partial;
}

function fileEditPartialStdout(partial: FileEditPartial): string | undefined {
  return "stdout" in partial ? partial.stdout : undefined;
}

function isTerminalFileEditStatus(
  status: EventProjectionFileEditMessage["status"] | undefined,
): boolean {
  return status !== undefined && status !== "pending";
}

export function flushPendingFileEditOutput(
  state: OperationProjectionState,
): void {
  for (const [callId, fileEdits] of state.fileEditsByCallId.entries()) {
    const buffer = state.fileEditStdoutBuffersByCallId.get(callId);
    if (!buffer || !flushVisibleTextBuffer(buffer)) {
      continue;
    }
    for (const fileEdit of fileEdits) {
      fileEdit.stdout = getVisibleTextBufferText(buffer);
    }
  }
}

interface CreateFileEditMessageArgs {
  callId: string;
  change: EventProjectionFileEditChange | null;
  messageKey: string;
  meta: EventMeta;
  partial: FileEditPartial;
  scopeFields: EventProjectionMessageScopeFields;
  stdout: string | undefined;
  threadId: string;
}

function createFileEditMessage({
  callId,
  change,
  messageKey,
  meta,
  partial,
  scopeFields,
  stdout,
  threadId,
}: CreateFileEditMessageArgs): EventProjectionFileEditMessage {
  return {
    kind: "file-edit",
    id: messageId(threadId, "file-edit", messageKey),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...scopeFields,
    ...(partial.parentToolCallId
      ? { parentToolCallId: partial.parentToolCallId }
      : {}),
    callId,
    changes: change ? [{ ...change }] : [],
    stdout,
    approvalStatus: fileEditPartialApprovalStatus(partial) ?? null,
    status: partial.status,
  };
}

interface FileEditChangeEntry {
  change: EventProjectionFileEditChange;
  identity: string;
  matchKeys: string[];
  messageKey: string;
}

function fileEditChangeIdentity(change: EventProjectionFileEditChange): string {
  return change.movePath ?? change.path;
}

function fileEditChangeMatchKeys(
  change: EventProjectionFileEditChange,
): string[] {
  if (change.movePath && change.movePath !== change.path) {
    return [change.path, change.movePath];
  }
  return [change.path];
}

function fileEditMessageKey(
  callId: string,
  change: EventProjectionFileEditChange | null,
  changeIndex: number,
): string {
  if (!change) {
    return `${callId}:${changeIndex}`;
  }
  return `${callId}:${fileEditChangeIdentity(change)}`;
}

function buildFileEditChangeEntries(
  callId: string,
  changes: readonly EventProjectionFileEditChange[],
): FileEditChangeEntry[] {
  const seenIdentityCounts = new Map<string, number>();
  return changes.map((change) => {
    const identity = fileEditChangeIdentity(change);
    const seenCount = seenIdentityCounts.get(identity) ?? 0;
    seenIdentityCounts.set(identity, seenCount + 1);
    return {
      change,
      identity,
      matchKeys: fileEditChangeMatchKeys(change),
      messageKey:
        seenCount === 0
          ? `${callId}:${identity}`
          : `${callId}:${identity}:${seenCount}`,
    };
  });
}

function groupFileEditRowsByChangeMatchKey(
  rows: readonly EventProjectionFileEditMessage[],
): Map<string, EventProjectionFileEditMessage[]> {
  const grouped = new Map<string, EventProjectionFileEditMessage[]>();
  for (const row of rows) {
    const change = row.changes[0];
    if (!change) {
      continue;
    }
    for (const matchKey of fileEditChangeMatchKeys(change)) {
      const rowsForIdentity = grouped.get(matchKey) ?? [];
      rowsForIdentity.push(row);
      grouped.set(matchKey, rowsForIdentity);
    }
  }
  return grouped;
}

interface TakeFileEditRowForChangeEntryArgs {
  entry: FileEditChangeEntry;
  groupedRows: Map<string, EventProjectionFileEditMessage[]>;
  usedRowIds: Set<string>;
}

function takeFileEditRowForChangeEntry({
  entry,
  groupedRows,
  usedRowIds,
}: TakeFileEditRowForChangeEntryArgs):
  | EventProjectionFileEditMessage
  | undefined {
  for (const matchKey of entry.matchKeys) {
    const row = takeUnusedFileEditRowForMatchKey(
      groupedRows,
      matchKey,
      usedRowIds,
    );
    if (row) {
      return row;
    }
  }
  return undefined;
}

function takeUnusedFileEditRowForMatchKey(
  groupedRows: Map<string, EventProjectionFileEditMessage[]>,
  matchKey: string,
  usedRowIds: Set<string>,
): EventProjectionFileEditMessage | undefined {
  const rows = groupedRows.get(matchKey);
  if (!rows || rows.length === 0) {
    return undefined;
  }

  let row: EventProjectionFileEditMessage | undefined;
  while (!row && rows.length > 0) {
    const candidate = rows.shift();
    if (candidate && !usedRowIds.has(candidate.id)) {
      row = candidate;
    }
  }

  if (rows.length === 0) {
    groupedRows.delete(matchKey);
  }
  if (row) {
    usedRowIds.add(row.id);
  }
  return row;
}

function replaceFileEditMessagesForCall(
  state: OperationProjectionState,
  callId: string,
  nextRows: readonly EventProjectionFileEditMessage[],
): void {
  const insertionIndex = state.messages.findIndex(
    (message) => message.kind === "file-edit" && message.callId === callId,
  );
  const messagesWithoutCallRows = state.messages.filter(
    (message) => message.kind !== "file-edit" || message.callId !== callId,
  );
  if (insertionIndex === -1) {
    messagesWithoutCallRows.push(...nextRows);
  } else {
    messagesWithoutCallRows.splice(insertionIndex, 0, ...nextRows);
  }
  state.messages = messagesWithoutCallRows;
}

function updateFileEditMessage(
  existing: EventProjectionFileEditMessage,
  meta: EventMeta,
  partial: FileEditPartial,
  scopeFields: EventProjectionMessageScopeFields,
  change: EventProjectionFileEditChange | null,
  stdout: string | undefined,
): void {
  if (!haveCompatibleEventProjectionMessageScope(existing, scopeFields)) {
    throw new Error(
      `Cannot merge file-edit messages with different scopes for call ${partial.callId}`,
    );
  }
  existing.sourceSeqEnd = meta.seq;
  existing.createdAt = meta.createdAt;

  if (!existing.parentToolCallId && partial.parentToolCallId) {
    existing.parentToolCallId = partial.parentToolCallId;
  }

  if (change) {
    existing.changes = [mergeFileChange(existing.changes[0], change)];
  }

  existing.stdout = stdout;

  existing.approvalStatus = applyApprovalStatusDelta(
    existing.approvalStatus,
    buildApprovalStatusDelta(
      fileEditPartialApprovalStatus(partial),
      partial.status,
    ),
  );

  if (partial.status === "error") {
    existing.status = "error";
  } else if (
    existing.status === "pending" ||
    existing.status === "interrupted"
  ) {
    existing.status = partial.status;
  } else if (existing.status !== "error" && partial.status === "completed") {
    existing.status = "completed";
  }
}

export function upsertFileEdit(
  state: OperationProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  partial: FileEditPartial,
): void {
  const scopeFields = turnId
    ? eventProjectionMessageTurnScopeFields(turnId)
    : eventProjectionMessageThreadScopeFields();
  const existingRows = state.fileEditsByCallId.get(partial.callId) ?? [];
  const stdoutBuffer =
    state.fileEditStdoutBuffersByCallId.get(partial.callId) ??
    createVisibleTextBuffer();
  // Provider stdout is per call, so split file-edit rows for the same call
  // intentionally share one buffer.
  state.fileEditStdoutBuffersByCallId.set(partial.callId, stdoutBuffer);

  const partialStdout = fileEditPartialStdout(partial);
  if (partialStdout) {
    if (fileEditPartialHasAppendedStdout(partial)) {
      appendVisibleTextBuffer(stdoutBuffer, partialStdout);
    } else {
      setVisibleTextBuffer(
        stdoutBuffer,
        partialStdout,
        isTerminalFileEditStatus(partial.status),
      );
    }
  } else if (isTerminalFileEditStatus(partial.status)) {
    flushVisibleTextBuffer(stdoutBuffer);
  }

  const stdout = getVisibleTextBufferText(stdoutBuffer);
  const partialChanges = fileEditPartialChanges(partial);
  if (partialChanges && partialChanges.length > 0) {
    // A later change list is authoritative for the call: rows absent from the
    // new list are dropped so stale split file-edit rows do not linger.
    const existingRowsByMatchKey =
      groupFileEditRowsByChangeMatchKey(existingRows);
    const usedRowIds = new Set<string>();
    const nextRows: EventProjectionFileEditMessage[] = [];
    for (const entry of buildFileEditChangeEntries(
      partial.callId,
      partialChanges,
    )) {
      const existing = takeFileEditRowForChangeEntry({
        entry,
        groupedRows: existingRowsByMatchKey,
        usedRowIds,
      });
      if (existing) {
        updateFileEditMessage(
          existing,
          meta,
          partial,
          scopeFields,
          entry.change,
          stdout,
        );
        nextRows.push(existing);
        continue;
      }

      nextRows.push(
        createFileEditMessage({
          callId: partial.callId,
          change: entry.change,
          messageKey: entry.messageKey,
          meta,
          partial,
          scopeFields,
          stdout,
          threadId,
        }),
      );
    }

    replaceFileEditMessagesForCall(state, partial.callId, nextRows);
    state.fileEditsByCallId.set(partial.callId, nextRows);
    return;
  }

  const changes =
    existingRows.length > 0
        ? existingRows.map(() => null)
        : [null];

  for (const [changeIndex, change] of changes.entries()) {
    const existing = existingRows[changeIndex];
    if (existing) {
      updateFileEditMessage(
        existing,
        meta,
        partial,
        scopeFields,
        change,
        stdout,
      );
      continue;
    }

    const message = createFileEditMessage({
      callId: partial.callId,
      change,
      messageKey: fileEditMessageKey(partial.callId, change, changeIndex),
      meta,
      partial,
      scopeFields,
      stdout,
      threadId,
    });
    existingRows.push(message);
    state.messages.push(message);
  }

  state.fileEditsByCallId.set(partial.callId, existingRows);
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
    existing.title = "Compacting context";
    existing.detail = payload.detail ?? existing.detail;
    return;
  }

  const message: EventProjectionOperationMessage = {
    kind: "operation",
    id: messageId(threadId, "op", `compaction:${payload.key}`),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    completedAt: null,
    ...(turnId
      ? eventProjectionMessageTurnScopeFields(turnId)
      : eventProjectionMessageThreadScopeFields()),
    opType: "compaction",
    title: "Compacting context",
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
    existing.completedAt = meta.createdAt;
    existing.status = "completed";
    existing.title = "Context compacted";
    existing.detail = payload.detail ?? existing.detail;
    state.openCompactionsByKey.delete(payload.key);
    state.finalizedCompactionKeys.add(payload.key);
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
    completedAt: meta.createdAt,
    ...(turnId
      ? eventProjectionMessageTurnScopeFields(turnId)
      : eventProjectionMessageThreadScopeFields()),
    opType: "compaction",
    title: "Context compacted",
    detail: payload.detail,
    status: "completed",
  });
  state.finalizedCompactionKeys.add(payload.key);
}

/**
 * Turn-end finalization is provisional: keep the compaction open so a later
 * explicit compaction completion can override the inferred error/interruption.
 */
export function finalizeOpenCompactionsForTurn(
  args: FinalizeOpenCompactionsForTurnArgs,
): void {
  if (!args.turnId) return;

  for (const message of args.state.openCompactionsByKey.values()) {
    if (
      message.threadId !== args.threadId ||
      message.scope.kind !== "turn" ||
      message.scope.turnId !== args.turnId
    ) {
      continue;
    }

    message.sourceSeqEnd = Math.max(message.sourceSeqEnd, args.meta.seq);
    message.createdAt = Math.max(message.createdAt, args.meta.createdAt);
    message.completedAt = args.meta.createdAt;
    message.status = args.status;
    message.title =
      args.status === "error"
        ? "Context compaction failed"
        : "Context compaction interrupted";
    message.detail = args.detail ?? message.detail;
  }
}
