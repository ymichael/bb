import type { ThreadEvent } from "@bb/domain";
import type {
  BuildEventProjectionMessagesOptions,
  EventProjectionMessage,
  EventProjectionTurnStatus,
} from "./event-projection-types.js";
import {
  flushBufferedAssistantMessages,
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
  type CompactionTurnFinalizationStatus,
  type OperationProjectionState,
} from "./operation-projection.js";
import {
  createReasoningProjectionState,
  finalizeOpenReasoningLifecycles,
  type ReasoningProjectionState,
} from "./reasoning-lifecycle-projection.js";
import { shouldPreservePendingMessages } from "./user-message-parsing.js";

export interface CompactionTurnFinalization {
  status: CompactionTurnFinalizationStatus;
  detail: string | undefined;
}

type TurnPendingFinalizationStatus = Extract<
  EventProjectionTurnStatus,
  "interrupted"
>;
type TurnCompletedStatus = Extract<
  ThreadEvent,
  { type: "turn/completed" }
>["status"];

interface CompleteTurnArgs {
  state: ProjectionState;
  status: TurnCompletedStatus;
  turnId: string;
}

interface FinalizeProjectionMessagesArgs {
  options: BuildEventProjectionMessagesOptions | undefined;
  state: ProjectionState;
}

export interface ProjectionState
  extends AssistantStreamProjectionState,
    OperationProjectionState,
    ReasoningProjectionState {
  seenUserKeys: Set<string>;
  openTurnIds: Set<string>;
  closedTurnIds: Set<string>;
  pendingFinalizationByTurnId: Map<string, TurnPendingFinalizationStatus>;
  delegationParentToolCallIdsByProviderThreadId: Map<string, string>;
}

export interface CreateProjectionStateArgs {
  /**
   * Snapshot time used for live-duration computations on pending tools.
   * Pass the request time when serving a timeline (so a silent pending
   * tool reports `now - startedAt`). Tests pass a fixed value for
   * determinism.
   */
  nowMs: number;
}

export function createProjectionState(
  args: CreateProjectionStateArgs,
): ProjectionState {
  const messages: EventProjectionMessage[] = [];
  return {
    ...createOperationProjectionState(messages),
    seenUserKeys: new Set(),
    openTurnIds: new Set(),
    closedTurnIds: new Set(),
    pendingFinalizationByTurnId: new Map(),
    openAssistantMessagesByKey: new Map(),
    assistantTextBuffersByKey: new Map(),
    visibleAssistantMessageKeys: new Set(),
    finalizedAssistantMessageKeys: new Set(),
    ...createReasoningProjectionState(),
    delegationParentToolCallIdsByProviderThreadId: new Map(),
    toolActivity: createToolActivityState({ nowMs: args.nowMs }),
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
    args.state.pendingFinalizationByTurnId.set(args.turnId, "interrupted");
  }
  finalizeOpenReasoningLifecycles(args.state);
}

export function onThreadInterrupted(state: ProjectionState): void {
  closeOpenTurns(state);
  finalizeOpenReasoningLifecycles(state);
}

export function flushProjectionBufferedOutputs(state: ProjectionState): void {
  flushBufferedAssistantMessages(state);
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
  interruptPendingToolActivity(args.state);

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
    finalizeOperationMessage(message, args.options);
  }

  flushActiveToolCell(args.state);
}

function isMessageScopedToFinalizedTurn(
  message: EventProjectionMessage,
  pendingFinalizationByTurnId: ReadonlyMap<
    string,
    TurnPendingFinalizationStatus
  >,
): boolean {
  return (
    message.scope.kind === "turn" &&
    pendingFinalizationByTurnId.has(message.scope.turnId)
  );
}

function finalizePendingMessageForInterruptedTurn(
  message: EventProjectionMessage,
): void {
  switch (message.kind) {
    case "command":
    case "tool-call":
    case "web-search":
    case "web-fetch":
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
        message.title = "Permission grant interrupted";
      }
      return;
    case "assistant-text":
    case "debug/raw-event":
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

  interruptPendingToolActivity(state, {
    turnIds: new Set(state.pendingFinalizationByTurnId.keys()),
  });

  for (const message of state.messages) {
    if (
      !isMessageScopedToFinalizedTurn(
        message,
        state.pendingFinalizationByTurnId,
      )
    ) {
      continue;
    }
    finalizePendingMessageForInterruptedTurn(message);
  }
}

export function finalizeProjectionState(
  args: FinalizeProjectionMessagesArgs,
): void {
  finalizePendingMessages(args);
  finalizeInterruptedTurnPendingMessages(args.state);
}
