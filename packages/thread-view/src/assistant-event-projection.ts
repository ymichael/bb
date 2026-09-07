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
import type { EventProjectionAssistantTextMessage } from "./event-projection-types.js";
import { messageId } from "./format-helpers.js";
import {
  finalizeReasoningLifecycle,
  upsertReasoningLifecycle,
} from "./reasoning-lifecycle-projection.js";
import type { ProjectionState } from "./event-projection-state.js";

interface ProjectAssistantAndReasoningEventArgs {
  decoded: ThreadEvent;
  eventParentToolCallId: string | undefined;
  eventTurnId: string | undefined;
  meta: EventMeta;
  state: ProjectionState;
}

interface CreateAssistantTextMessageArgs {
  decoded: ThreadEvent;
  eventParentToolCallId: string | undefined;
  messageKey: string;
  meta: EventMeta;
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

  if (reasoningIdentity) {
    upsertReasoningLifecycle({
      identity: reasoningIdentity,
      meta: args.meta,
      parentToolCallId: args.eventParentToolCallId,
      state: args.state,
      threadId: args.decoded.threadId,
    });
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
      text: parseAssistantDeltaText(args.decoded),
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
      text: parseAssistantFinalText(args.decoded),
    })
  ) {
    return true;
  }

  if (
    projectReasoningTextEvent({
      identity: reasoningIdentity,
      mode: "delta",
      state: args.state,
      text: parseReasoningDeltaText(args.decoded),
    })
  ) {
    return true;
  }

  const projectedReasoningFinal = projectReasoningTextEvent({
    identity: reasoningIdentity,
    mode: "final",
    state: args.state,
    text: parseReasoningFinalText(args.decoded),
  });

  if (
    args.decoded.type === "item/completed" &&
    args.decoded.item.type === "reasoning"
  ) {
    finalizeReasoningLifecycle({
      identity: reasoningIdentity,
      meta: args.meta,
      state: args.state,
      status: "completed",
      text: parseReasoningFinalText(args.decoded),
    });
  }

  return projectedReasoningFinal;
}
