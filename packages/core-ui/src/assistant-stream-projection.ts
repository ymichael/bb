import type {
  ViewAssistantReasoningMessage,
  ViewAssistantTextMessage,
  ViewMessage,
} from "@bb/domain";
import {
  flushToolActivityBeforeNonToolMessage,
  type ToolActivityProjectionState,
} from "./tool-activity-projection.js";
import {
  flushVisibleTextBuffer,
  getVisibleTextBufferText,
  type VisibleTextBuffer,
} from "./visible-text-buffer.js";

export interface AssistantStreamProjectionState extends ToolActivityProjectionState {
  messages: ViewMessage[];
  openAssistantMessagesByKey: Map<string, ViewAssistantTextMessage>;
  assistantTextBuffersByKey: Map<string, VisibleTextBuffer>;
  visibleAssistantMessageKeys: Set<string>;
  finalizedAssistantMessageKeys: Set<string>;
  openReasoningMessagesByKey: Map<string, ViewAssistantReasoningMessage>;
  reasoningTextBuffersByKey: Map<string, VisibleTextBuffer>;
  visibleReasoningMessageKeys: Set<string>;
  finalizedReasoningMessageKeys: Set<string>;
}

type BufferedAssistantMessage =
  | ViewAssistantTextMessage
  | ViewAssistantReasoningMessage;

interface SyncBufferedTextMessageArgs<
  TMessage extends BufferedAssistantMessage,
> {
  buffer: VisibleTextBuffer;
  messageKey: string;
  message: TMessage;
  state: AssistantStreamProjectionState;
  status: TMessage["status"];
  visibleKeys: Set<string>;
}

interface FlushBufferedTextMessagesArgs<
  TMessage extends BufferedAssistantMessage,
> {
  buffers: Map<string, VisibleTextBuffer>;
  finalizedKeys: Set<string>;
  openMessages: Map<string, TMessage>;
  state: AssistantStreamProjectionState;
  visibleKeys: Set<string>;
}

export function finalizeProjectionKey(
  finalizedKeys: Set<string>,
  messageKey: string,
): void {
  finalizedKeys.add(messageKey);
}

export function syncBufferedTextMessage<
  TMessage extends BufferedAssistantMessage,
>(args: SyncBufferedTextMessageArgs<TMessage>): void {
  const text = getVisibleTextBufferText(args.buffer);
  if (!text) {
    if (args.status === "completed") {
      args.message.status = "completed";
    }
    return;
  }

  args.message.text = text;
  args.message.status = args.status;
  if (args.visibleKeys.has(args.messageKey)) {
    return;
  }

  flushToolActivityBeforeNonToolMessage(args.state);
  args.state.messages.push(args.message);
  args.visibleKeys.add(args.messageKey);
}

function flushBufferedTextMessages<TMessage extends BufferedAssistantMessage>(
  args: FlushBufferedTextMessagesArgs<TMessage>,
): void {
  const pendingMessages = Array.from(args.openMessages.entries()).sort(
    (left, right) =>
      left[1].sourceSeqStart - right[1].sourceSeqStart ||
      left[1].sourceSeqEnd - right[1].sourceSeqEnd ||
      left[1].createdAt - right[1].createdAt,
  );

  for (const [messageKey, message] of pendingMessages) {
    const buffer = args.buffers.get(messageKey);
    if (buffer) {
      flushVisibleTextBuffer(buffer);
      syncBufferedTextMessage({
        buffer,
        messageKey,
        message,
        state: args.state,
        status: "completed",
        visibleKeys: args.visibleKeys,
      });
    } else {
      message.status = "completed";
    }
    args.finalizedKeys.add(messageKey);
  }

  args.openMessages.clear();
  args.buffers.clear();
  args.visibleKeys.clear();
}

export function flushBufferedAssistantMessages(
  state: AssistantStreamProjectionState,
): void {
  flushBufferedTextMessages({
    buffers: state.assistantTextBuffersByKey,
    finalizedKeys: state.finalizedAssistantMessageKeys,
    openMessages: state.openAssistantMessagesByKey,
    state,
    visibleKeys: state.visibleAssistantMessageKeys,
  });
}

export function flushBufferedReasoningMessages(
  state: AssistantStreamProjectionState,
): void {
  flushBufferedTextMessages({
    buffers: state.reasoningTextBuffersByKey,
    finalizedKeys: state.finalizedReasoningMessageKeys,
    openMessages: state.openReasoningMessagesByKey,
    state,
    visibleKeys: state.visibleReasoningMessageKeys,
  });
}

export function completeOpenReasoningMessages(
  state: AssistantStreamProjectionState,
): void {
  for (const reasoning of state.openReasoningMessagesByKey.values()) {
    if (reasoning.status === "streaming") {
      reasoning.status = "completed";
    }
  }
  state.openReasoningMessagesByKey.clear();
  state.reasoningTextBuffersByKey.clear();
  state.visibleReasoningMessageKeys.clear();
}
