import type { EventMeta } from "./event-decode.js";
import type { ToolActivityProjectionState } from "./tool-activity-projection.js";
import type { WebActivityLifecycleEvent } from "./web-activity-lifecycle.js";
import { messageId } from "./format-helpers.js";
import {
  areThreadEventScopesEqual,
  eventProjectionMessageThreadScopeFields,
  eventProjectionMessageTurnScopeFields,
} from "./message-scope.js";
import {
  findWebActivityInHistoryCells,
  flushActiveToolCell,
  interruptWebActivityMessage,
  isWebActivityMessage,
  type ViewWebActivityMessage,
  type WebActivityKind,
} from "./tool-activity-cells.js";

function buildWebActivityKey(kind: WebActivityKind, callId: string): string {
  return `${kind}:${callId}`;
}

function createWebActivityMessage(
  threadId: string,
  meta: EventMeta,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
  status: ViewWebActivityMessage["status"],
): ViewWebActivityMessage {
  if (payload.itemKind === "web-search") {
    return {
      kind: "web-search",
      id: messageId(threadId, "web-search", payload.callId),
      threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      ...(turnId
        ? eventProjectionMessageTurnScopeFields(turnId)
        : eventProjectionMessageThreadScopeFields()),
      ...(payload.parentToolCallId
        ? { parentToolCallId: payload.parentToolCallId }
        : {}),
      callId: payload.callId,
      queries: payload.queries,
      completedAt: status === "pending" ? null : meta.createdAt,
      status,
    };
  }

  return {
    kind: "web-fetch",
    id: messageId(threadId, "web-fetch", payload.callId),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...(turnId
      ? eventProjectionMessageTurnScopeFields(turnId)
      : eventProjectionMessageThreadScopeFields()),
    ...(payload.parentToolCallId
      ? { parentToolCallId: payload.parentToolCallId }
      : {}),
    callId: payload.callId,
    url: payload.url,
    prompt: payload.prompt,
    pattern: payload.pattern,
    completedAt: status === "pending" ? null : meta.createdAt,
    status,
  };
}

function mergeWebActivityMessage(
  target: ViewWebActivityMessage,
  meta: EventMeta,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
): void {
  const scopeFields = turnId
    ? eventProjectionMessageTurnScopeFields(turnId)
    : eventProjectionMessageThreadScopeFields();
  if (!areThreadEventScopesEqual(target.scope, scopeFields.scope)) {
    throw new Error(
      `Cannot merge ${target.kind} messages with different scopes for call ${payload.callId}`,
    );
  }
  target.sourceSeqEnd = Math.max(target.sourceSeqEnd, meta.seq);
  target.createdAt = Math.max(target.createdAt, meta.createdAt);
  if (!target.parentToolCallId && payload.parentToolCallId) {
    target.parentToolCallId = payload.parentToolCallId;
  }

  if (target.kind === "web-search" && payload.itemKind === "web-search") {
    target.queries = payload.queries;
    return;
  }

  if (target.kind === "web-fetch" && payload.itemKind === "web-fetch") {
    target.url = payload.url;
    target.prompt = payload.prompt;
    target.pattern = payload.pattern;
  }
}

export function onWebActivityBegin(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
): void {
  const activityKey = buildWebActivityKey(payload.itemKind, payload.callId);
  if (state.toolActivity.finalizedWebActivityCallIds.has(activityKey)) {
    return;
  }

  const active = state.toolActivity.activeCell;
  if (
    isWebActivityMessage(active) &&
    active.callId === payload.callId &&
    active.kind !== payload.itemKind
  ) {
    interruptWebActivityMessage(active);
    flushActiveToolCell(state);
  }

  if (
    active &&
    active.kind === payload.itemKind &&
    active.callId === payload.callId
  ) {
    mergeWebActivityMessage(active, meta, turnId, payload);
    return;
  }

  flushActiveToolCell(state);
  state.toolActivity.activeCell = createWebActivityMessage(
    threadId,
    meta,
    turnId,
    payload,
    "pending",
  );
}

export function onWebActivityEnd(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
): void {
  const activityKey = buildWebActivityKey(payload.itemKind, payload.callId);
  if (state.toolActivity.finalizedWebActivityCallIds.has(activityKey)) {
    return;
  }

  const active = state.toolActivity.activeCell;
  if (
    isWebActivityMessage(active) &&
    active.callId === payload.callId &&
    active.kind !== payload.itemKind
  ) {
    interruptWebActivityMessage(active);
    flushActiveToolCell(state);
  }

  if (
    active &&
    active.kind === payload.itemKind &&
    active.callId === payload.callId
  ) {
    mergeWebActivityMessage(active, meta, turnId, payload);
    active.status = "completed";
    active.completedAt = meta.createdAt;
    flushActiveToolCell(state);
    state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
    return;
  }

  flushActiveToolCell(state);

  const conflictingHistoryMatch = findWebActivityInHistoryCells(state, {
    callId: payload.callId,
  });
  if (
    conflictingHistoryMatch &&
    conflictingHistoryMatch.kind !== payload.itemKind
  ) {
    interruptWebActivityMessage(conflictingHistoryMatch);
  }

  const historyMatch = findWebActivityInHistoryCells(state, {
    callId: payload.callId,
    itemKind: payload.itemKind,
  });
  if (historyMatch) {
    mergeWebActivityMessage(historyMatch, meta, turnId, payload);
    historyMatch.status = "completed";
    historyMatch.completedAt = meta.createdAt;
    state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
    return;
  }

  const completedMessage = createWebActivityMessage(
    threadId,
    meta,
    turnId,
    payload,
    "completed",
  );
  completedMessage.id = messageId(
    threadId,
    completedMessage.kind,
    `${payload.callId}:${meta.seq}`,
  );
  state.messages.push(completedMessage);
  state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
}
