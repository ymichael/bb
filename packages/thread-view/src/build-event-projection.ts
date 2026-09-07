import type { ThreadEvent } from "@bb/domain";
import {
  isBackgroundAgentTaskType,
  isBackgroundCommandTaskType,
  LOCAL_WORKFLOW_TASK_TYPE,
  requireThreadEventScopeTurnId,
} from "@bb/domain";
import { parseCompactionLifecycleEvent } from "./compaction-lifecycle.js";
import {
  parseBackgroundTaskLifecycleEvent,
  upsertBackgroundTaskMessage,
} from "./background-task-projection.js";
import {
  getEventParentToolCallId,
  getEventProviderThreadId,
  getEventTurnId,
} from "./event-decode.js";
import {
  parseExecLifecycleEvent,
  parseToolCallLifecycleEvent,
} from "./exec-lifecycle.js";
import { parseFileEditFromItemEvent } from "./file-edit-parsing.js";
import { parseWebActivityLifecycleEvent } from "./web-activity-lifecycle.js";
import { parseOperationMessage } from "./parse-operation-message.js";
import { parseErrorMessage } from "./parse-error-message.js";
import {
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
  EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
  type AcceptedClientRequest,
  type AcceptedClientRequestContext,
} from "./accepted-client-request-context.js";
import {
  parseAcceptedSteersFromClientRequest,
  parseRejectedUsersFromClientRequest,
  parseUsersFromClientRequest,
  parseLegacyUserMessage,
  parseProviderUserMessage,
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
  upsertUserQuestionLifecycleMessage,
  upsertFileEdit,
  upsertProvisioningOperation,
  upsertThreadOperationMessage,
} from "./operation-projection.js";
import type { ActiveThinking } from "@bb/domain";
import type {
  BuildEventProjectionMessagesOptions,
  BuildEventProjectionOptions,
  EventProjectionMessage,
  EventProjectionWorkflowMessage,
  EventProjection,
} from "./event-projection-types.js";
import { getMessageStartedAt } from "./format-helpers.js";
import {
  createProjectionState,
  finalizeProjectionState,
  flushProjectionBufferedOutputs,
  flushProjectionBufferedOutputsAfterTurnCompleted,
  onThreadInterrupted,
  onTurnCompleted,
  onTurnStarted,
  type CompactionTurnFinalization,
  type PendingDelegationTurnLink,
  type ProjectionState,
} from "./event-projection-state.js";
import { buildProjectionActiveThinking } from "./reasoning-lifecycle-projection.js";
import { projectAssistantAndReasoningEvent } from "./assistant-event-projection.js";

type ProjectedUserMessage = Extract<EventProjectionMessage, { kind: "user" }>;
interface ClientTurnRequestedWithMeta {
  event: Extract<ThreadEvent, { type: "client/turn/requested" }>;
  meta: ThreadEventWithMeta["meta"];
}

type ClientTurnRequestedEvent = Extract<
  ThreadEvent,
  { type: "client/turn/requested" }
>;

interface BuildFlatProjectionDataArgs {
  acceptedClientRequestContext: AcceptedClientRequestContext;
  events: ThreadEventWithMeta[];
  includeActiveThinking: boolean;
  options?: BuildEventProjectionMessagesOptions;
}

interface BuildFlatProjectionDataResult {
  activeThinking: ActiveThinking | null;
  activeWorkflows: EventProjectionWorkflowMessage[];
  activeBackgroundCommands: EventProjectionWorkflowMessage[];
  messages: EventProjectionMessage[];
}

interface BuildDetailedProjectionArgs {
  activeThinking: ActiveThinking | null;
  activeWorkflows: EventProjectionWorkflowMessage[];
  activeBackgroundCommands: EventProjectionWorkflowMessage[];
  contextOnlyToolCallIds?: ReadonlySet<string>;
  events: ThreadEventWithMeta[];
  messages: EventProjectionMessage[];
  turnMessageDetail: BuildEventProjectionOptions["turnMessageDetail"];
}

function selectActiveWorkflowMessages(
  messages: readonly EventProjectionMessage[],
): EventProjectionWorkflowMessage[] {
  const running: EventProjectionWorkflowMessage[] = [];
  for (const message of messages) {
    if (
      message.kind !== "workflow" ||
      message.taskType !== LOCAL_WORKFLOW_TASK_TYPE ||
      message.status !== "pending" ||
      message.skipTranscript
    ) {
      continue;
    }
    running.push(message);
  }
  return running.sort(
    (a, b) => getMessageStartedAt(b) - getMessageStartedAt(a),
  );
}

type EventProjectionCallMessage = Extract<
  EventProjectionMessage,
  { callId: string }
>;

function isEventProjectionCallMessage(
  message: EventProjectionMessage,
): message is EventProjectionCallMessage {
  switch (message.kind) {
    case "command":
    case "delegation":
    case "extension":
    case "file-edit":
    case "file-read":
    case "image-view":
    case "plan-steps":
    case "search":
    case "tool-call":
    case "web-fetch":
    case "web-search":
      return true;
    case "assistant-text":
    case "error":
    case "operation":
    case "permission-grant-lifecycle":
    case "user":
    case "user-question-lifecycle":
    case "workflow":
      return false;
  }
}

function buildCallMessageById(
  messages: readonly EventProjectionMessage[],
): ReadonlyMap<string, EventProjectionCallMessage> {
  const byId = new Map<string, EventProjectionCallMessage>();
  for (const message of messages) {
    if (!isEventProjectionCallMessage(message)) {
      continue;
    }
    byId.set(message.callId, message);
  }
  return byId;
}

function isDirectBackgroundTaskForCurrentAgent(
  message: EventProjectionWorkflowMessage,
  callMessageById: ReadonlyMap<string, EventProjectionCallMessage>,
): boolean {
  if (!message.parentToolCallId) {
    return true;
  }
  const spawningCall = callMessageById.get(message.parentToolCallId);
  return spawningCall ? spawningCall.parentToolCallId === undefined : true;
}

function getBackgroundAgentModel(
  message: EventProjectionWorkflowMessage,
  callMessageById: ReadonlyMap<string, EventProjectionCallMessage>,
): string | null {
  if (
    !isBackgroundAgentTaskType(message.taskType) ||
    !message.parentToolCallId
  ) {
    return null;
  }
  const spawningCall = callMessageById.get(message.parentToolCallId);
  return spawningCall?.kind === "delegation"
    ? (spawningCall.model ?? null)
    : null;
}

function getBackgroundTaskFamilyId(
  message: EventProjectionWorkflowMessage,
): string {
  if (message.familyId !== null) {
    return `family:${message.familyId}`;
  }
  const itemId = message.itemId;
  const generationMatch = /#(\d+)$/.exec(itemId);
  if (!generationMatch) {
    return itemId;
  }
  const generation = Number(generationMatch[1]);
  return Number.isSafeInteger(generation) && generation > 1
    ? itemId.slice(0, -generationMatch[0].length)
    : itemId;
}

function enrichBackgroundAgentModels(
  messages: readonly EventProjectionMessage[],
  callMessageById: ReadonlyMap<string, EventProjectionCallMessage>,
): void {
  const modelByTaskFamilyId = new Map<string, string>();
  for (const message of messages) {
    if (
      message.kind !== "workflow" ||
      !isBackgroundAgentTaskType(message.taskType)
    ) {
      continue;
    }

    const taskFamilyId = getBackgroundTaskFamilyId(message);
    const model =
      getBackgroundAgentModel(message, callMessageById) ??
      message.model ??
      modelByTaskFamilyId.get(taskFamilyId) ??
      null;
    message.model = model;
    if (model !== null) {
      modelByTaskFamilyId.set(taskFamilyId, model);
    }
  }
}

function getRootSpawningCallId(
  message: EventProjectionWorkflowMessage,
  callMessageById: ReadonlyMap<string, EventProjectionCallMessage>,
): string | undefined {
  let callId = message.parentToolCallId;
  const visited = new Set<string>();
  while (callId && !visited.has(callId)) {
    visited.add(callId);
    const call = callMessageById.get(callId);
    if (!call?.parentToolCallId) {
      return callId;
    }
    callId = call.parentToolCallId;
  }
  return undefined;
}

function selectActiveBackgroundCommandMessages(
  messages: readonly EventProjectionMessage[],
  callMessageById: ReadonlyMap<string, EventProjectionCallMessage>,
): EventProjectionWorkflowMessage[] {
  const representedRootCallIds = new Set<string>();
  for (const message of messages) {
    if (
      message.kind === "workflow" &&
      message.status === "pending" &&
      !message.skipTranscript &&
      message.parentToolCallId &&
      isDirectBackgroundTaskForCurrentAgent(message, callMessageById)
    ) {
      representedRootCallIds.add(message.parentToolCallId);
    }
  }
  const running: EventProjectionWorkflowMessage[] = [];
  for (const message of messages) {
    const isDirect =
      message.kind === "workflow" &&
      isDirectBackgroundTaskForCurrentAgent(message, callMessageById);
    const rootSpawningCallId =
      message.kind === "workflow"
        ? getRootSpawningCallId(message, callMessageById)
        : undefined;
    const isRepresentedByActiveParent =
      !isDirect &&
      rootSpawningCallId !== undefined &&
      representedRootCallIds.has(rootSpawningCallId);
    if (
      message.kind !== "workflow" ||
      message.taskType === LOCAL_WORKFLOW_TASK_TYPE ||
      message.status !== "pending" ||
      message.skipTranscript ||
      isRepresentedByActiveParent ||
      (!isDirect && !isBackgroundCommandTaskType(message.taskType))
    ) {
      continue;
    }
    running.push(message);
  }
  return running.sort(
    (a, b) => getMessageStartedAt(b) - getMessageStartedAt(a),
  );
}

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

function buildRejectedClientRequestIds(
  events: ThreadEventWithMeta[],
): ReadonlySet<string> {
  const requestIds = new Set<string>();
  for (const { event } of events) {
    if (event.type === "client/turn/rejected") {
      requestIds.add(event.requestId);
    }
  }
  return requestIds;
}

function buildSelectedStartedTurnIds(
  events: ThreadEventWithMeta[],
): ReadonlySet<string> {
  const turnIds = new Set<string>();
  for (const { event } of events) {
    if (event.type !== "turn/started") {
      continue;
    }
    turnIds.add(
      requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      }),
    );
  }
  return turnIds;
}

function buildAcceptedRootClientTurnIds(
  events: ThreadEventWithMeta[],
  clientRequestById: ReadonlyMap<string, ClientTurnRequestedWithMeta>,
): ReadonlySet<string> {
  const turnIds = new Set<string>();
  for (const { event } of events) {
    if (event.type !== "turn/input/accepted") {
      continue;
    }
    const request = clientRequestById.get(event.clientRequestId);
    if (
      request?.event.target.kind !== "new-turn" &&
      request?.event.target.kind !== "thread-start"
    ) {
      continue;
    }
    turnIds.add(
      requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      }),
    );
  }
  return turnIds;
}

function canUseAcceptedClientRequestForVisibleProjection(
  acceptedClientRequest: AcceptedClientRequest,
  decoded: ClientTurnRequestedEvent,
  selectedStartedTurnIds: ReadonlySet<string>,
): boolean {
  switch (decoded.target.kind) {
    case "auto":
    case "steer":
      if (decoded.target.expectedTurnId === null) {
        return true;
      }
      if (acceptedClientRequest.turnId === decoded.target.expectedTurnId) {
        return true;
      }
      return selectedStartedTurnIds.has(acceptedClientRequest.turnId);
    case "new-turn":
    case "thread-start":
      return true;
  }
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

function getDelegationChildRef(decoded: ThreadEvent): string | undefined {
  return (decoded.type === "item/started" ||
    decoded.type === "item/completed" ||
    decoded.type === "item/delegation/progress" ||
    decoded.type === "item/delegation/completed") &&
    decoded.item.type === "delegation"
    ? decoded.item.childRef
    : undefined;
}

function enqueuePendingDelegationTurnLink(
  state: ProjectionState,
  providerThreadId: string | undefined,
  parentTurnId: string | undefined,
  callId: string,
): void {
  if (!providerThreadId || !parentTurnId) {
    return;
  }
  if (state.delegatedTurnLinkCallIds.has(callId)) {
    return;
  }

  const pendingLinks =
    state.pendingDelegationTurnLinksByProviderThreadId.get(providerThreadId) ??
    [];
  const link: PendingDelegationTurnLink = {
    callId,
    parentTurnId,
  };
  pendingLinks.push(link);
  state.pendingDelegationTurnLinksByProviderThreadId.set(
    providerThreadId,
    pendingLinks,
  );
  state.delegatedTurnLinkCallIds.add(callId);
}

function consumePendingDelegationTurnLink(
  state: ProjectionState,
  providerThreadId: string | undefined,
  turnId: string,
): string | undefined {
  if (!providerThreadId) {
    return undefined;
  }
  if (state.delegationParentToolCallIdsByTurnId.has(turnId)) {
    return state.delegationParentToolCallIdsByTurnId.get(turnId);
  }

  const pendingLinks =
    state.pendingDelegationTurnLinksByProviderThreadId.get(providerThreadId);
  if (!pendingLinks || pendingLinks.length === 0) {
    return undefined;
  }

  while (pendingLinks.length > 0) {
    const pendingLink = pendingLinks.shift();
    if (!pendingLink || pendingLink.parentTurnId === turnId) {
      continue;
    }
    if (pendingLinks.length === 0) {
      state.pendingDelegationTurnLinksByProviderThreadId.delete(
        providerThreadId,
      );
    }
    state.delegationParentToolCallIdsByTurnId.set(turnId, pendingLink.callId);
    return pendingLink.callId;
  }

  state.pendingDelegationTurnLinksByProviderThreadId.delete(providerThreadId);
  return undefined;
}

function shouldUseExplicitEventParentToolCallId({
  eventTurnId,
  isAcceptedRootClientTurn,
  parentToolCallId,
  state,
}: {
  eventTurnId: string | undefined;
  isAcceptedRootClientTurn: boolean;
  parentToolCallId: string | undefined;
  state: ProjectionState;
}): boolean {
  if (!parentToolCallId) {
    return false;
  }
  if (!isAcceptedRootClientTurn) {
    return true;
  }
  return (
    typeof eventTurnId !== "string" ||
    state.suppressedAcceptedRootParentToolCallIdsByTurnId.get(eventTurnId) !==
      parentToolCallId
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
  if (
    decoded.type === "provider/warning" &&
    decoded.category === "compaction-skipped"
  ) {
    return {
      status: "completed",
      detail: decoded.details ?? decoded.summary,
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

function buildFlatProjectionData(
  args: BuildFlatProjectionDataArgs,
): BuildFlatProjectionDataResult {
  const state = createProjectionState();

  const orderedEvents = args.events;
  const acceptedClientRequestById = buildAcceptedClientRequestById({
    context: args.acceptedClientRequestContext,
    events: orderedEvents,
  });
  const clientRequestById = buildClientTurnRequestById(orderedEvents);
  const rejectedClientRequestIds = buildRejectedClientRequestIds(orderedEvents);
  const selectedStartedTurnIds = buildSelectedStartedTurnIds(orderedEvents);
  const acceptedRootClientTurnIds = buildAcceptedRootClientTurnIds(
    orderedEvents,
    clientRequestById,
  );
  for (const { event: decoded, meta } of orderedEvents) {
    const eventType = decoded.type;
    const eventTurnId = getEventTurnId(decoded);
    const eventProviderThreadId = getEventProviderThreadId(decoded);
    const isAcceptedRootClientTurn =
      typeof eventTurnId === "string" &&
      acceptedRootClientTurnIds.has(eventTurnId);
    const decodedEventParentToolCallId = getEventParentToolCallId(decoded);
    if (
      decoded.type === "turn/started" &&
      isAcceptedRootClientTurn &&
      decodedEventParentToolCallId
    ) {
      state.suppressedAcceptedRootParentToolCallIdsByTurnId.set(
        eventTurnId,
        decodedEventParentToolCallId,
      );
    }
    const explicitEventParentToolCallId =
      shouldUseExplicitEventParentToolCallId({
        eventTurnId,
        isAcceptedRootClientTurn,
        parentToolCallId: decodedEventParentToolCallId,
        state,
      })
        ? decodedEventParentToolCallId
        : undefined;

    if (decoded.type === "turn/started") {
      const turnId = requireThreadEventScopeTurnId({
        type: decoded.type,
        scope: decoded.scope,
      });
      if (isAcceptedRootClientTurn) {
        state.delegationParentToolCallIdsByTurnId.delete(turnId);
      } else {
        const pendingParentToolCallId = consumePendingDelegationTurnLink(
          state,
          eventProviderThreadId,
          turnId,
        );
        if (explicitEventParentToolCallId) {
          state.delegationParentToolCallIdsByTurnId.set(
            turnId,
            explicitEventParentToolCallId,
          );
        } else if (pendingParentToolCallId) {
          state.delegationParentToolCallIdsByTurnId.set(
            turnId,
            pendingParentToolCallId,
          );
        }
      }
      onTurnStarted(state, turnId);
    }

    const eventParentToolCallId = isAcceptedRootClientTurn
      ? explicitEventParentToolCallId
      : (explicitEventParentToolCallId ??
        (eventTurnId
          ? state.delegationParentToolCallIdsByTurnId.get(eventTurnId)
          : undefined) ??
        (eventProviderThreadId
          ? state.delegationParentToolCallIdsByProviderThreadId.get(
              eventProviderThreadId,
            )
          : undefined));

    const compactionTurnFinalization = getCompactionTurnFinalization(decoded);
    if (compactionTurnFinalization) {
      const settledPendingCompaction = finalizeOpenCompactionsForTurn({
        state,
        meta,
        threadId: decoded.threadId,
        turnId: eventTurnId,
        status: compactionTurnFinalization.status,
        detail: compactionTurnFinalization.detail,
      });
      if (settledPendingCompaction && decoded.type === "provider/warning") {
        continue;
      }
    }

    if (isTerminalBufferedTextFlushEvent(eventType)) {
      if (decoded.type === "turn/completed") {
        const completedTurnId = requireThreadEventScopeTurnId({
          type: decoded.type,
          scope: decoded.scope,
        });
        onTurnCompleted({
          meta,
          state,
          turnId: completedTurnId,
          status: decoded.status,
        });
        flushProjectionBufferedOutputsAfterTurnCompleted(
          state,
          completedTurnId,
        );
      } else {
        onThreadInterrupted({
          meta,
          state,
          threadId: decoded.threadId,
        });
        flushProjectionBufferedOutputs(state);
      }
    }

    if (decoded.type === "turn/input/accepted") {
      const clientRequest = clientRequestById.get(decoded.clientRequestId);
      const acceptedClientRequest = acceptedClientRequestById.get(
        decoded.clientRequestId,
      );
      const acceptedSteers =
        clientRequest && acceptedClientRequest
          ? parseAcceptedSteersFromClientRequest({
              acceptedClientRequest,
              decoded: clientRequest.event,
              meta: clientRequest.meta,
              options: args.options,
            })
          : [];
      for (const acceptedSteer of acceptedSteers) {
        appendProjectedUserMessage(state, acceptedSteer);
      }
      continue;
    }

    if (decoded.type === "client/turn/rejected") {
      const clientRequest = clientRequestById.get(decoded.requestId);
      if (clientRequest) {
        for (const rejectedMessage of parseRejectedUsersFromClientRequest({
          decoded: clientRequest.event,
          meta,
          options: args.options,
        })) {
          appendProjectedUserMessage(state, rejectedMessage);
        }
      }
      continue;
    }

    if (
      decoded.type === "client/turn/requested" &&
      rejectedClientRequestIds.has(decoded.requestId)
    ) {
      continue;
    }

    const acceptedClientRequest =
      decoded.type === "client/turn/requested"
        ? acceptedClientRequestById.get(decoded.requestId)
        : undefined;
    const visibleProjectionAcceptedClientRequest =
      acceptedClientRequest &&
      decoded.type === "client/turn/requested" &&
      canUseAcceptedClientRequestForVisibleProjection(
        acceptedClientRequest,
        decoded,
        selectedStartedTurnIds,
      )
        ? acceptedClientRequest
        : undefined;
    const usersFromClientRequest = parseUsersFromClientRequest({
      acceptedClientRequest: visibleProjectionAcceptedClientRequest,
      decoded,
      meta,
      options: args.options,
    });
    if (usersFromClientRequest.length > 0) {
      for (const userFromClientRequest of usersFromClientRequest) {
        appendProjectedUserMessage(state, userFromClientRequest);
      }
      continue;
    }

    const providerUserMessage = parseProviderUserMessage(decoded, meta);
    if (providerUserMessage) {
      appendProjectedUserMessage(state, providerUserMessage);
      continue;
    }

    const legacyUserMessage = parseLegacyUserMessage(decoded, meta);
    if (legacyUserMessage) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(legacyUserMessage);
      continue;
    }

    if (
      projectAssistantAndReasoningEvent({
        decoded,
        eventParentToolCallId,
        eventTurnId,
        meta,
        state,
      })
    ) {
      continue;
    }

    if (parseBackgroundTaskLifecycleEvent(decoded)) {
      flushToolActivityBeforeNonToolMessage(state);
      upsertBackgroundTaskMessage(state, meta, decoded);
      continue;
    }

    const execEvent = parseExecLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
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
    );
    if (toolCallEvent) {
      const delegationChildRef = getDelegationChildRef(decoded);
      if (toolCallEvent.kind !== "output") {
        if (toolCallEvent.call.kind === "delegation" && eventTurnId) {
          state.delegationTurnIdsByCallId.set(
            toolCallEvent.call.callId,
            eventTurnId,
          );
        }
        if (delegationChildRef !== undefined) {
          if (
            delegationChildRef === eventProviderThreadId ||
            state.delegatedTurnLinkCallIds.has(toolCallEvent.call.callId)
          ) {
            enqueuePendingDelegationTurnLink(
              state,
              eventProviderThreadId,
              eventTurnId,
              toolCallEvent.call.callId,
            );
          } else {
            state.delegationParentToolCallIdsByProviderThreadId.set(
              delegationChildRef,
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
      providerDisplayName: args.options?.providerDisplayName,
      threadName: args.options?.threadName ?? "",
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
      if (operation.kind === "user-question-lifecycle") {
        upsertUserQuestionLifecycleMessage(state, operation);
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
  }

  finalizeProjectionState({ state, options: args.options });
  const messages = sortEventProjectionMessagesBySource(state.messages);
  const callMessageById = buildCallMessageById(messages);
  enrichBackgroundAgentModels(messages, callMessageById);
  return {
    activeThinking: args.includeActiveThinking
      ? buildProjectionActiveThinking(state, args.options?.threadStatus)
      : null,
    activeWorkflows: selectActiveWorkflowMessages(messages),
    activeBackgroundCommands: selectActiveBackgroundCommandMessages(
      messages,
      callMessageById,
    ),
    messages,
  };
}

function buildDetailedProjection(
  args: BuildDetailedProjectionArgs,
): EventProjection {
  const projection = groupEventProjectionTurns({
    events: args.events,
    messages: args.messages,
  });
  const semanticProjection = normalizeEventProjection(
    {
      ...projection,
      state: {
        activeThinking: args.activeThinking,
        activeWorkflows: args.activeWorkflows,
        activeBackgroundCommands: args.activeBackgroundCommands,
      },
    },
    {
      contextOnlyToolCallIds: args.contextOnlyToolCallIds,
    },
  );
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
    acceptedClientRequestContext:
      options.acceptedClientRequestContext ??
      EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
    events,
    includeActiveThinking: true,
    options,
  });
  return buildDetailedProjection({
    activeThinking: flatProjection.activeThinking,
    activeWorkflows: flatProjection.activeWorkflows,
    activeBackgroundCommands: flatProjection.activeBackgroundCommands,
    contextOnlyToolCallIds: options.contextOnlyToolCallIds,
    events,
    messages: flatProjection.messages,
    turnMessageDetail: options.turnMessageDetail,
  });
}

export function buildEventProjectionEntries(
  events: ThreadEventWithMeta[] | undefined,
  options: BuildEventProjectionOptions,
): EventProjection {
  if (!events || events.length === 0) {
    return {
      state: {
        activeThinking: null,
        activeWorkflows: [],
        activeBackgroundCommands: [],
      },
      entries: [],
    };
  }

  const orderedEvents = getOrderedThreadEvents(events);
  const flatProjection = buildFlatProjectionData({
    acceptedClientRequestContext:
      options.acceptedClientRequestContext ??
      EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
    events: orderedEvents,
    includeActiveThinking: false,
    options,
  });
  return buildDetailedProjection({
    activeThinking: null,
    activeWorkflows: flatProjection.activeWorkflows,
    activeBackgroundCommands: flatProjection.activeBackgroundCommands,
    contextOnlyToolCallIds: options.contextOnlyToolCallIds,
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
        activeWorkflows: [],
        activeBackgroundCommands: [],
      },
      entries: [],
    };
  }

  const orderedEvents = getOrderedThreadEvents(events);
  return buildFullEventProjection(orderedEvents, options);
}
