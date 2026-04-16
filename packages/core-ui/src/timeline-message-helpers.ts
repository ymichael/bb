import type { ViewMessage } from "@bb/domain";

export interface IndexedTimelineMessage {
  index: number;
  message: ViewMessage;
}

export function isTimelineTerminalMessage(message: ViewMessage): boolean {
  return message.kind === "assistant-text" || message.kind === "error";
}

export function isTimelineUngroupableMessage(message: ViewMessage): boolean {
  return message.kind === "user" || message.kind === "debug/raw-event";
}

export function isTimelineHiddenMessage(message: ViewMessage): boolean {
  return message.kind === "assistant-reasoning";
}

export function toTimelineVisibleMessages(
  messages: readonly ViewMessage[],
): ViewMessage[] {
  return messages.filter((message) => !isTimelineHiddenMessage(message));
}

export function toIndexedTimelineMessages(
  messages: readonly ViewMessage[],
): IndexedTimelineMessage[] {
  return messages.map((message, index) => ({ index, message }));
}

export function findLastTerminalTimelineMessageIndex(
  messages: readonly IndexedTimelineMessage[],
): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turnMessage = messages[index];
    if (turnMessage && isTimelineTerminalMessage(turnMessage.message)) {
      return turnMessage.index;
    }
  }
  return null;
}

export function findLastTerminalTimelineMessage(
  messages: readonly ViewMessage[],
): ViewMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isTimelineTerminalMessage(message)) {
      return message;
    }
  }
  return undefined;
}
