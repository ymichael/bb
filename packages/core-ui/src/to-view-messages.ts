import type { ThreadEvent } from "@bb/domain";
import { requireThreadEventScopeTurnId } from "@bb/domain";
import { parseCompactionLifecycleEvent } from "./compaction-lifecycle.js";
import {
  type EventMeta,
  getEventParentToolCallId,
  getEventProviderThreadId,
  getEventTurnId,
} from "./event-decode.js";
import { messageId } from "./format-helpers.js";
import {
  createExecLifecycleContext,
  parseExecLifecycleEvent,
  parseToolCallLifecycleEvent,
} from "./exec-lifecycle.js";
import { parseFileEditFromItemEvent } from "./file-edit-parsing.js";
import { parseWebActivityLifecycleEvent } from "./web-activity-lifecycle.js";
import {
  parseOperationMessage,
  finalizeOperationMessage,
} from "./parse-operation-message.js";
import {
  parseErrorMessage,
  isDuplicateEventType,
  isIgnoredItemStartEvent,
  isIgnoredItemCompletedEvent,
  appendDebugEvent,
} from "./parse-error-message.js";
import { isIgnoredNoiseType } from "./timeline-noise-events.js";
import {
  compactTaskMessages,
  normalizeSemanticViewMessages,
  normalizeSemanticViewProjection,
  sortViewMessagesBySource,
} from "./semantic-view-messages.js";
import { applyProjectionTurnMessageDetail } from "./apply-turn-message-detail.js";
import {
  buildViewProjection,
  getOrderedThreadEvents,
  type ThreadEventWithMeta,
} from "./build-view-projection.js";
export type { ThreadEventWithMeta } from "./build-view-projection.js";
import {
  parseTaskMessage,
  shouldSuppressLowValueToolCall,
} from "./task-message-parsing.js";
import {
  shouldPreservePendingMessages,
  parseUserFromClientRequest,
  parseManagerUserMessage,
} from "./user-message-parsing.js";
import {
  parseAssistantDeltaText,
  parseAssistantFinalText,
  parseReasoningDeltaText,
  parseReasoningFinalText,
  isTerminalBufferedTextFlushEvent,
} from "./assistant-buffering.js";
import {
  createToolActivityState,
  flushActiveToolCell,
  flushPendingToolActivityOutput,
  flushToolActivityBeforeNonToolMessage,
  interruptPendingToolActivity,
  onExecBegin,
  onExecEnd,
  onExecOutput,
  onWebActivityBegin,
  onWebActivityEnd,
  type ToolActivityState,
} from "./tool-activity-projection.js";
import {
  finalizeOpenCompactionsForTurn,
  flushPendingFileEditOutput,
  onCompactionBegin,
  onCompactionEnd,
  upsertPermissionGrantLifecycleMessage,
  type CompactionTurnFinalizationStatus,
  upsertFileEdit,
  upsertProvisioningOperation,
  upsertThreadOperationMessage,
} from "./operation-projection.js";
import {
  completeOpenReasoningMessages,
  finalizeProjectionKey,
  flushBufferedAssistantMessages,
  flushBufferedReasoningMessages,
  syncBufferedTextMessage,
} from "./assistant-stream-projection.js";
import {
  appendVisibleTextBuffer,
  createVisibleTextBuffer,
  setVisibleTextBuffer,
  type VisibleTextBuffer,
} from "./visible-text-buffer.js";
import type {
  BufferedTextInstanceIdentity,
  ToViewMessagesOptions,
  ToViewProjectionOptions,
  ViewAssistantReasoningMessage,
  ViewAssistantTextMessage,
  ViewFileEditMessage,
  ViewMessage,
  ViewOperationMessage,
  ViewProjection,
} from "@bb/domain";
import {
  createBufferedTextInstanceKey,
  resolveBufferedTextIdentity,
} from "@bb/domain";

// --- Projection state machine ---

type ProjectedUserMessage = Extract<ViewMessage, { kind: "user" }>;
type BufferedTextViewMessage =
  | ViewAssistantReasoningMessage
  | ViewAssistantTextMessage;

interface CompactionTurnFinalization {
  status: CompactionTurnFinalizationStatus;
  detail: string | undefined;
}

interface BufferedTextProjectionRefs<TMessage extends BufferedTextViewMessage> {
  finalizedKeys: Set<string>;
  openMessages: Map<string, TMessage>;
  textBuffers: Map<string, VisibleTextBuffer>;
  visibleKeys: Set<string>;
}

interface ProjectBufferedTextEventArgs<
  TMessage extends BufferedTextViewMessage,
> {
  createMessage: (messageKey: string) => TMessage;
  identity: BufferedTextInstanceIdentity | null;
  meta: EventMeta;
  mode: "delta" | "final";
  refs: BufferedTextProjectionRefs<TMessage>;
  state: ProjectionState;
  text: string | null;
}

interface ProjectionState {
  messages: ViewMessage[];
  seenUserKeys: Set<string>;
  openAssistantMessagesByKey: Map<string, ViewAssistantTextMessage>;
  assistantTextBuffersByKey: Map<string, VisibleTextBuffer>;
  visibleAssistantMessageKeys: Set<string>;
  finalizedAssistantMessageKeys: Set<string>;
  openReasoningMessagesByKey: Map<string, ViewAssistantReasoningMessage>;
  reasoningTextBuffersByKey: Map<string, VisibleTextBuffer>;
  visibleReasoningMessageKeys: Set<string>;
  finalizedReasoningMessageKeys: Set<string>;
  openCompactionsByKey: Map<string, ViewOperationMessage>;
  finalizedCompactionKeys: Set<string>;
  provisioningOperationsByKey: Map<string, ViewOperationMessage>;
  permissionGrantsByInteractionId: Map<
    string,
    Extract<ViewMessage, { kind: "permission-grant-lifecycle" }>
  >;
  threadOperationsById: Map<string, ViewOperationMessage>;
  fileEditsByCallId: Map<string, ViewFileEditMessage>;
  fileEditStdoutBuffersByCallId: Map<string, VisibleTextBuffer>;
  delegationParentToolCallIdsByProviderThreadId: Map<string, string>;
  toolActivity: ToolActivityState;
}

function createProjectionState(): ProjectionState {
  return {
    messages: [],
    seenUserKeys: new Set(),
    openAssistantMessagesByKey: new Map(),
    assistantTextBuffersByKey: new Map(),
    visibleAssistantMessageKeys: new Set(),
    finalizedAssistantMessageKeys: new Set(),
    openReasoningMessagesByKey: new Map(),
    reasoningTextBuffersByKey: new Map(),
    visibleReasoningMessageKeys: new Set(),
    finalizedReasoningMessageKeys: new Set(),
    openCompactionsByKey: new Map(),
    finalizedCompactionKeys: new Set(),
    provisioningOperationsByKey: new Map(),
    permissionGrantsByInteractionId: new Map(),
    threadOperationsById: new Map(),
    fileEditsByCallId: new Map(),
    fileEditStdoutBuffersByCallId: new Map(),
    delegationParentToolCallIdsByProviderThreadId: new Map(),
    toolActivity: createToolActivityState(),
  };
}

const PROVIDER_THREAD_DELEGATION_TOOL_NAMES = new Set([
  "spawnAgent",
  "resumeAgent",
]);
const PROVIDER_THREAD_CHILD_INTERACTION_TOOL_NAMES = new Set([
  "sendInput",
  "wait",
  "closeAgent",
]);

function buildClientRequestTurnIdBySequence(
  events: ThreadEventWithMeta[],
): Map<number, string> {
  const turnIdBySequence = new Map<number, string>();
  for (const { event } of events) {
    if (event.type !== "turn/input/accepted") {
      continue;
    }
    turnIdBySequence.set(
      event.clientRequestSequence,
      requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      }),
    );
  }
  return turnIdBySequence;
}

function getToolCallName(decoded: ThreadEvent): string | undefined {
  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    decoded.item.type !== "toolCall"
  ) {
    return undefined;
  }

  return decoded.item.tool;
}

function getToolCallReceiverThreadIds(decoded: ThreadEvent): string[] {
  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    decoded.item.type !== "toolCall"
  ) {
    return [];
  }

  const receiverThreadIds = decoded.item.arguments?.receiverThreadIds;
  if (!Array.isArray(receiverThreadIds)) {
    return [];
  }

  return receiverThreadIds.filter(
    (receiverThreadId): receiverThreadId is string =>
      typeof receiverThreadId === "string" && receiverThreadId.length > 0,
  );
}

function getCompactionTurnFinalization(
  decoded: ThreadEvent,
): CompactionTurnFinalization | undefined {
  if (decoded.type === "provider/error") {
    return {
      status: "error",
      detail: decoded.detail ?? decoded.message,
    };
  }
  if (decoded.type === "turn/completed" && decoded.status === "failed") {
    return {
      status: "error",
      detail: decoded.error?.message,
    };
  }
  if (decoded.type === "turn/completed" && decoded.status === "interrupted") {
    return {
      status: "interrupted",
      detail: decoded.error?.message,
    };
  }
  return undefined;
}

function resolveBufferedTextMessageKey<
  TMessage extends BufferedTextViewMessage,
>(
  args: Omit<
    ProjectBufferedTextEventArgs<TMessage>,
    "createMessage" | "mode" | "state" | "text"
  >,
): string | null {
  if (!args.identity) {
    return null;
  }

  const messageKey = createBufferedTextInstanceKey(args.identity);
  if (args.refs.finalizedKeys.has(messageKey)) {
    return null;
  }

  return messageKey;
}

function upsertBufferedTextMessage<TMessage extends BufferedTextViewMessage>(
  args: Pick<
    ProjectBufferedTextEventArgs<TMessage>,
    "createMessage" | "meta" | "refs"
  > & { messageKey: string },
): TMessage {
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

function projectBufferedTextEvent<TMessage extends BufferedTextViewMessage>(
  args: ProjectBufferedTextEventArgs<TMessage>,
): boolean {
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

function finalizePendingMessages(
  state: ProjectionState,
  options: ToViewMessagesOptions | undefined,
): void {
  const shouldPreservePending = shouldPreservePendingMessages(
    options?.threadStatus,
  );
  const shouldFinalizeBufferedAssistants =
    options?.threadStatus !== undefined && !shouldPreservePending;
  if (shouldPreservePending) {
    flushActiveToolCell(state);
    return;
  }

  flushPendingToolActivityOutput(state);
  flushPendingFileEditOutput(state);
  interruptPendingToolActivity(state);

  for (const fileEdit of state.fileEditsByCallId.values()) {
    if (fileEdit.status === "pending") {
      fileEdit.status = "interrupted";
    }
  }

  if (shouldFinalizeBufferedAssistants) {
    flushBufferedAssistantMessages(state);
    flushBufferedReasoningMessages(state);
  } else {
    completeOpenReasoningMessages(state);
  }

  for (const message of state.messages) {
    if (message.kind !== "operation") continue;
    finalizeOperationMessage(message, options);
  }

  flushActiveToolCell(state);
}

// --- Main entry point ---

function buildFlatViewMessages(
  events: ThreadEventWithMeta[] | undefined,
  options?: ToViewMessagesOptions,
): ViewMessage[] {
  if (!events || events.length === 0) return [];

  const state = createProjectionState();
  const includeDebugRawEvents = options?.includeDebugRawEvents ?? false;

  const orderedEvents = getOrderedThreadEvents(events);
  const clientRequestTurnIdBySequence =
    buildClientRequestTurnIdBySequence(orderedEvents);
  const execLifecycleContext = createExecLifecycleContext();

  for (const { event: decoded, meta } of orderedEvents) {
    const eventType = decoded.type;
    const eventTurnId = getEventTurnId(decoded);
    const eventProviderThreadId = getEventProviderThreadId(decoded);
    const explicitEventParentToolCallId = getEventParentToolCallId(decoded);
    const eventParentToolCallId =
      explicitEventParentToolCallId ??
      (eventProviderThreadId
        ? state.delegationParentToolCallIdsByProviderThreadId.get(
            eventProviderThreadId,
          )
        : undefined);

    const compactionTurnFinalization = getCompactionTurnFinalization(decoded);
    if (compactionTurnFinalization) {
      finalizeOpenCompactionsForTurn({
        state,
        meta,
        threadId: decoded.threadId,
        turnId: eventTurnId,
        status: compactionTurnFinalization.status,
        detail: compactionTurnFinalization.detail,
      });
    }

    if (isTerminalBufferedTextFlushEvent(eventType)) {
      flushBufferedAssistantMessages(state);
      flushBufferedReasoningMessages(state);
      flushPendingToolActivityOutput(state);
      flushPendingFileEditOutput(state);
    }

    const userFromClientRequest = parseUserFromClientRequest({
      decoded,
      meta,
      options,
      resolvedTurnId: clientRequestTurnIdBySequence.get(meta.seq),
    });
    if (userFromClientRequest) {
      const projectedClientUser: ProjectedUserMessage = userFromClientRequest;
      const key = projectedClientUser.id;
      if (!state.seenUserKeys.has(key)) {
        state.seenUserKeys.add(key);
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push(projectedClientUser);
      }
      continue;
    }

    const managerUserMessage = parseManagerUserMessage(decoded, meta);
    if (managerUserMessage) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(managerUserMessage);
      continue;
    }

    const assistantIdentity = resolveBufferedTextIdentity({
      decoded,
      kind: "assistant",
      parentToolCallId: eventParentToolCallId,
      turnId: eventTurnId,
    });
    const reasoningIdentity = resolveBufferedTextIdentity({
      decoded,
      kind: "reasoning",
      parentToolCallId: eventParentToolCallId,
      turnId: eventTurnId,
    });

    if (
      projectBufferedTextEvent({
        createMessage: (messageKey) => ({
          kind: "assistant-text",
          id: messageId(decoded.threadId, "assistant", messageKey),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          scope: decoded.scope,
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: "",
          status: "streaming",
        }),
        identity: assistantIdentity,
        meta,
        mode: "delta",
        refs: {
          finalizedKeys: state.finalizedAssistantMessageKeys,
          openMessages: state.openAssistantMessagesByKey,
          textBuffers: state.assistantTextBuffersByKey,
          visibleKeys: state.visibleAssistantMessageKeys,
        },
        state,
        text:
          options?.threadType === "manager"
            ? null
            : parseAssistantDeltaText(decoded),
      })
    ) {
      continue;
    }

    if (
      projectBufferedTextEvent({
        createMessage: (messageKey) => ({
          kind: "assistant-text",
          id: messageId(decoded.threadId, "assistant", messageKey),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          scope: decoded.scope,
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: "",
          status: "streaming",
        }),
        identity: assistantIdentity,
        meta,
        mode: "final",
        refs: {
          finalizedKeys: state.finalizedAssistantMessageKeys,
          openMessages: state.openAssistantMessagesByKey,
          textBuffers: state.assistantTextBuffersByKey,
          visibleKeys: state.visibleAssistantMessageKeys,
        },
        state,
        text:
          options?.threadType === "manager"
            ? null
            : parseAssistantFinalText(decoded),
      })
    ) {
      continue;
    }

    if (
      projectBufferedTextEvent({
        createMessage: (messageKey) => ({
          kind: "assistant-reasoning",
          id: messageId(decoded.threadId, "reasoning", messageKey),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          scope: decoded.scope,
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: "",
          status: "streaming",
        }),
        identity: reasoningIdentity,
        meta,
        mode: "delta",
        refs: {
          finalizedKeys: state.finalizedReasoningMessageKeys,
          openMessages: state.openReasoningMessagesByKey,
          textBuffers: state.reasoningTextBuffersByKey,
          visibleKeys: state.visibleReasoningMessageKeys,
        },
        state,
        text:
          options?.threadType === "manager"
            ? null
            : parseReasoningDeltaText(decoded),
      })
    ) {
      continue;
    }

    if (
      projectBufferedTextEvent({
        createMessage: (messageKey) => ({
          kind: "assistant-reasoning",
          id: messageId(decoded.threadId, "reasoning", messageKey),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          scope: decoded.scope,
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: "",
          status: "streaming",
        }),
        identity: reasoningIdentity,
        meta,
        mode: "final",
        refs: {
          finalizedKeys: state.finalizedReasoningMessageKeys,
          openMessages: state.openReasoningMessagesByKey,
          textBuffers: state.reasoningTextBuffersByKey,
          visibleKeys: state.visibleReasoningMessageKeys,
        },
        state,
        text:
          options?.threadType === "manager"
            ? null
            : parseReasoningFinalText(decoded),
      })
    ) {
      continue;
    }

    const execEvent = parseExecLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
      execLifecycleContext,
    );
    if (execEvent) {
      if (execEvent.kind === "begin") {
        onExecBegin(state, meta, decoded.threadId, eventTurnId, execEvent.call);
      } else if (execEvent.kind === "output") {
        onExecOutput(
          state,
          meta,
          execEvent.call,
          execEvent.appendOutput,
          execEvent.replaceOutput,
        );
      } else {
        onExecEnd(state, meta, decoded.threadId, eventTurnId, execEvent.call);
      }
      continue;
    }

    const taskMessage = parseTaskMessage(decoded, meta, eventParentToolCallId);
    if (taskMessage) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(taskMessage);
      continue;
    }

    if (shouldSuppressLowValueToolCall(decoded)) {
      continue;
    }

    const toolCallEvent = parseToolCallLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
      execLifecycleContext,
    );
    if (toolCallEvent) {
      const toolCallName = getToolCallName(decoded);
      const toolCallReceiverThreadIds = getToolCallReceiverThreadIds(decoded);
      if (
        !toolCallEvent.call.parentToolCallId &&
        toolCallName &&
        PROVIDER_THREAD_CHILD_INTERACTION_TOOL_NAMES.has(toolCallName)
      ) {
        const inferredParentToolCallId = toolCallReceiverThreadIds
          .map((receiverThreadId) =>
            state.delegationParentToolCallIdsByProviderThreadId.get(
              receiverThreadId,
            ),
          )
          .find(
            (parentToolCallId): parentToolCallId is string =>
              typeof parentToolCallId === "string" &&
              parentToolCallId.length > 0,
          );
        if (inferredParentToolCallId) {
          toolCallEvent.call.parentToolCallId = inferredParentToolCallId;
        }
      }
      if (
        toolCallName &&
        PROVIDER_THREAD_DELEGATION_TOOL_NAMES.has(toolCallName)
      ) {
        for (const receiverThreadId of toolCallReceiverThreadIds) {
          state.delegationParentToolCallIdsByProviderThreadId.set(
            receiverThreadId,
            toolCallEvent.call.callId,
          );
        }
      }
      if (toolCallEvent.kind === "begin") {
        onExecBegin(
          state,
          meta,
          decoded.threadId,
          eventTurnId,
          toolCallEvent.call,
        );
      } else if (toolCallEvent.kind === "output") {
        onExecOutput(
          state,
          meta,
          toolCallEvent.call,
          toolCallEvent.appendOutput,
          toolCallEvent.replaceOutput,
        );
      } else {
        onExecEnd(
          state,
          meta,
          decoded.threadId,
          eventTurnId,
          toolCallEvent.call,
        );
      }
      continue;
    }

    const webActivityEvent = parseWebActivityLifecycleEvent(
      decoded,
      eventParentToolCallId,
    );
    if (webActivityEvent) {
      if (webActivityEvent.kind === "begin") {
        onWebActivityBegin(
          state,
          meta,
          decoded.threadId,
          eventTurnId,
          webActivityEvent,
        );
      } else {
        onWebActivityEnd(
          state,
          meta,
          decoded.threadId,
          eventTurnId,
          webActivityEvent,
        );
      }
      continue;
    }

    const fileEdit = parseFileEditFromItemEvent(decoded, eventParentToolCallId);
    if (fileEdit) {
      flushToolActivityBeforeNonToolMessage(state);
      upsertFileEdit(state, meta, decoded.threadId, eventTurnId, fileEdit);
      continue;
    }

    const compactionEvent = parseCompactionLifecycleEvent(decoded, meta);
    if (compactionEvent) {
      flushToolActivityBeforeNonToolMessage(state);
      if (compactionEvent.kind === "begin") {
        onCompactionBegin(
          state,
          meta,
          decoded.threadId,
          eventTurnId,
          compactionEvent,
        );
      } else {
        onCompactionEnd(
          state,
          meta,
          decoded.threadId,
          eventTurnId,
          compactionEvent,
        );
      }
      continue;
    }

    const operation = parseOperationMessage(decoded, meta, {
      includeOptionalOperations: options?.includeOptionalOperations,
    });
    if (operation) {
      flushToolActivityBeforeNonToolMessage(state);
      if (
        operation.kind === "operation" &&
        operation.opType === "thread-provisioning"
      ) {
        upsertProvisioningOperation(state, operation);
        continue;
      }
      if (operation.kind === "operation" && operation.opType === "operation") {
        upsertThreadOperationMessage(state, operation);
        continue;
      }
      if (operation.kind === "permission-grant-lifecycle") {
        upsertPermissionGrantLifecycleMessage(state, operation);
        continue;
      }
      state.messages.push(operation);
      continue;
    }

    const error = parseErrorMessage(decoded, meta);
    if (error) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(error);
      continue;
    }

    if (includeDebugRawEvents) {
      const debugReason = isDuplicateEventType(eventType)
        ? "duplicate-event"
        : isIgnoredNoiseType(eventType) ||
            isIgnoredItemStartEvent(decoded) ||
            isIgnoredItemCompletedEvent(decoded)
          ? "ignored-noise"
          : "unhandled";

      if (debugReason !== "unhandled") {
        continue;
      }

      flushToolActivityBeforeNonToolMessage(state);
      appendDebugEvent(state.messages, decoded, meta, debugReason);
    }
  }

  finalizePendingMessages(state, options);
  return sortViewMessagesBySource(compactTaskMessages(state.messages));
}

function toFullProjection(
  events: ThreadEventWithMeta[],
  options: ToViewProjectionOptions,
): ViewProjection {
  const messages = buildFlatViewMessages(events, options);
  return buildViewProjection({
    events,
    messages,
  });
}

export function toViewMessages(
  events: ThreadEventWithMeta[] | undefined,
  options?: ToViewMessagesOptions,
): ViewMessage[] {
  return normalizeSemanticViewMessages(buildFlatViewMessages(events, options));
}

export function toViewProjection(
  events: ThreadEventWithMeta[] | undefined,
  options: ToViewProjectionOptions,
): ViewProjection {
  if (!events || events.length === 0) {
    return { entries: [] };
  }

  const orderedEvents = getOrderedThreadEvents(events);
  const fullProjection = toFullProjection(orderedEvents, options);
  const semanticProjection = normalizeSemanticViewProjection(fullProjection);
  return applyProjectionTurnMessageDetail(
    semanticProjection,
    options.turnMessageDetail,
  );
}
