import type { ThreadEvent } from "@bb/domain";
import { parseCompactionLifecycleEvent } from "./compaction-lifecycle.js";
import {
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
import { parseWebSearchLifecycleEvent } from "./web-search-lifecycle.js";
import { parseOperationMessage, finalizeOperationMessage } from "./parse-operation-message.js";
import { parseErrorMessage, isDuplicateEventType, isIgnoredItemStartEvent, isIgnoredItemCompletedEvent, appendDebugEvent } from "./parse-error-message.js";
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
import { parseTaskMessage, shouldSuppressLowValueToolCall } from "./task-message-parsing.js";
import {
  parsePromptInput,
  userMessageSignature,
  shouldRenderThreadStartInput,
  shouldPreservePendingMessages,
  parseUserFromItemEvent,
  parseUserFromClientStart,
  parseManagerUserMessage,
} from "./user-message-parsing.js";
import {
  parseAssistantDeltaText,
  parseAssistantFinalText,
  parseReasoningDeltaText,
  parseReasoningFinalText,
  isTerminalAssistantFlushEvent,
} from "./assistant-buffering.js";
import {
  buildUserMessageKey,
  clearPendingUserSignatureCounts,
  consumePendingClientStartUser,
  createPendingUserSignatureCounts,
  getClientStartEventContext,
  materializePendingClientRequestedUserMessages,
  recordProjectedClientUser,
  recordProjectedProviderUser,
  shiftPendingClientRequestedUser,
  shouldSkipProjectedClientUser,
  type ProjectedUserMessage,
} from "./user-message-dedup.js";
import {
  createToolActivityState,
  flushActiveToolCell,
  flushToolActivityBeforeNonToolMessage,
  interruptPendingToolActivity,
  onExecBegin,
  onExecEnd,
  onExecOutput,
  onWebSearchBegin,
  onWebSearchEnd,
  type ToolActivityState,
} from "./tool-activity-projection.js";
import {
  onCompactionBegin,
  onCompactionEnd,
  resolveProjectedCompactionEvent,
  upsertFileEdit,
} from "./operation-projection.js";
import {
  completeOpenReasoningMessages,
  finalizeProjectionKeys,
  flushBufferedAssistantMessages,
  hasFinalizedProjectionKey,
  resolveOpenProjectionKey,
} from "./assistant-stream-projection.js";
import type {
  ToViewMessagesOptions,
  ToViewProjectionOptions,
  ViewAssistantReasoningMessage,
  ViewAssistantTextMessage,
  ViewFileEditMessage,
  ViewMessage,
  ViewOperationMessage,
  ViewProjection,
} from "@bb/domain";

// --- Projection state machine ---

interface ProjectionState {
  messages: ViewMessage[];
  seenUserKeys: Set<string>;
  openAssistantByTurn: Map<string, ViewAssistantTextMessage>;
  finalizedAssistantTurnKeys: Set<string>;
  openReasoningByTurn: Map<string, ViewAssistantReasoningMessage>;
  finalizedReasoningTurnKeys: Set<string>;
  openCompactionsByKey: Map<string, ViewOperationMessage>;
  finalizedCompactionKeys: Set<string>;
  lastCompletedCompactionKeyByThreadId: Map<string, string>;
  fileEditsByCallId: Map<string, ViewFileEditMessage>;
  delegationParentToolCallIdsByProviderThreadId: Map<string, string>;
  toolActivity: ToolActivityState;
}

function createProjectionState(): ProjectionState {
  return {
    messages: [],
    seenUserKeys: new Set(),
    openAssistantByTurn: new Map(),
    finalizedAssistantTurnKeys: new Set(),
    openReasoningByTurn: new Map(),
    finalizedReasoningTurnKeys: new Set(),
    openCompactionsByKey: new Map(),
    finalizedCompactionKeys: new Set(),
    lastCompletedCompactionKeyByThreadId: new Map(),
    fileEditsByCallId: new Map(),
    delegationParentToolCallIdsByProviderThreadId: new Map(),
    toolActivity: createToolActivityState(),
  };
}

const PROVIDER_THREAD_DELEGATION_TOOL_NAMES = new Set(["spawnAgent", "resumeAgent"]);
const PROVIDER_THREAD_CHILD_INTERACTION_TOOL_NAMES = new Set([
  "sendInput",
  "wait",
  "closeAgent",
]);

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

function finalizePendingMessages(
  state: ProjectionState,
  options: ToViewMessagesOptions | undefined,
): void {
  const shouldPreservePending = shouldPreservePendingMessages(options?.threadStatus);
  const shouldFinalizeBufferedAssistants =
    options?.threadStatus !== undefined && !shouldPreservePending;
  if (shouldPreservePending) {
    flushActiveToolCell(state);
    return;
  }

  interruptPendingToolActivity(state);

  for (const fileEdit of state.fileEditsByCallId.values()) {
    if (fileEdit.status === "pending") {
      fileEdit.status = "interrupted";
    }
  }

  if (shouldFinalizeBufferedAssistants) {
    flushBufferedAssistantMessages(state);
  }

  completeOpenReasoningMessages(state);

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
  const includeInternalSystemMessages =
    options?.includeInternalSystemMessages ?? false;

  const orderedEvents = getOrderedThreadEvents(events);
  const pendingUserSignatureCounts = createPendingUserSignatureCounts();
  const execLifecycleContext = createExecLifecycleContext();

  for (const { event: decoded, meta } of orderedEvents) {
    const eventType = decoded.type;
    const eventTurnId = getEventTurnId(decoded);
    const eventProviderThreadId = getEventProviderThreadId(decoded);
    const explicitEventParentToolCallId = getEventParentToolCallId(decoded);
    const eventParentToolCallId =
      explicitEventParentToolCallId ??
      (eventProviderThreadId
        ? state.delegationParentToolCallIdsByProviderThreadId.get(eventProviderThreadId)
        : undefined);

    if (eventType === "turn/completed") {
      clearPendingUserSignatureCounts({ counts: pendingUserSignatureCounts });
    }

    if (state.openAssistantByTurn.size > 0 && isTerminalAssistantFlushEvent(eventType)) {
      flushBufferedAssistantMessages(state);
    }

    if (
      decoded.type === "client/thread/start" ||
      decoded.type === "client/turn/requested" ||
      decoded.type === "client/turn/start"
    ) {
      if (
        decoded.initiator === "system" &&
        !includeInternalSystemMessages
      ) {
        const parsedInput = parsePromptInput(decoded.input);
        if (parsedInput && shouldRenderThreadStartInput(options?.threadStatus)) {
          const signature = userMessageSignature({
            text: parsedInput.text,
            webImages: parsedInput.webImages,
            localImages: parsedInput.localImages,
            localFiles: parsedInput.localFiles,
          });
          const clientStartContext = getClientStartEventContext(
            decoded.type,
            decoded.source,
          );
          if (
            clientStartContext &&
            shouldSkipProjectedClientUser({
              counts: pendingUserSignatureCounts,
              signature,
              context: clientStartContext,
            })
          ) {
            continue;
          }
          if (clientStartContext) {
            recordProjectedClientUser({
              clientRequestSequence: meta.seq,
              counts: pendingUserSignatureCounts,
              signature,
              context: clientStartContext,
            });
          }
        }
        continue;
      }
    }

    const userFromClientThreadStart = parseUserFromClientStart(
      decoded,
      meta,
      options,
    );
    if (userFromClientThreadStart) {
      const signature = userMessageSignature({
        text: userFromClientThreadStart.text,
        webImages: userFromClientThreadStart.attachments?.webImages ?? 0,
        localImages: userFromClientThreadStart.attachments?.localImages ?? 0,
        localFiles: userFromClientThreadStart.attachments?.localFiles ?? 0,
      });
      const clientStartContext = getClientStartEventContext(
        decoded.type,
        (
          decoded.type === "client/thread/start" ||
          decoded.type === "client/turn/requested" ||
          decoded.type === "client/turn/start"
        )
          ? decoded.source
          : undefined,
      );
      if (
        clientStartContext &&
        shouldSkipProjectedClientUser({
          counts: pendingUserSignatureCounts,
          signature,
          context: clientStartContext,
        })
      ) {
        continue;
      }
      const projectedClientUser: ProjectedUserMessage = userFromClientThreadStart;
      if (clientStartContext?.isTurnRequested) {
        recordProjectedClientUser({
          clientRequestSequence: meta.seq,
          counts: pendingUserSignatureCounts,
          signature,
          context: clientStartContext,
          message: projectedClientUser,
        });
        continue;
      }
      const key = buildUserMessageKey(projectedClientUser);
      if (!state.seenUserKeys.has(key)) {
        state.seenUserKeys.add(key);
        if (clientStartContext) {
          recordProjectedClientUser({
            clientRequestSequence: meta.seq,
            counts: pendingUserSignatureCounts,
            signature,
            context: clientStartContext,
            message: projectedClientUser,
          });
        }
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

    const userMessage = parseUserFromItemEvent(decoded, meta);
    if (userMessage) {
      const signature = userMessageSignature({
        text: userMessage.text,
        webImages: userMessage.attachments?.webImages ?? 0,
        localImages: userMessage.attachments?.localImages ?? 0,
        localFiles: userMessage.attachments?.localFiles ?? 0,
      });
      const clientRequestSequence =
        decoded.type === "item/completed" &&
        decoded.item.type === "userMessage"
          ? decoded.item.clientRequestSequence
          : undefined;
      const clientRequestedMatch = clientRequestSequence !== undefined
        ? shiftPendingClientRequestedUser({
            counts: pendingUserSignatureCounts,
            clientRequestSequence,
          })
        : undefined;
      const projectedUserMessage: ProjectedUserMessage = userMessage;
      if (clientRequestedMatch) {
        if (!clientRequestedMatch.message) {
          continue;
        }
      } else {
        const consumedClientStart = consumePendingClientStartUser({
          counts: pendingUserSignatureCounts,
          signature,
        });
        if (consumedClientStart) {
          state.seenUserKeys.add(buildUserMessageKey(projectedUserMessage));
          continue;
        }
      }
      const key = buildUserMessageKey(projectedUserMessage);
      if (!state.seenUserKeys.has(key)) {
        state.seenUserKeys.add(key);
        recordProjectedProviderUser({
          counts: pendingUserSignatureCounts,
          signature,
        });
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push(projectedUserMessage);
      }
      continue;
    }

    // Extract itemId from decoded for delta/final event grouping
    const decodedItemId = (decoded.type === "item/agentMessage/delta" ||
      decoded.type === "item/reasoning/summaryTextDelta" ||
      decoded.type === "item/reasoning/textDelta")
      ? decoded.itemId
      : (decoded.type === "item/completed" && (decoded.item.type === "agentMessage" || decoded.item.type === "reasoning"))
        ? decoded.item.id
        : undefined;

    const assistantDelta = options?.threadType === "manager"
      ? null
      : parseAssistantDeltaText(decoded);
    if (assistantDelta) {
      const turnKeyPrefix = eventParentToolCallId
        ? `parent:${eventParentToolCallId}:`
        : "";
      const primaryTurnKey = `${turnKeyPrefix}${decodedItemId ?? eventTurnId ?? `seq-${meta.seq}`}`;
      const fallbackTurnKey =
        decodedItemId && eventTurnId
          ? `${turnKeyPrefix}${eventTurnId}`
          : undefined;
      if (
        hasFinalizedProjectionKey(
          state.finalizedAssistantTurnKeys,
          primaryTurnKey,
          fallbackTurnKey,
        )
      ) {
        continue;
      }

      const turnKey = resolveOpenProjectionKey(
        state.openAssistantByTurn,
        primaryTurnKey,
        fallbackTurnKey,
      );
      let existing = state.openAssistantByTurn.get(turnKey);
      if (existing?.status === "completed") {
        continue;
      }
      if (!existing) {
        existing = {
          kind: "assistant-text",
          id: messageId(decoded.threadId, "assistant", turnKey),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: assistantDelta,
          status: "streaming",
        };
        state.openAssistantByTurn.set(turnKey, existing);
      } else {
        existing.sourceSeqEnd = meta.seq;
        existing.createdAt = meta.createdAt;
        if (!existing.parentToolCallId && eventParentToolCallId) {
          existing.parentToolCallId = eventParentToolCallId;
        }
        existing.text += assistantDelta;
      }
      continue;
    }

    const assistantFinal = options?.threadType === "manager"
      ? null
      : parseAssistantFinalText(decoded);
    if (assistantFinal) {
      const turnKeyPrefix = eventParentToolCallId
        ? `parent:${eventParentToolCallId}:`
        : "";
      const primaryTurnKey = `${turnKeyPrefix}${decodedItemId ?? eventTurnId ?? `seq-${meta.seq}`}`;
      const fallbackTurnKey =
        decodedItemId && eventTurnId
          ? `${turnKeyPrefix}${eventTurnId}`
          : undefined;
      if (
        hasFinalizedProjectionKey(
          state.finalizedAssistantTurnKeys,
          primaryTurnKey,
          fallbackTurnKey,
        )
      ) {
        continue;
      }
      const turnKey = resolveOpenProjectionKey(
        state.openAssistantByTurn,
        primaryTurnKey,
        fallbackTurnKey,
      );
      const existing = state.openAssistantByTurn.get(turnKey);

      if (existing) {
        existing.sourceSeqEnd = meta.seq;
        existing.createdAt = meta.createdAt;
        if (!existing.parentToolCallId && eventParentToolCallId) {
          existing.parentToolCallId = eventParentToolCallId;
        }
        existing.text = assistantFinal;
        existing.status = "completed";
        state.openAssistantByTurn.delete(turnKey);
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push(existing);
        finalizeProjectionKeys(state.finalizedAssistantTurnKeys, [
          primaryTurnKey,
        ]);
      } else {
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push({
          kind: "assistant-text",
          id: messageId(decoded.threadId, "assistant", `${primaryTurnKey}:${meta.seq}`),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: assistantFinal,
          status: "completed",
        });
        finalizeProjectionKeys(state.finalizedAssistantTurnKeys, [
          primaryTurnKey,
        ]);
      }
      continue;
    }

    const reasoningDelta = options?.threadType === "manager"
      ? null
      : parseReasoningDeltaText(decoded);
    if (reasoningDelta) {
      const turnKeyPrefix = eventParentToolCallId
        ? `parent:${eventParentToolCallId}:`
        : "";
      const primaryTurnKey = `${turnKeyPrefix}${decodedItemId ?? eventTurnId ?? `seq-${meta.seq}`}`;
      const fallbackTurnKey =
        decodedItemId && eventTurnId
          ? `${turnKeyPrefix}${eventTurnId}`
          : undefined;
      if (
        hasFinalizedProjectionKey(
          state.finalizedReasoningTurnKeys,
          primaryTurnKey,
          fallbackTurnKey,
        )
      ) {
        continue;
      }

      const turnKey = resolveOpenProjectionKey(
        state.openReasoningByTurn,
        primaryTurnKey,
        fallbackTurnKey,
      );
      let existing = state.openReasoningByTurn.get(turnKey);
      if (!existing) {
        existing = {
          kind: "assistant-reasoning",
          id: messageId(decoded.threadId, "reasoning", turnKey),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: reasoningDelta,
          status: "streaming",
        };
        state.openReasoningByTurn.set(turnKey, existing);
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push(existing);
      } else {
        existing.sourceSeqEnd = meta.seq;
        existing.createdAt = meta.createdAt;
        if (!existing.parentToolCallId && eventParentToolCallId) {
          existing.parentToolCallId = eventParentToolCallId;
        }
        existing.text += reasoningDelta;
      }
      continue;
    }

    const reasoningFinal = options?.threadType === "manager"
      ? null
      : parseReasoningFinalText(decoded);
    if (reasoningFinal) {
      const turnKeyPrefix = eventParentToolCallId
        ? `parent:${eventParentToolCallId}:`
        : "";
      const primaryTurnKey = `${turnKeyPrefix}${decodedItemId ?? eventTurnId ?? `seq-${meta.seq}`}`;
      const fallbackTurnKey =
        decodedItemId && eventTurnId
          ? `${turnKeyPrefix}${eventTurnId}`
          : undefined;
      const turnKey = resolveOpenProjectionKey(
        state.openReasoningByTurn,
        primaryTurnKey,
        fallbackTurnKey,
      );
      const existing = state.openReasoningByTurn.get(turnKey);

      if (existing) {
        existing.sourceSeqEnd = meta.seq;
        existing.createdAt = meta.createdAt;
        if (!existing.parentToolCallId && eventParentToolCallId) {
          existing.parentToolCallId = eventParentToolCallId;
        }
        existing.text = reasoningFinal;
        existing.status = "completed";
        state.openReasoningByTurn.delete(turnKey);
        finalizeProjectionKeys(state.finalizedReasoningTurnKeys, [
          primaryTurnKey,
        ]);
      } else {
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push({
          kind: "assistant-reasoning",
          id: messageId(decoded.threadId, "reasoning", `${primaryTurnKey}:${meta.seq}`),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: reasoningFinal,
          status: "completed",
        });
        finalizeProjectionKeys(state.finalizedReasoningTurnKeys, [
          primaryTurnKey,
        ]);
      }
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
        onExecOutput(state, meta, execEvent.call, execEvent.appendOutput);
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
            state.delegationParentToolCallIdsByProviderThreadId.get(receiverThreadId),
          )
          .find((parentToolCallId): parentToolCallId is string =>
            typeof parentToolCallId === "string" && parentToolCallId.length > 0,
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
        onExecBegin(state, meta, decoded.threadId, eventTurnId, toolCallEvent.call);
      } else if (toolCallEvent.kind === "output") {
        onExecOutput(state, meta, toolCallEvent.call, toolCallEvent.appendOutput);
      } else {
        onExecEnd(state, meta, decoded.threadId, eventTurnId, toolCallEvent.call);
      }
      continue;
    }

    const webSearchEvent = parseWebSearchLifecycleEvent(
      decoded,
      eventParentToolCallId,
    );
    if (webSearchEvent) {
      if (webSearchEvent.kind === "begin") {
        onWebSearchBegin(state, meta, decoded.threadId, eventTurnId, webSearchEvent);
      } else {
        onWebSearchEnd(state, meta, decoded.threadId, eventTurnId, webSearchEvent);
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
      const projectedCompactionEvent = resolveProjectedCompactionEvent(
        state,
        decoded,
        compactionEvent,
      );
      if (projectedCompactionEvent.kind === "begin") {
        onCompactionBegin(
          state,
          meta,
          decoded.threadId,
          eventTurnId,
          projectedCompactionEvent,
        );
      } else {
        onCompactionEnd(
          state,
          meta,
          decoded.threadId,
          eventTurnId,
          projectedCompactionEvent,
        );
      }
      continue;
    }

    const operation = parseOperationMessage(decoded, meta, {
      includeOptionalOperations: options?.includeOptionalOperations,
    });
    if (operation) {
      flushToolActivityBeforeNonToolMessage(state);
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
        : (isIgnoredNoiseType(eventType) ||
            isIgnoredItemStartEvent(decoded) ||
            isIgnoredItemCompletedEvent(decoded))
          ? "ignored-noise"
          : "unhandled";

      if (debugReason !== "unhandled") {
        continue;
      }

      flushToolActivityBeforeNonToolMessage(state);
      appendDebugEvent(
        state.messages,
        decoded,
        meta,
        debugReason,
      );
    }
  }

  finalizePendingMessages(state, options);
  const durableMessages = sortViewMessagesBySource(compactTaskMessages(state.messages));
  return [
    ...durableMessages,
    ...materializePendingClientRequestedUserMessages({
      counts: pendingUserSignatureCounts,
      lastSourceSeq: orderedEvents[orderedEvents.length - 1]?.meta.seq ?? 0,
    }),
  ];
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
  return normalizeSemanticViewMessages(
    buildFlatViewMessages(events, options),
  );
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
