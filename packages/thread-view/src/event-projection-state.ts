import type { ThreadEvent } from "@bb/domain";
import type {
  BuildEventProjectionMessagesOptions,
  EventProjectionMessage,
  EventProjectionTurnStatus,
} from "./event-projection-types.js";
import {
  flushBufferedAssistantMessages,
  flushBufferedAssistantMessagesForTurn,
  type AssistantStreamProjectionState,
} from "./assistant-stream-projection.js";
import {
  finalizeOperationMessage,
  interruptOperationMessage,
} from "./parse-operation-message.js";
import {
  flushActiveToolCell,
  flushPendingToolActivityOutput,
  interruptPendingToolActivity,
} from "./tool-activity-projection.js";
import { createToolActivityState } from "./tool-activity-projection.js";
import {
  createOperationProjectionState,
  flushPendingFileEditOutput,
  interruptOpenCompactions,
  type CompactionTurnFinalizationStatus,
  type OperationProjectionState,
} from "./operation-projection.js";
import type { EventMeta } from "./event-decode.js";
import {
  createReasoningProjectionState,
  finalizeOpenReasoningLifecycles,
  finalizeOpenReasoningLifecyclesForTurn,
  type ReasoningProjectionState,
} from "./reasoning-lifecycle-projection.js";
import { shouldPreservePendingMessages } from "./user-message-parsing.js";
import type { BackgroundTaskProjectionState } from "./background-task-projection.js";

export interface CompactionTurnFinalization {
  status: CompactionTurnFinalizationStatus;
  detail: string | undefined;
}

type TurnPendingFinalizationStatus = Extract<
  EventProjectionTurnStatus,
  "interrupted"
>;
interface TurnPendingFinalization {
  completedAt: number;
  status: TurnPendingFinalizationStatus;
}
export interface PendingDelegationTurnLink {
  callId: string;
  parentTurnId: string;
}
type TurnCompletedStatus = Extract<
  ThreadEvent,
  { type: "turn/completed" }
>["status"];

interface CompleteTurnArgs {
  meta: EventMeta;
  state: ProjectionState;
  status: TurnCompletedStatus;
  turnId: string;
}

interface FinalizeProjectionMessagesArgs {
  options: BuildEventProjectionMessagesOptions | undefined;
  state: ProjectionState;
}

interface ThreadInterruptedArgs {
  meta: EventMeta;
  state: ProjectionState;
  threadId: string;
}

export interface ProjectionState
  extends
    AssistantStreamProjectionState,
    OperationProjectionState,
    ReasoningProjectionState,
    BackgroundTaskProjectionState {
  seenUserKeys: Set<string>;
  openTurnIds: Set<string>;
  closedTurnIds: Set<string>;
  pendingFinalizationByTurnId: Map<string, TurnPendingFinalization>;
  threadInterruptedAt: number | null;
  delegationParentToolCallIdsByProviderThreadId: Map<string, string>;
  delegationParentToolCallIdsByTurnId: Map<string, string>;
  delegationTurnIdsByCallId: Map<string, string>;
  suppressedAcceptedRootParentToolCallIdsByTurnId: Map<string, string>;
  pendingDelegationTurnLinksByProviderThreadId: Map<
    string,
    PendingDelegationTurnLink[]
  >;
  delegatedTurnLinkCallIds: Set<string>;
}

export function createProjectionState(): ProjectionState {
  const messages: EventProjectionMessage[] = [];
  return {
    ...createOperationProjectionState(messages),
    seenUserKeys: new Set(),
    openTurnIds: new Set(),
    closedTurnIds: new Set(),
    pendingFinalizationByTurnId: new Map(),
    threadInterruptedAt: null,
    openAssistantMessagesByKey: new Map(),
    assistantTextBuffersByKey: new Map(),
    visibleAssistantMessageKeys: new Set(),
    finalizedAssistantMessageKeys: new Set(),
    ...createReasoningProjectionState(),
    delegationParentToolCallIdsByProviderThreadId: new Map(),
    delegationParentToolCallIdsByTurnId: new Map(),
    delegationTurnIdsByCallId: new Map(),
    suppressedAcceptedRootParentToolCallIdsByTurnId: new Map(),
    pendingDelegationTurnLinksByProviderThreadId: new Map(),
    delegatedTurnLinkCallIds: new Set(),
    toolActivity: createToolActivityState(),
    backgroundTasksByItemId: new Map(),
  };
}

function closeOpenTurns(state: ProjectionState): void {
  for (const turnId of state.openTurnIds) {
    state.closedTurnIds.add(turnId);
  }
  state.openTurnIds.clear();
}

export function onTurnStarted(state: ProjectionState, turnId: string): void {
  state.openTurnIds.add(turnId);
}

export function onTurnCompleted(args: CompleteTurnArgs): void {
  args.state.closedTurnIds.add(args.turnId);
  args.state.openTurnIds.delete(args.turnId);
  if (args.status === "interrupted") {
    args.state.pendingFinalizationByTurnId.set(args.turnId, {
      completedAt: args.meta.createdAt,
      status: "interrupted",
    });
  }
  finalizeOpenReasoningLifecyclesForTurn({
    meta: args.meta,
    state: args.state,
    status: args.status === "completed" ? "completed" : "interrupted",
    turnId: args.turnId,
  });
}

export function onThreadInterrupted(args: ThreadInterruptedArgs): void {
  args.state.threadInterruptedAt = args.meta.createdAt;
  interruptOpenCompactions({
    state: args.state,
    meta: args.meta,
    threadId: args.threadId,
  });
  for (const turnId of args.state.openTurnIds) {
    args.state.pendingFinalizationByTurnId.set(turnId, {
      completedAt: args.meta.createdAt,
      status: "interrupted",
    });
  }
  closeOpenTurns(args.state);
  finalizeOpenReasoningLifecycles({
    meta: args.meta,
    state: args.state,
    status: "interrupted",
  });
}

export function flushProjectionBufferedOutputs(state: ProjectionState): void {
  flushBufferedAssistantMessages(state);
  flushPendingToolActivityOutput(state);
  flushPendingFileEditOutput(state);
}

export function flushProjectionBufferedOutputsAfterTurnCompleted(
  state: ProjectionState,
  turnId: string,
): void {
  flushBufferedAssistantMessagesForTurn(state, turnId);
  flushPendingToolActivityOutput(state);
  flushPendingFileEditOutput(state);
}

function finalizePendingMessages(args: FinalizeProjectionMessagesArgs): void {
  const shouldPreservePending = shouldPreservePendingMessages(
    args.options?.threadStatus,
  );
  const shouldFinalizeBufferedAssistants =
    args.options?.threadStatus !== undefined && !shouldPreservePending;
  if (shouldPreservePending) {
    flushActiveToolCell(args.state);
    return;
  }

  flushPendingToolActivityOutput(args.state);
  flushPendingFileEditOutput(args.state);
  interruptPendingToolActivity(args.state, {
    completedAt: args.state.threadInterruptedAt,
  });

  for (const fileEdits of args.state.fileEditsByCallId.values()) {
    for (const fileEdit of fileEdits) {
      if (fileEdit.status === "pending") {
        fileEdit.status = "interrupted";
      }
    }
  }

  if (shouldFinalizeBufferedAssistants) {
    flushBufferedAssistantMessages(args.state);
  }

  for (const message of args.state.messages) {
    if (message.kind !== "operation") continue;
    if (
      args.options?.threadStatus === "idle" &&
      message.opType === "compaction" &&
      message.scope.kind === "turn" &&
      args.state.closedTurnIds.has(message.scope.turnId)
    ) {
      continue;
    }
    finalizeOperationMessage(message, args.options);
  }

  flushActiveToolCell(args.state);
}

function getMessageTurnFinalization(
  message: EventProjectionMessage,
  pendingFinalizationByTurnId: ReadonlyMap<string, TurnPendingFinalization>,
): TurnPendingFinalization | null {
  if (message.scope.kind !== "turn") {
    return null;
  }
  return pendingFinalizationByTurnId.get(message.scope.turnId) ?? null;
}

function finalizePendingMessageForInterruptedTurn(
  message: EventProjectionMessage,
  finalization: TurnPendingFinalization,
): void {
  if (finalization.status !== "interrupted") {
    return;
  }

  switch (message.kind) {
    case "command":
    case "tool-call":
    case "web-search":
    case "web-fetch":
    case "image-view":
      return;
    case "file-edit":
      if (message.status === "pending") {
        message.status = "interrupted";
      }
      return;
    case "operation":
      interruptOperationMessage(message);
      return;
    case "permission-grant-lifecycle":
      if (message.status === "pending") {
        message.status = "interrupted";
        message.lifecycle = "interrupted";
      }
      return;
    case "user-question-lifecycle":
      if (message.status === "pending") {
        message.status = "interrupted";
        message.lifecycle = "interrupted";
      }
      return;
    case "assistant-text":
    case "delegation":
    case "error":
    case "user":
      return;
  }
}

function finalizeInterruptedTurnPendingMessages(state: ProjectionState): void {
  if (state.pendingFinalizationByTurnId.size === 0) {
    return;
  }

  for (const [turnId, finalization] of state.pendingFinalizationByTurnId) {
    interruptPendingToolActivity(state, {
      completedAt: finalization.completedAt,
      turnIds: new Set([turnId]),
    });
  }

  for (const message of state.messages) {
    const finalization = getMessageTurnFinalization(
      message,
      state.pendingFinalizationByTurnId,
    );
    if (!finalization) {
      continue;
    }
    finalizePendingMessageForInterruptedTurn(message, finalization);
  }
}

export function finalizeProjectionState(
  args: FinalizeProjectionMessagesArgs,
): void {
  finalizeInterruptedTurnPendingMessages(args.state);
  finalizePendingMessages(args);
}
