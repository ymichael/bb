import type { ThreadEvent } from "@bb/domain";
import {
  parseAssistantDeltaText,
  parseAssistantFinalText,
  parseReasoningDeltaText,
  parseReasoningFinalText,
} from "./assistant-buffering.js";
import {
  projectBufferedTextEvent,
  projectReasoningTextEvent,
} from "./buffered-text-projection.js";
import { resolveBufferedTextIdentity } from "./buffered-text-identity.js";
import type { EventMeta } from "./event-decode.js";
import type {
  BuildEventProjectionMessagesOptions,
  EventProjectionAssistantTextMessage,
} from "./event-projection-types.js";
import { messageId } from "./format-helpers.js";
import {
  finalizeReasoningLifecycle,
  trackReasoningTurn,
  upsertReasoningLifecycle,
} from "./reasoning-lifecycle-projection.js";
import type { ProjectionState } from "./event-projection-state.js";

interface ProjectAssistantAndReasoningEventArgs {
  decoded: ThreadEvent;
  eventParentToolCallId: string | undefined;
  eventTurnId: string | undefined;
  meta: EventMeta;
  options: BuildEventProjectionMessagesOptions | undefined;
  shouldTrackActiveThinking: boolean;
  state: ProjectionState;
}

interface CreateAssistantTextMessageArgs {
  decoded: ThreadEvent;
  eventParentToolCallId: string | undefined;
  messageKey: string;
  meta: EventMeta;
}

function shouldSuppressBufferedText(
  options: BuildEventProjectionMessagesOptions | undefined,
): boolean {
  return options?.threadType === "manager";
}

function createAssistantTextMessage(
  args: CreateAssistantTextMessageArgs,
): EventProjectionAssistantTextMessage {
  return {
    kind: "assistant-text",
    id: messageId(args.decoded.threadId, "assistant", args.messageKey),
    threadId: args.decoded.threadId,
    sourceSeqStart: args.meta.seq,
    sourceSeqEnd: args.meta.seq,
    createdAt: args.meta.createdAt,
    startedAt: args.meta.createdAt,
    scope: args.decoded.scope,
    ...(args.eventParentToolCallId
      ? { parentToolCallId: args.eventParentToolCallId }
      : {}),
    text: "",
    status: "streaming",
  };
}

export function projectAssistantAndReasoningEvent(
  args: ProjectAssistantAndReasoningEventArgs,
): boolean {
  const assistantIdentity = resolveBufferedTextIdentity({
    decoded: args.decoded,
    kind: "assistant",
    parentToolCallId: args.eventParentToolCallId,
    turnId: args.eventTurnId,
  });
  const reasoningIdentity = resolveBufferedTextIdentity({
    decoded: args.decoded,
    kind: "reasoning",
    parentToolCallId: args.eventParentToolCallId,
    turnId: args.eventTurnId,
  });
  const shouldSuppressText = shouldSuppressBufferedText(args.options);

  if (
    args.decoded.type === "item/started" &&
    args.decoded.item.type === "reasoning"
  ) {
    trackReasoningTurn(args.state, reasoningIdentity);
    if (args.shouldTrackActiveThinking) {
      upsertReasoningLifecycle({
        identity: reasoningIdentity,
        meta: args.meta,
        state: args.state,
      });
    }
  }

  if (
    projectBufferedTextEvent({
      createMessage: (messageKey) =>
        createAssistantTextMessage({
          decoded: args.decoded,
          eventParentToolCallId: args.eventParentToolCallId,
          messageKey,
          meta: args.meta,
        }),
      identity: assistantIdentity,
      meta: args.meta,
      mode: "delta",
      refs: {
        finalizedKeys: args.state.finalizedAssistantMessageKeys,
        openMessages: args.state.openAssistantMessagesByKey,
        textBuffers: args.state.assistantTextBuffersByKey,
        visibleKeys: args.state.visibleAssistantMessageKeys,
      },
      state: args.state,
      text: shouldSuppressText ? null : parseAssistantDeltaText(args.decoded),
    })
  ) {
    return true;
  }

  if (
    projectBufferedTextEvent({
      createMessage: (messageKey) =>
        createAssistantTextMessage({
          decoded: args.decoded,
          eventParentToolCallId: args.eventParentToolCallId,
          messageKey,
          meta: args.meta,
        }),
      identity: assistantIdentity,
      meta: args.meta,
      mode: "final",
      refs: {
        finalizedKeys: args.state.finalizedAssistantMessageKeys,
        openMessages: args.state.openAssistantMessagesByKey,
        textBuffers: args.state.assistantTextBuffersByKey,
        visibleKeys: args.state.visibleAssistantMessageKeys,
      },
      state: args.state,
      text: shouldSuppressText ? null : parseAssistantFinalText(args.decoded),
    })
  ) {
    return true;
  }

  if (
    (args.decoded.type === "item/reasoning/summaryTextDelta" ||
      args.decoded.type === "item/reasoning/textDelta") &&
    reasoningIdentity
  ) {
    trackReasoningTurn(args.state, reasoningIdentity);
    if (args.shouldTrackActiveThinking) {
      upsertReasoningLifecycle({
        identity: reasoningIdentity,
        meta: args.meta,
        state: args.state,
      });
    }
  }

  if (
    projectReasoningTextEvent({
      identity: reasoningIdentity,
      mode: "delta",
      state: args.state,
      text: shouldSuppressText ? null : parseReasoningDeltaText(args.decoded),
    })
  ) {
    return true;
  }

  if (
    projectReasoningTextEvent({
      identity: reasoningIdentity,
      mode: "final",
      state: args.state,
      text: shouldSuppressText ? null : parseReasoningFinalText(args.decoded),
    })
  ) {
    if (
      args.decoded.type === "item/completed" &&
      args.decoded.item.type === "reasoning"
    ) {
      finalizeReasoningLifecycle(args.state, reasoningIdentity);
    }
    return true;
  }

  if (
    args.decoded.type === "item/completed" &&
    args.decoded.item.type === "reasoning"
  ) {
    finalizeReasoningLifecycle(args.state, reasoningIdentity);
  }

  return false;
}
