import type {
  ViewAssistantReasoningMessage,
  ViewAssistantTextMessage,
  ViewMessage,
} from "@bb/domain";
import {
  flushToolActivityBeforeNonToolMessage,
  type ToolActivityProjectionState,
} from "./tool-activity-projection.js";

export interface AssistantStreamProjectionState extends ToolActivityProjectionState {
  messages: ViewMessage[];
  openAssistantByTurn: Map<string, ViewAssistantTextMessage>;
  finalizedAssistantTurnKeys: Set<string>;
  openReasoningByTurn: Map<string, ViewAssistantReasoningMessage>;
  finalizedReasoningTurnKeys: Set<string>;
}

export function hasFinalizedProjectionKey(
  finalizedKeys: Set<string>,
  primaryKey: string,
  fallbackKey: string | undefined,
): boolean {
  return (
    finalizedKeys.has(primaryKey) ||
    (fallbackKey !== undefined && finalizedKeys.has(fallbackKey))
  );
}

export function resolveOpenProjectionKey<TMessage>(
  openMessages: Map<string, TMessage>,
  primaryKey: string,
  fallbackKey: string | undefined,
): string {
  if (
    fallbackKey !== undefined &&
    openMessages.has(fallbackKey) &&
    !openMessages.has(primaryKey)
  ) {
    return fallbackKey;
  }
  return primaryKey;
}

export function finalizeProjectionKeys(
  finalizedKeys: Set<string>,
  keys: Array<string | undefined>,
): void {
  for (const key of keys) {
    if (!key) continue;
    finalizedKeys.add(key);
  }
}

export function flushBufferedAssistantMessages(
  state: AssistantStreamProjectionState,
): void {
  if (state.openAssistantByTurn.size === 0) {
    return;
  }

  const pendingAssistants = Array.from(state.openAssistantByTurn.entries()).sort(
    (left, right) =>
      left[1].sourceSeqStart - right[1].sourceSeqStart ||
      left[1].sourceSeqEnd - right[1].sourceSeqEnd ||
      left[1].createdAt - right[1].createdAt,
  );

  flushToolActivityBeforeNonToolMessage(state);
  for (const [turnKey, assistant] of pendingAssistants) {
    if (assistant.status === "streaming") {
      assistant.status = "completed";
    }
    state.messages.push(assistant);
    state.finalizedAssistantTurnKeys.add(turnKey);
  }
  state.openAssistantByTurn.clear();
}

export function completeOpenReasoningMessages(
  state: AssistantStreamProjectionState,
): void {
  for (const reasoning of state.openReasoningByTurn.values()) {
    if (reasoning.status === "streaming") {
      reasoning.status = "completed";
    }
  }
  state.openReasoningByTurn.clear();
}
