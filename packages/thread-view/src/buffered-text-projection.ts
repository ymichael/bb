import type { EventMeta } from "./event-decode.js";
import type { EventProjectionAssistantTextMessage } from "./event-projection-types.js";
import {
  finalizeProjectionKey,
  syncBufferedTextMessage,
} from "./assistant-stream-projection.js";
import type { ProjectionState } from "./event-projection-state.js";
import {
  finalizeReasoningTextBuffer,
  getReasoningTextBuffer,
  isReasoningProjectionKeyFinalized,
} from "./reasoning-lifecycle-projection.js";
import {
  appendVisibleTextBuffer,
  createVisibleTextBuffer,
  setVisibleTextBuffer,
  type VisibleTextBuffer,
} from "./visible-text-buffer.js";
import {
  createBufferedTextInstanceKey,
  type BufferedTextInstanceIdentity,
} from "./buffered-text-identity.js";

type BufferedTextEventProjectionMessage = EventProjectionAssistantTextMessage;

export interface BufferedTextProjectionRefs<
  TMessage extends BufferedTextEventProjectionMessage,
> {
  finalizedKeys: Set<string>;
  openMessages: Map<string, TMessage>;
  textBuffers: Map<string, VisibleTextBuffer>;
  visibleKeys: Set<string>;
}

export interface ProjectBufferedTextEventArgs<
  TMessage extends BufferedTextEventProjectionMessage,
> {
  createMessage: (messageKey: string) => TMessage;
  identity: BufferedTextInstanceIdentity | null;
  meta: EventMeta;
  mode: "delta" | "final";
  refs: BufferedTextProjectionRefs<TMessage>;
  state: ProjectionState;
  text: string | null;
}

type ResolveBufferedTextMessageKeyArgs<
  TMessage extends BufferedTextEventProjectionMessage,
> = Omit<
  ProjectBufferedTextEventArgs<TMessage>,
  "createMessage" | "mode" | "text"
>;

type UpsertBufferedTextMessageArgs<
  TMessage extends BufferedTextEventProjectionMessage,
> = Pick<
  ProjectBufferedTextEventArgs<TMessage>,
  "createMessage" | "meta" | "refs"
> & { messageKey: string };

export interface ProjectReasoningTextEventArgs {
  identity: BufferedTextInstanceIdentity | null;
  mode: "delta" | "final";
  state: ProjectionState;
  text: string | null;
}

function resolveBufferedTextMessageKey<
  TMessage extends BufferedTextEventProjectionMessage,
>(args: ResolveBufferedTextMessageKeyArgs<TMessage>): string | null {
  if (!args.identity) {
    return null;
  }

  const messageKey = createBufferedTextInstanceKey(args.identity);
  if (args.state.closedTurnIds.has(args.identity.turnId)) {
    return null;
  }
  if (args.refs.finalizedKeys.has(messageKey)) {
    return null;
  }

  args.state.openTurnIds.add(args.identity.turnId);
  return messageKey;
}

function upsertBufferedTextMessage<
  TMessage extends BufferedTextEventProjectionMessage,
>(args: UpsertBufferedTextMessageArgs<TMessage>): TMessage {
  let existing = args.refs.openMessages.get(args.messageKey);
  if (!existing) {
    existing = args.createMessage(args.messageKey);
    args.refs.openMessages.set(args.messageKey, existing);
    return existing;
  }

  existing.sourceSeqEnd = args.meta.seq;
  existing.createdAt = args.meta.createdAt;
  return existing;
}

export function projectBufferedTextEvent<
  TMessage extends BufferedTextEventProjectionMessage,
>(args: ProjectBufferedTextEventArgs<TMessage>): boolean {
  if (!args.text) {
    return false;
  }

  const messageKey = resolveBufferedTextMessageKey(args);
  if (!messageKey) {
    return true;
  }

  const message = upsertBufferedTextMessage({
    createMessage: args.createMessage,
    meta: args.meta,
    refs: args.refs,
    messageKey,
  });
  const buffer =
    args.refs.textBuffers.get(messageKey) ?? createVisibleTextBuffer();
  args.refs.textBuffers.set(messageKey, buffer);

  if (args.mode === "delta") {
    appendVisibleTextBuffer(buffer, args.text);
    syncBufferedTextMessage({
      buffer,
      messageKey,
      message,
      state: args.state,
      status: "streaming",
      visibleKeys: args.refs.visibleKeys,
    });
    return true;
  }

  setVisibleTextBuffer(buffer, args.text, true);
  syncBufferedTextMessage({
    buffer,
    messageKey,
    message,
    state: args.state,
    status: "completed",
    visibleKeys: args.refs.visibleKeys,
  });
  args.refs.openMessages.delete(messageKey);
  args.refs.textBuffers.delete(messageKey);
  args.refs.visibleKeys.delete(messageKey);
  finalizeProjectionKey(args.refs.finalizedKeys, messageKey);
  return true;
}

export function projectReasoningTextEvent(
  args: ProjectReasoningTextEventArgs,
): boolean {
  if (!args.text) {
    return false;
  }

  if (!args.identity) {
    return true;
  }

  const messageKey = createBufferedTextInstanceKey(args.identity);
  if (args.state.closedTurnIds.has(args.identity.turnId)) {
    return true;
  }
  if (isReasoningProjectionKeyFinalized(args.state, messageKey)) {
    return true;
  }
  args.state.openTurnIds.add(args.identity.turnId);

  const buffer = getReasoningTextBuffer(args.state, messageKey);

  if (args.mode === "delta") {
    appendVisibleTextBuffer(buffer, args.text);
    return true;
  }

  setVisibleTextBuffer(buffer, args.text, true);
  finalizeReasoningTextBuffer(args.state, messageKey);
  return true;
}
