import type { EventMeta } from "./event-decode.js";
import type { ToolActivityProjectionState } from "./tool-activity-projection.js";
import type { WebActivityLifecycleEvent } from "./web-activity-lifecycle.js";
import { itemStatusToExecStatus } from "./exec-lifecycle.js";
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

function settledStatus(
  payload: WebActivityLifecycleEvent,
): ViewWebActivityMessage["status"] {
  switch (payload.itemKind) {
    case "web-search":
    case "web-fetch":
    case "image-view":
      return "completed";
    case "file-read":
    case "search":
    case "plan-steps":
    case "extension": {
      const status = itemStatusToExecStatus(payload.status);
      return status === "pending" ? "completed" : status;
    }
  }
}

function createWebActivityMessage(
  threadId: string,
  meta: EventMeta,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
  status: ViewWebActivityMessage["status"],
): ViewWebActivityMessage {
  const base = {
    id: messageId(threadId, payload.itemKind, payload.callId),
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
    ...(payload.presentation ? { presentation: payload.presentation } : {}),
    callId: payload.callId,
    completedAt: status === "pending" ? null : meta.createdAt,
  };

  switch (payload.itemKind) {
    case "web-search":
      return {
        ...base,
        kind: "web-search",
        queries: payload.queries,
        status: status === "error" ? "completed" : status,
      };
    case "image-view":
      return {
        ...base,
        kind: "image-view",
        path: payload.path,
        status: status === "error" ? "completed" : status,
      };
    case "web-fetch":
      return {
        ...base,
        kind: "web-fetch",
        url: payload.url,
        prompt: payload.prompt,
        pattern: payload.pattern,
        status: status === "error" ? "completed" : status,
      };
    case "file-read":
      return {
        ...base,
        kind: "file-read",
        path: payload.path,
        cmd: payload.cmd,
        status,
      };
    case "search":
      return {
        ...base,
        kind: "search",
        mode: payload.mode,
        query: payload.query,
        path: payload.path,
        cmd: payload.cmd,
        status,
      };
    case "plan-steps":
      return {
        ...base,
        kind: "plan-steps",
        steps: payload.steps,
        explanation: payload.explanation,
        status,
      };
    case "extension":
      return {
        ...base,
        kind: "extension",
        extensionKind: payload.extensionKind,
        payload: payload.payload,
        presentation: payload.presentation,
        status,
      };
  }
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
  if (payload.presentation) {
    target.presentation = payload.presentation;
  }

  if (target.kind === "web-search" && payload.itemKind === "web-search") {
    target.queries = payload.queries;
    return;
  }

  if (target.kind === "web-fetch" && payload.itemKind === "web-fetch") {
    target.url = payload.url;
    target.prompt = payload.prompt;
    target.pattern = payload.pattern;
    return;
  }

  if (target.kind === "image-view" && payload.itemKind === "image-view") {
    target.path = payload.path;
    return;
  }

  if (target.kind === "file-read" && payload.itemKind === "file-read") {
    target.path = payload.path;
    target.cmd = payload.cmd;
    return;
  }

  if (target.kind === "search" && payload.itemKind === "search") {
    target.mode = payload.mode;
    target.query = payload.query;
    target.path = payload.path;
    target.cmd = payload.cmd;
    return;
  }

  if (target.kind === "plan-steps" && payload.itemKind === "plan-steps") {
    target.steps = payload.steps;
    target.explanation = payload.explanation;
    return;
  }

  if (target.kind === "extension" && payload.itemKind === "extension") {
    target.extensionKind = payload.extensionKind;
    target.payload = payload.payload;
    target.presentation = payload.presentation;
  }
}

function settleWebActivityMessage(
  target: ViewWebActivityMessage,
  meta: EventMeta,
  payload: WebActivityLifecycleEvent,
): void {
  const status = settledStatus(payload);
  if (
    target.kind === "web-search" ||
    target.kind === "web-fetch" ||
    target.kind === "image-view"
  ) {
    target.status = status === "error" ? "completed" : status;
  } else {
    target.status = status;
  }
  target.completedAt = meta.createdAt;
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
    interruptWebActivityMessage(active, meta.createdAt);
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
    interruptWebActivityMessage(active, meta.createdAt);
    flushActiveToolCell(state);
  }

  if (
    active &&
    active.kind === payload.itemKind &&
    active.callId === payload.callId
  ) {
    mergeWebActivityMessage(active, meta, turnId, payload);
    settleWebActivityMessage(active, meta, payload);
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
    interruptWebActivityMessage(conflictingHistoryMatch, meta.createdAt);
  }

  const historyMatch = findWebActivityInHistoryCells(state, {
    callId: payload.callId,
    itemKind: payload.itemKind,
  });
  if (historyMatch) {
    mergeWebActivityMessage(historyMatch, meta, turnId, payload);
    settleWebActivityMessage(historyMatch, meta, payload);
    state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
    return;
  }

  const completedMessage = createWebActivityMessage(
    threadId,
    meta,
    turnId,
    payload,
    settledStatus(payload),
  );
  completedMessage.id = messageId(
    threadId,
    completedMessage.kind,
    `${payload.callId}:${meta.seq}`,
  );
  state.messages.push(completedMessage);
  state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
}
