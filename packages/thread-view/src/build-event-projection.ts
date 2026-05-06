import type { ThreadEvent } from "@bb/domain";
import { requireThreadEventScopeTurnId } from "@bb/domain";
import { parseCompactionLifecycleEvent } from "./compaction-lifecycle.js";
import {
  getEventParentToolCallId,
  getEventProviderThreadId,
  getEventTurnId,
} from "./event-decode.js";
import {
  createExecLifecycleContext,
  parseExecLifecycleEvent,
  parseToolCallLifecycleEvent,
} from "./exec-lifecycle.js";
import { parseFileEditFromItemEvent } from "./file-edit-parsing.js";
import { parseWebActivityLifecycleEvent } from "./web-activity-lifecycle.js";
import { parseOperationMessage } from "./parse-operation-message.js";
import {
  parseErrorMessage,
  isDuplicateEventType,
  isIgnoredItemStartEvent,
  isIgnoredItemCompletedEvent,
  appendDebugEvent,
} from "./parse-error-message.js";
import { isIgnoredNoiseType } from "./timeline-noise-events.js";
import {
  normalizeEventProjectionMessages,
  normalizeEventProjection,
  sortEventProjectionMessagesBySource,
} from "./normalize-event-projection.js";
import { applyProjectionTurnMessageDetail } from "./apply-turn-message-detail.js";
import {
  groupEventProjectionTurns,
  getOrderedThreadEvents,
  type ThreadEventWithMeta,
} from "./group-event-projection-turns.js";
export type { ThreadEventWithMeta } from "./group-event-projection-turns.js";
import { shouldSuppressLowValueToolCall } from "./tool-call-suppression.js";
import {
  buildAcceptedClientRequestById,
  parseAcceptedSteerFromClientRequest,
  parseUserFromClientRequest,
  parseManagerUserMessage,
} from "./user-message-parsing.js";
import { isTerminalBufferedTextFlushEvent } from "./assistant-buffering.js";
import {
  flushToolActivityBeforeNonToolMessage,
  onExecBegin,
  onExecEnd,
  onExecOutput,
  onWebActivityBegin,
  onWebActivityEnd,
} from "./tool-activity-projection.js";
import {
  finalizeOpenCompactionsForTurn,
  onCompactionBegin,
  onCompactionEnd,
  upsertPermissionGrantLifecycleMessage,
  upsertFileEdit,
  upsertProvisioningOperation,
  upsertThreadOperationMessage,
} from "./operation-projection.js";
import type { ActiveThinking } from "@bb/domain";
import type {
  BuildEventProjectionMessagesOptions,
  BuildEventProjectionOptions,
  EventProjectionMessage,
  EventProjection,
} from "./event-projection-types.js";
import {
  createProjectionState,
  finalizeProjectionState,
  flushProjectionBufferedOutputs,
  onThreadInterrupted,
  onTurnCompleted,
  onTurnStarted,
  type CompactionTurnFinalization,
  type ProjectionState,
} from "./event-projection-state.js";
import { buildProjectionActiveThinking } from "./reasoning-lifecycle-projection.js";
import { projectAssistantAndReasoningEvent } from "./assistant-event-projection.js";

// --- Projection state machine ---

type ProjectedUserMessage = Extract<EventProjectionMessage, { kind: "user" }>;
interface ClientTurnRequestedWithMeta {
  event: Extract<ThreadEvent, { type: "client/turn/requested" }>;
  meta: ThreadEventWithMeta["meta"];
}

interface BuildFlatProjectionDataArgs {
  events: ThreadEventWithMeta[];
  includeActiveThinking: boolean;
  options?: BuildEventProjectionMessagesOptions;
}

interface BuildFlatProjectionDataResult {
  activeThinking: ActiveThinking | null;
  messages: EventProjectionMessage[];
}

interface BuildDetailedProjectionArgs {
  activeThinking: ActiveThinking | null;
  events: ThreadEventWithMeta[];
  messages: EventProjectionMessage[];
  turnMessageDetail: BuildEventProjectionOptions["turnMessageDetail"];
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

function buildClientTurnRequestById(
  events: ThreadEventWithMeta[],
): Map<string, ClientTurnRequestedWithMeta> {
  const requestById = new Map<string, ClientTurnRequestedWithMeta>();
  for (const eventWithMeta of events) {
    if (eventWithMeta.event.type !== "client/turn/requested") {
      continue;
    }
    requestById.set(eventWithMeta.event.requestId, {
      event: eventWithMeta.event,
      meta: eventWithMeta.meta,
    });
  }
  return requestById;
}

function appendProjectedUserMessage(
  state: ProjectionState,
  projectedClientUser: ProjectedUserMessage,
): void {
  const key = projectedClientUser.id;
  if (state.seenUserKeys.has(key)) {
    return;
  }
  state.seenUserKeys.add(key);
  flushToolActivityBeforeNonToolMessage(state);
  state.messages.push(projectedClientUser);
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

// --- Main entry point ---

function buildFlatProjectionData(
  args: BuildFlatProjectionDataArgs,
): BuildFlatProjectionDataResult {
  const state = createProjectionState({
    nowMs: args.options?.nowMs ?? Date.now(),
  });
  const includeDebugRawEvents = args.options?.includeDebugRawEvents ?? false;
  const shouldTrackActiveThinking = args.includeActiveThinking;

  const orderedEvents = args.events;
  const acceptedClientRequestById =
    buildAcceptedClientRequestById(orderedEvents);
  const clientRequestById = buildClientTurnRequestById(orderedEvents);
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

    if (decoded.type === "turn/started") {
      onTurnStarted(
        state,
        requireThreadEventScopeTurnId({
          type: decoded.type,
          scope: decoded.scope,
        }),
      );
    }

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
      if (decoded.type === "turn/completed") {
        onTurnCompleted({
          state,
          turnId: requireThreadEventScopeTurnId({
            type: decoded.type,
            scope: decoded.scope,
          }),
          status: decoded.status,
        });
      } else {
        onThreadInterrupted(state);
      }
      flushProjectionBufferedOutputs(state);
    }

    if (decoded.type === "turn/input/accepted") {
      const clientRequest = clientRequestById.get(decoded.clientRequestId);
      const acceptedClientRequest = acceptedClientRequestById.get(
        decoded.clientRequestId,
      );
      const acceptedSteer =
        clientRequest && acceptedClientRequest
          ? parseAcceptedSteerFromClientRequest({
              acceptedClientRequest,
              decoded: clientRequest.event,
              meta: clientRequest.meta,
              options: args.options,
            })
          : null;
      if (acceptedSteer) {
        appendProjectedUserMessage(state, acceptedSteer);
      }
      continue;
    }

    const userFromClientRequest = parseUserFromClientRequest({
      acceptedClientRequest:
        decoded.type === "client/turn/requested"
          ? acceptedClientRequestById.get(decoded.requestId)
          : undefined,
      decoded,
      meta,
      options: args.options,
    });
    if (userFromClientRequest) {
      appendProjectedUserMessage(state, userFromClientRequest);
      continue;
    }

    const managerUserMessage = parseManagerUserMessage(decoded, meta);
    if (managerUserMessage) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(managerUserMessage);
      continue;
    }

    if (
      projectAssistantAndReasoningEvent({
        decoded,
        eventParentToolCallId,
        eventTurnId,
        meta,
        options: args.options,
        shouldTrackActiveThinking,
        state,
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
          execEvent.output,
          execEvent.appendOutput,
          execEvent.replaceOutput,
        );
      } else {
        onExecEnd(state, meta, decoded.threadId, eventTurnId, execEvent.call);
      }
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
      if (toolCallEvent.kind !== "output") {
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
          toolCallEvent.output,
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
      includeProviderUnhandledOperations:
        args.options?.includeProviderUnhandledOperations,
      includeOptionalOperations: args.options?.includeOptionalOperations,
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

  finalizeProjectionState({ state, options: args.options });
  return {
    activeThinking: args.includeActiveThinking
      ? buildProjectionActiveThinking(state, args.options?.threadStatus)
      : null,
    messages: sortEventProjectionMessagesBySource(state.messages),
  };
}

function buildDetailedProjection(
  args: BuildDetailedProjectionArgs,
): EventProjection {
  const projection = groupEventProjectionTurns({
    events: args.events,
    messages: args.messages,
  });
  const semanticProjection = normalizeEventProjection({
    ...projection,
    state: {
      activeThinking: args.activeThinking,
    },
  });
  return applyProjectionTurnMessageDetail(
    semanticProjection,
    args.turnMessageDetail,
  );
}

function buildFullEventProjection(
  events: ThreadEventWithMeta[],
  options: BuildEventProjectionOptions,
): EventProjection {
  const flatProjection = buildFlatProjectionData({
    events,
    includeActiveThinking: true,
    options,
  });
  return buildDetailedProjection({
    activeThinking: flatProjection.activeThinking,
    events,
    messages: flatProjection.messages,
    turnMessageDetail: options.turnMessageDetail,
  });
}

export function buildEventProjectionMessages(
  events: ThreadEventWithMeta[] | undefined,
  options?: BuildEventProjectionMessagesOptions,
): EventProjectionMessage[] {
  if (!events || events.length === 0) {
    return [];
  }

  const orderedEvents = getOrderedThreadEvents(events);
  return normalizeEventProjectionMessages(
    buildFlatProjectionData({
      events: orderedEvents,
      includeActiveThinking: false,
      options,
    }).messages,
  );
}

export function buildEventProjectionEntries(
  events: ThreadEventWithMeta[] | undefined,
  options: BuildEventProjectionOptions,
): EventProjection {
  if (!events || events.length === 0) {
    return {
      state: {
        activeThinking: null,
      },
      entries: [],
    };
  }

  const orderedEvents = getOrderedThreadEvents(events);
  const flatProjection = buildFlatProjectionData({
    events: orderedEvents,
    includeActiveThinking: false,
    options,
  });
  return buildDetailedProjection({
    activeThinking: null,
    events: orderedEvents,
    messages: flatProjection.messages,
    turnMessageDetail: options.turnMessageDetail,
  });
}

export function buildEventProjection(
  events: ThreadEventWithMeta[] | undefined,
  options: BuildEventProjectionOptions,
): EventProjection {
  if (!events || events.length === 0) {
    return {
      state: {
        activeThinking: null,
      },
      entries: [],
    };
  }

  const orderedEvents = getOrderedThreadEvents(events);
  return buildFullEventProjection(orderedEvents, options);
}
