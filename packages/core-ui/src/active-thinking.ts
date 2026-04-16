import type {
  TimelineActiveThinking,
  ViewMessage,
} from "@bb/domain";
import { flattenViewMessagesDeep } from "./projection-flatten.js";

type ViewAssistantReasoningMessage = Extract<
  ViewMessage,
  { kind: "assistant-reasoning" }
>;

function isStreamingReasoningMessage(
  message: ViewMessage,
): message is ViewAssistantReasoningMessage {
  return message.kind === "assistant-reasoning" && message.status === "streaming";
}

function isNewerReasoningMessage(
  candidate: ViewAssistantReasoningMessage,
  current: ViewAssistantReasoningMessage,
): boolean {
  if (candidate.sourceSeqEnd !== current.sourceSeqEnd) {
    return candidate.sourceSeqEnd > current.sourceSeqEnd;
  }
  return candidate.createdAt > current.createdAt;
}

function toTimelineActiveThinking(
  message: ViewAssistantReasoningMessage,
): TimelineActiveThinking {
  return {
    id: message.id,
    text: message.text,
    startedAt: message.startedAt ?? message.createdAt,
    updatedAt: message.createdAt,
  };
}

export function extractActiveThinking(
  messages: readonly ViewMessage[],
): TimelineActiveThinking | null {
  let activeReasoning: ViewAssistantReasoningMessage | null = null;
  for (const message of flattenViewMessagesDeep(messages)) {
    if (!isStreamingReasoningMessage(message)) {
      continue;
    }
    if (!activeReasoning || isNewerReasoningMessage(message, activeReasoning)) {
      activeReasoning = message;
    }
  }

  return activeReasoning ? toTimelineActiveThinking(activeReasoning) : null;
}
