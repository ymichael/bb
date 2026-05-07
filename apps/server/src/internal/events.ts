import {
  appendDaemonEventsInTransaction,
  archiveThread,
  getAutomation,
  deriveStoredEventItemFields,
  getThread,
  listCompletedTurnsByThreadIds,
  listThreadEnvironmentAssignmentsOnHost,
  MissingStoredTurnStartedError,
  ProducerEventPayloadMismatchError,
  updateThread,
} from "@bb/db";
import type {
  AcceptedDaemonEvent,
  AppendDaemonEventInput,
  AppendDaemonEventsResult,
} from "@bb/db";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonEventBatchRequestSchema,
  typedRoutes,
  type HostDaemonEventBatchResponse,
  type HostDaemonEventEnvelope,
  type HostDaemonInternalSchema,
  type HostDaemonRejectedEvent,
} from "@bb/host-daemon-contract";
import {
  canonicalizeProducerEventPayload,
  requireThreadEventScopeTurnId,
} from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import type { Hono } from "hono";
import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../types.js";
import {
  isAgePrunableThreadEventType,
  maybePruneActiveThreadEventHistory,
} from "../services/system/event-pruning.js";
import { markSandboxActivity } from "../services/hosts/host-lifecycle.js";
import {
  requestEnvironmentCleanup,
  wouldCleanupEnvironment,
} from "../services/environments/environment-cleanup.js";
import { syncManagerThreadSchedules } from "../services/scheduling/manager-schedule-sync.js";
import { queueManagerSystemMessage } from "../services/threads/manager-system-messages.js";
import { runQueuedDraftAutoSendForThread } from "../services/threads/queued-drafts.js";
import { queueSettledArchivedThreadProviderArchiveCommand } from "../services/threads/thread-lifecycle.js";
import {
  runWithDaemonCommandWaitForbidden,
  scheduleAfterDaemonIngressResponse,
} from "../services/hosts/command-wait-context.js";
import { isPreStartThreadStatus } from "../services/threads/thread-status.js";
import { tryTransition } from "../services/threads/thread-transitions.js";
import { getAuthenticatedDaemon } from "./auth.js";
import { applyTurnCompletedEvent } from "./turn-completed-events.js";
import { requireAuthorizedActiveSession } from "./session-state.js";

interface ToStoredEventArgs {
  envelope: HostDaemonEventEnvelope;
  environmentId: string;
}

interface ResolvePostableEventBatchEntriesArgs {
  hostId: string;
  events: HostDaemonEventEnvelope[];
}

interface PostableEventBatchEntry {
  envelope: HostDaemonEventEnvelope;
  environmentId: string;
}

interface ResolvePostableEventBatchEntriesResult {
  entries: PostableEventBatchEntry[];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
}

interface RejectedDaemonEventSummary {
  count: number;
  threadIds: string[];
}

interface ResolveEventsToApplyArgs {
  db: AppDeps["db"];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
}

interface AppendDaemonEventInputsAtomicallyDeps {
  db: AppDeps["db"];
}

interface AppendDaemonEventInputsAtomicallyArgs {
  eventInputs: AppendDaemonEventInput[];
}

interface NotifyInsertedEventThreadsDeps {
  hub: AppDeps["hub"];
}

interface NotifyInsertedEventThreadsArgs {
  eventInputs: AppendDaemonEventInput[];
  insertedInputIndexes: number[];
}

interface ShouldApplyEventEffectArgs {
  completedTurnKeyLookup: Set<string>;
  entry: HostDaemonEventEnvelope;
  index: number;
  insertedEventIndexLookup: Set<number>;
}

interface TurnKeyArgs {
  threadId: string;
  turnId: string;
}

interface ActivePruneCandidate {
  latestPrunableSequence: number;
  threadId: string;
}

interface ResolveActivePruneCandidatesArgs {
  acceptedEvents: AcceptedDaemonEvent[];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
}

type CompletedTurnStatus = Extract<
  HostDaemonEventEnvelope["event"],
  { type: "turn/completed" }
>["status"];

interface ArchiveCompletedAutomationThreadIfNeededArgs {
  latestThread: NonNullable<ReturnType<typeof getThread>>;
  turnStatus: CompletedTurnStatus;
}

interface QueueManagedThreadTurnNotificationArgs {
  managedThreadId: string;
  managerThreadId: string;
  turnStatus: CompletedTurnStatus;
  title: string | null;
}

interface RenderManagedThreadTurnStatusMessageArgs {
  managedThreadId: string;
  title: string | null;
  turnStatus: CompletedTurnStatus;
}

interface ManagerScheduleSyncFollowUp {
  kind: "manager-schedule-sync";
  threadId: string;
}

interface ManagerTurnNotificationFollowUp {
  kind: "manager-turn-notification";
  managedThreadId: string;
  managerThreadId: string;
  title: string | null;
  turnStatus: CompletedTurnStatus;
}

interface QueuedDraftAutoSendFollowUp {
  kind: "queued-draft-auto-send";
  threadId: string;
}

type EventEffectFollowUp =
  | ManagerScheduleSyncFollowUp
  | ManagerTurnNotificationFollowUp
  | QueuedDraftAutoSendFollowUp;

interface EventEffectResult {
  followUps: EventEffectFollowUp[];
}

interface ManagerScheduleSyncLogContext {
  followUpKind: "manager-schedule-sync";
  threadId: string;
}

interface ManagerTurnNotificationLogContext {
  followUpKind: "manager-turn-notification";
  managedThreadId: string;
  managerThreadId: string;
}

interface QueuedDraftAutoSendLogContext {
  followUpKind: "queued-draft-auto-send";
  threadId: string;
}

type EventFollowUpLogContext =
  | ManagerScheduleSyncLogContext
  | ManagerTurnNotificationLogContext
  | QueuedDraftAutoSendLogContext;

function formatManagedThreadTitleSuffix(title: string | null): string {
  return title ? ` (${title})` : "";
}

function renderManagedThreadTurnStatusMessage(
  args: RenderManagedThreadTurnStatusMessageArgs,
): string {
  const variables = {
    threadId: args.managedThreadId,
    titleSuffix: formatManagedThreadTitleSuffix(args.title),
  };

  switch (args.turnStatus) {
    case "completed":
      return renderTemplate("systemMessageManagedThreadComplete", variables);
    case "failed":
      return renderTemplate("systemMessageManagedThreadFailed", variables);
    case "interrupted":
      return renderTemplate("systemMessageManagedThreadInterrupted", variables);
    default: {
      const exhaustiveCheck: never = args.turnStatus;
      return exhaustiveCheck;
    }
  }
}

async function queueManagedThreadTurnNotificationBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueManagedThreadTurnNotificationArgs,
): Promise<void> {
  try {
    await queueManagerSystemMessage(deps, {
      managerThreadId: args.managerThreadId,
      messageText: renderManagedThreadTurnStatusMessage(args),
    });
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        managedThreadId: args.managedThreadId,
        managerThreadId: args.managerThreadId,
        turnStatus: args.turnStatus,
      },
      "Failed to queue manager turn notification",
    );
  }
}

function resolveProviderIdentifiers(event: HostDaemonEventEnvelope["event"]): {
  providerThreadId: string | null;
} {
  switch (event.type) {
    case "thread/started":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/operation":
    case "system/permissionGrant/lifecycle":
    case "system/thread-provisioning":
      return { providerThreadId: null };
    case "thread/identity":
    case "thread/name/updated":
    case "provider/warning":
      return { providerThreadId: event.providerThreadId };
    case "thread/compacted":
      return { providerThreadId: event.providerThreadId };
    case "turn/started":
    case "turn/completed":
    case "turn/input/accepted":
    case "item/started":
    case "item/completed":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/toolCall/progress":
    case "thread/contextWindowUsage/updated":
    case "thread/tokenUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
      return { providerThreadId: event.providerThreadId };
    case "provider/error":
    case "provider/unhandled":
      return { providerThreadId: event.providerThreadId };
    default: {
      throw new Error("Unsupported event type");
    }
  }
}

function hashProducerEventPayload(args: ToStoredEventArgs): string {
  return createHash("sha256")
    .update(
      canonicalizeProducerEventPayload({
        event: args.envelope.event,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        threadId: args.envelope.threadId,
      }),
    )
    .digest("hex");
}

function toStoredEvent(args: ToStoredEventArgs): AppendDaemonEventInput {
  const envelope = args.envelope;
  const { scope, type, threadId, ...data } = envelope.event;
  return {
    threadId: envelope.threadId,
    environmentId: args.environmentId,
    producerEventId: envelope.producerEventId,
    producerEventPayloadHash: hashProducerEventPayload(args),
    ...resolveProviderIdentifiers(envelope.event),
    scope,
    type,
    ...deriveStoredEventItemFields(envelope.event),
    data: JSON.stringify(data),
  };
}

function appendDaemonEventInputsAtomically(
  deps: AppendDaemonEventInputsAtomicallyDeps,
  args: AppendDaemonEventInputsAtomicallyArgs,
): AppendDaemonEventsResult {
  return deps.db.transaction(
    (tx) => appendDaemonEventsInTransaction(tx, args.eventInputs),
    { behavior: "immediate" },
  );
}

function notifyInsertedEventThreads(
  deps: NotifyInsertedEventThreadsDeps,
  args: NotifyInsertedEventThreadsArgs,
): void {
  const threadIds = new Set<string>();
  for (const index of args.insertedInputIndexes) {
    const eventInput = args.eventInputs[index];
    if (eventInput) {
      threadIds.add(eventInput.threadId);
    }
  }
  for (const threadId of threadIds) {
    deps.hub.notifyThread(threadId, ["events-appended"]);
  }
}

async function archiveCompletedAutomationThreadIfNeeded(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ArchiveCompletedAutomationThreadIfNeededArgs,
): Promise<void> {
  if (args.turnStatus !== "completed" || !args.latestThread.automationId) {
    return;
  }

  const automation = getAutomation(deps.db, args.latestThread.automationId);
  if (automation?.autoArchive) {
    const shouldRequestCleanup = wouldCleanupEnvironment(deps, {
      environmentId: args.latestThread.environmentId,
      excludeThreadId: args.latestThread.id,
    });
    const archivedThread = archiveThread(
      deps.db,
      deps.hub,
      args.latestThread.id,
    );
    if (!archivedThread) {
      return;
    }
    queueSettledArchivedThreadProviderArchiveCommand(deps, {
      threadId: archivedThread.id,
    });
    if (shouldRequestCleanup) {
      requestEnvironmentCleanup(deps, {
        environmentId: args.latestThread.environmentId,
        mode: "safe",
      });
    }
  }
}

async function applyEventEffects(
  deps: LoggedPendingInteractionWorkSessionDeps,
  events: HostDaemonEventEnvelope[],
): Promise<EventEffectResult> {
  // Apply event-owned state changes before returning so the accepted batch and
  // immediately visible thread state agree. Follow-ups that may queue daemon
  // work stay deferred to avoid command waits inside daemon ingress.
  const followUps: EventEffectFollowUp[] = [];
  for (const entry of events) {
    try {
      const event = entry.event;
      if (event.type === "turn/started") {
        const thread = getThread(deps.db, entry.threadId);
        if (!thread) {
          continue;
        }
        if (thread.stopRequestedAt !== null) {
          continue;
        }
        if (
          isPreStartThreadStatus(thread.status) ||
          thread.status === "idle" ||
          thread.status === "error"
        ) {
          tryTransition(deps.db, deps.hub, thread.id, "active");
        }
        continue;
      }

      if (event.type === "turn/completed") {
        const turnCompleted = applyTurnCompletedEvent(deps, {
          ...event,
          threadId: entry.threadId,
        });
        if (turnCompleted.thread?.parentThreadId) {
          followUps.push({
            kind: "manager-turn-notification",
            managedThreadId: turnCompleted.thread.id,
            managerThreadId: turnCompleted.thread.parentThreadId,
            turnStatus: event.status,
            title: turnCompleted.thread.title,
          });
        }
        if (event.status === "completed") {
          followUps.push({
            kind: "queued-draft-auto-send",
            threadId: entry.threadId,
          });
        }
        if (turnCompleted.nextStatus === "idle" && turnCompleted.thread) {
          const latestThread = getThread(deps.db, turnCompleted.thread.id);
          if (latestThread?.status === "idle") {
            if (latestThread.type === "manager") {
              followUps.push({
                kind: "manager-schedule-sync",
                threadId: latestThread.id,
              });
            }
            await archiveCompletedAutomationThreadIfNeeded(deps, {
              latestThread,
              turnStatus: event.status,
            });
          }
        }
        continue;
      }

      if (event.type === "thread/name/updated") {
        updateThread(deps.db, deps.hub, entry.threadId, {
          title: event.threadName,
        });
      }
    } catch (error) {
      deps.logger.error(
        {
          err: error,
          eventType: entry.event.type,
          producerEventId: entry.producerEventId,
          threadId: entry.threadId,
        },
        "Failed to apply event side effects",
      );
    }
  }
  return { followUps };
}

async function executeEventFollowUp(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUp: EventEffectFollowUp,
): Promise<void> {
  switch (followUp.kind) {
    case "manager-schedule-sync":
      await syncManagerThreadSchedules(deps, {
        threadId: followUp.threadId,
      });
      return;
    case "manager-turn-notification":
      await queueManagedThreadTurnNotificationBestEffort(deps, {
        managedThreadId: followUp.managedThreadId,
        managerThreadId: followUp.managerThreadId,
        turnStatus: followUp.turnStatus,
        title: followUp.title,
      });
      return;
    case "queued-draft-auto-send":
      await runQueuedDraftAutoSendForThread(deps, {
        threadId: followUp.threadId,
      });
      return;
  }
}

function eventFollowUpLogContext(
  followUp: EventEffectFollowUp,
): EventFollowUpLogContext {
  switch (followUp.kind) {
    case "manager-schedule-sync":
    case "queued-draft-auto-send":
      return {
        followUpKind: followUp.kind,
        threadId: followUp.threadId,
      };
    case "manager-turn-notification":
      return {
        followUpKind: followUp.kind,
        managedThreadId: followUp.managedThreadId,
        managerThreadId: followUp.managerThreadId,
      };
  }
}

async function executeEventFollowUpBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUp: EventEffectFollowUp,
): Promise<void> {
  try {
    await executeEventFollowUp(deps, followUp);
  } catch (error) {
    deps.logger.error(
      {
        ...eventFollowUpLogContext(followUp),
        err: error,
        followUp,
      },
      "Failed to run event follow-up",
    );
  }
}

async function executeEventFollowUpBatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUps: EventEffectFollowUp[],
): Promise<void> {
  await Promise.all(
    followUps.map((followUp) => executeEventFollowUpBestEffort(deps, followUp)),
  );
}

function deferEventFollowUpBatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUps: EventEffectFollowUp[],
): void {
  if (followUps.length === 0) {
    return;
  }

  scheduleAfterDaemonIngressResponse({
    logger: deps.logger,
    name: "Event follow-up scheduling",
    work: () => executeEventFollowUpBatch(deps, followUps),
  });
}

function toTurnKey(args: TurnKeyArgs): string {
  return `${args.threadId}:${args.turnId}`;
}

function listCompletedTurnKeysForStartedEvents(
  db: AppDeps["db"],
  batchEvents: HostDaemonEventEnvelope[],
): Set<string> {
  const startedTurnKeys = new Set<string>();
  const threadIds = new Set<string>();

  for (const entry of batchEvents) {
    if (entry.event.type !== "turn/started") {
      continue;
    }
    startedTurnKeys.add(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
    threadIds.add(entry.threadId);
  }

  if (startedTurnKeys.size === 0 || threadIds.size === 0) {
    return new Set<string>();
  }

  const completedTurnKeys = new Set<string>();
  for (const row of listCompletedTurnsByThreadIds(db, [...threadIds])) {
    const turnKey = toTurnKey({
      threadId: row.threadId,
      turnId: row.turnId,
    });
    if (startedTurnKeys.has(turnKey)) {
      completedTurnKeys.add(turnKey);
    }
  }
  return completedTurnKeys;
}

function shouldApplyEventEffect(args: ShouldApplyEventEffectArgs): boolean {
  const { entry } = args;

  if (entry.event.type === "turn/completed") {
    return args.insertedEventIndexLookup.has(args.index);
  }

  if (entry.event.type === "turn/started") {
    return !args.completedTurnKeyLookup.has(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
  }

  // Keep other projections replayable so a daemon retry can repair them if the
  // event insert committed before the projection side effect ran.
  return true;
}

function resolveEventsToApply(
  args: ResolveEventsToApplyArgs,
): HostDaemonEventEnvelope[] {
  const insertedEventIndexLookup = new Set(args.insertedEventIndexes);
  const completedTurnKeyLookup = listCompletedTurnKeysForStartedEvents(
    args.db,
    args.events,
  );

  return args.events.filter((entry, index) =>
    shouldApplyEventEffect({
      completedTurnKeyLookup,
      entry,
      index,
      insertedEventIndexLookup,
    }),
  );
}

function resolveActivePruneCandidates(
  args: ResolveActivePruneCandidatesArgs,
): ActivePruneCandidate[] {
  const latestPrunableSequenceByThreadId = new Map<string, number>();
  const insertedEventIndexLookup = new Set(args.insertedEventIndexes);

  for (const [index, entry] of args.events.entries()) {
    if (!insertedEventIndexLookup.has(index)) {
      continue;
    }
    if (!isAgePrunableThreadEventType(entry.event.type)) {
      continue;
    }
    const acceptedEvent = args.acceptedEvents[index];
    if (acceptedEvent === undefined) {
      throw new Error("Missing accepted event for inserted daemon event");
    }

    const previousSequence = latestPrunableSequenceByThreadId.get(
      entry.threadId,
    );
    if (
      previousSequence === undefined ||
      acceptedEvent.sequence > previousSequence
    ) {
      latestPrunableSequenceByThreadId.set(
        entry.threadId,
        acceptedEvent.sequence,
      );
    }
  }

  return [...latestPrunableSequenceByThreadId.entries()].map(
    ([threadId, latestPrunableSequence]) => ({
      threadId,
      latestPrunableSequence,
    }),
  );
}

function summarizeRejectedDaemonEvents(
  rejectedEvents: readonly HostDaemonRejectedEvent[],
): RejectedDaemonEventSummary {
  return {
    count: rejectedEvents.length,
    threadIds: [...new Set(rejectedEvents.map((event) => event.threadId))],
  };
}

function resolvePostableEventBatchEntries(
  deps: Pick<AppDeps, "db">,
  args: ResolvePostableEventBatchEntriesArgs,
): ResolvePostableEventBatchEntriesResult {
  const threadIds = [...new Set(args.events.map((entry) => entry.threadId))];
  if (threadIds.length === 0) {
    return {
      entries: [],
      rejectedEvents: [],
    };
  }

  const ownedThreads = listThreadEnvironmentAssignmentsOnHost(deps.db, {
    hostId: args.hostId,
    threadIds,
  });

  const canonicalEnvironmentIdByThreadId = new Map<string, string>();
  for (const ownedThread of ownedThreads) {
    canonicalEnvironmentIdByThreadId.set(
      ownedThread.threadId,
      ownedThread.environmentId,
    );
  }

  const entries: PostableEventBatchEntry[] = [];
  const rejectedEvents: HostDaemonRejectedEvent[] = [];
  for (const entry of args.events) {
    const canonicalEnvironmentId = canonicalEnvironmentIdByThreadId.get(
      entry.threadId,
    );
    if (!canonicalEnvironmentId) {
      rejectedEvents.push({
        producerEventId: entry.producerEventId,
        reason: "thread_not_owned_by_host",
        threadId: entry.threadId,
      });
      continue;
    }
    entries.push({
      envelope: entry,
      environmentId: canonicalEnvironmentId,
    });
  }

  return {
    entries,
    rejectedEvents,
  };
}

export function registerInternalEventRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/events",
    hostDaemonEventBatchRequestSchema,
    async (context, payload) => {
      const result = await runWithDaemonCommandWaitForbidden({
        reason: "/session/events",
        work: async () => {
          const daemon = getAuthenticatedDaemon(context);
          const session = requireAuthorizedActiveSession(deps.db, {
            hostId: daemon.hostId,
            sessionId: payload.sessionId,
          });
          const { entries, rejectedEvents } = resolvePostableEventBatchEntries(
            deps,
            {
              hostId: session.hostId,
              events: payload.events,
            },
          );
          if (rejectedEvents.length > 0) {
            deps.logger.warn(
              {
                hostId: session.hostId,
                rejectedEvents: summarizeRejectedDaemonEvents(rejectedEvents),
                sessionId: session.id,
              },
              "Rejected daemon events for threads outside the session host",
            );
          }
          const eventInputs = entries.map((entry) => {
            return toStoredEvent({
              envelope: entry.envelope,
              environmentId: entry.environmentId,
            });
          });
          const postableEvents = entries.map((entry) => entry.envelope);
          let appendResult: AppendDaemonEventsResult;
          try {
            appendResult = appendDaemonEventInputsAtomically(deps, {
              eventInputs,
            });
          } catch (error) {
            if (error instanceof ProducerEventPayloadMismatchError) {
              deps.logger.error(
                {
                  existingHash: error.details.existingHash,
                  hostId: session.hostId,
                  producerEventId: error.details.producerEventId,
                  receivedHash: error.details.receivedHash,
                  sessionId: session.id,
                },
                "Producer event id payload mismatch",
              );
              throw new ApiError(
                409,
                "producer_event_payload_mismatch",
                "Producer event id was reused with a different payload",
              );
            }
            if (error instanceof MissingStoredTurnStartedError) {
              deps.logger.warn(
                { err: error, ...error.details, sessionId: session.id },
                "Rejected daemon event before turn/started",
              );
              throw new ApiError(409, "invalid_request", error.message);
            }
            throw error;
          }
          if (appendResult.acceptedEvents.length > 0) {
            void markSandboxActivity(deps, {
              hostId: session.hostId,
              source: "events",
            });
          }

          notifyInsertedEventThreads(deps, {
            eventInputs,
            insertedInputIndexes: appendResult.insertedInputIndexes,
          });

          const eventEffectResult = await applyEventEffects(
            deps,
            resolveEventsToApply({
              db: deps.db,
              events: postableEvents,
              insertedEventIndexes: appendResult.insertedInputIndexes,
            }),
          );
          for (const candidate of resolveActivePruneCandidates({
            acceptedEvents: appendResult.acceptedEvents,
            events: postableEvents,
            insertedEventIndexes: appendResult.insertedInputIndexes,
          })) {
            maybePruneActiveThreadEventHistory(deps, candidate);
          }

          return {
            followUps: eventEffectResult.followUps,
            response: context.json({
              acceptedEvents: appendResult.acceptedEvents,
              rejectedEvents,
            }),
          };
        },
      });
      deferEventFollowUpBatch(deps, result.followUps);
      return result.response;
    },
  );
}
