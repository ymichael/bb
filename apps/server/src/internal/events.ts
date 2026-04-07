import {
  archiveThread,
  getAutomation,
  deriveStoredEventItemFields,
  getHighWaterMarks,
  getThread,
  insertEvents,
  listCompletedTurnsByThreadIds,
  listThreadEnvironmentAssignmentsOnHost,
  updateThread,
} from "@bb/db";
import {
  hostDaemonEventBatchRequestSchema,
  typedRoutes,
  type HostDaemonEventEnvelope,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import { renderTemplate } from "@bb/templates";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import {
  isAgePrunableThreadEventType,
  maybePruneActiveThreadEventHistory,
} from "../services/system/event-pruning.js";
import {
  requestEnvironmentCleanup,
  wouldCleanupEnvironment,
} from "../services/environments/environment-cleanup.js";
import { syncManagerThreadSchedules } from "../services/scheduling/manager-schedule-sync.js";
import { queueManagerSystemMessage } from "../services/threads/manager-system-messages.js";
import { sendNextQueuedDraftIfPresent } from "../services/threads/queued-drafts.js";
import { tryTransition } from "../services/threads/thread-transitions.js";
import { getAuthenticatedDaemon } from "./auth.js";
import { applyTurnCompletedEvent } from "./turn-completed-events.js";
import { requireAuthorizedActiveSession } from "./session-state.js";

interface ToStoredEventArgs {
  envelope: HostDaemonEventEnvelope;
  environmentId: string;
}

interface ValidateAndResolveCanonicalEventBatchEnvironmentsArgs {
  hostId: string;
  events: HostDaemonEventEnvelope[];
}

interface ValidateAndResolveCanonicalEventBatchEnvironmentsResult {
  canonicalEnvironmentIds: string[];
}

interface ResolveEventsToApplyArgs {
  db: AppDeps["db"];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
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
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
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

function resolveProviderIdentifiers(
  event: HostDaemonEventEnvelope["event"],
): { providerThreadId: string | null; turnId: string | null } {
  switch (event.type) {
    case "thread/started":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/thread-title/updated":
    case "system/operation":
    case "system/provisioning":
      return { providerThreadId: null, turnId: null };
    case "thread/identity":
    case "thread/name/updated":
    case "thread/compacted":
    case "warning":
      return { providerThreadId: event.providerThreadId, turnId: null };
    case "turn/started":
    case "turn/completed":
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
    case "thread/tokenUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
      return {
        providerThreadId: event.providerThreadId,
        turnId: event.turnId,
      };
    case "error":
    case "provider/unhandled":
      return {
        providerThreadId: event.providerThreadId,
        turnId: event.turnId ?? null,
      };
    default: {
      throw new Error("Unsupported event type");
    }
  }
}

function toStoredEvent(args: ToStoredEventArgs) {
  const envelope = args.envelope;
  const { type, threadId, ...data } = envelope.event;
  return {
    threadId: envelope.threadId,
    environmentId: args.environmentId,
    ...resolveProviderIdentifiers(envelope.event),
    sequence: envelope.sequence,
    type,
    // Provider events keep the daemon timestamp even though server-originated
    // events still use server time.
    createdAt: envelope.createdAt,
    ...deriveStoredEventItemFields(envelope.event),
    data: JSON.stringify(data),
  };
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
    archiveThread(deps.db, deps.hub, args.latestThread.id);
    if (shouldRequestCleanup) {
      requestEnvironmentCleanup(deps, {
        environmentId: args.latestThread.environmentId,
        mode: "safe",
      });
    }
  }
}

async function applyEventEffects(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  events: HostDaemonEventEnvelope[],
): Promise<void> {
  for (const entry of events) {
    try {
      const event = entry.event;
      if (event.type === "turn/started") {
        const thread = getThread(deps.db, entry.threadId);
        if (!thread) {
          continue;
        }
        if (
          thread.status === "created"
          || thread.status === "provisioning"
          || thread.status === "idle"
          || thread.status === "error"
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
          await queueManagedThreadTurnNotificationBestEffort(deps, {
            managedThreadId: turnCompleted.thread.id,
            managerThreadId: turnCompleted.thread.parentThreadId,
            turnStatus: event.status,
            title: turnCompleted.thread.title,
          });
        }
        if (event.status === "completed") {
          await sendNextQueuedDraftIfPresent(deps, {
            threadId: entry.threadId,
          });
        }
        if (turnCompleted.nextStatus === "idle" && turnCompleted.thread) {
          const latestThread = getThread(deps.db, turnCompleted.thread.id);
          if (latestThread?.status === "idle") {
            if (latestThread.type === "manager") {
              await syncManagerThreadSchedules(deps, {
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
          sequence: entry.sequence,
          threadId: entry.threadId,
        },
        "Failed to apply event side effects",
      );
    }
  }
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
        turnId: entry.event.turnId,
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
        turnId: entry.event.turnId,
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

    const previousSequence = latestPrunableSequenceByThreadId.get(entry.threadId);
    if (
      previousSequence === undefined ||
      entry.sequence > previousSequence
    ) {
      latestPrunableSequenceByThreadId.set(entry.threadId, entry.sequence);
    }
  }

  return [...latestPrunableSequenceByThreadId.entries()].map(
    ([threadId, latestPrunableSequence]) => ({
      threadId,
      latestPrunableSequence,
    }),
  );
}

function validateAndResolveCanonicalEventBatchEnvironments(
  deps: Pick<AppDeps, "db">,
  args: ValidateAndResolveCanonicalEventBatchEnvironmentsArgs,
): ValidateAndResolveCanonicalEventBatchEnvironmentsResult {
  const threadIds = [...new Set(args.events.map((entry) => entry.threadId))];
  if (threadIds.length === 0) {
    return {
      canonicalEnvironmentIds: [],
    };
  }

  const ownedThreads = listThreadEnvironmentAssignmentsOnHost(deps.db, {
    hostId: args.hostId,
    threadIds,
  });
  if (ownedThreads.length !== threadIds.length) {
    throw new ApiError(
      403,
      "invalid_request",
      "Event batch contains threads that do not belong to the session host",
    );
  }

  const canonicalEnvironmentIdByThreadId = new Map<string, string>();
  for (const ownedThread of ownedThreads) {
    canonicalEnvironmentIdByThreadId.set(
      ownedThread.threadId,
      ownedThread.environmentId,
    );
  }

  const canonicalEnvironmentIds: string[] = [];
  for (const entry of args.events) {
    const canonicalEnvironmentId = canonicalEnvironmentIdByThreadId.get(
      entry.threadId,
    );
    if (!canonicalEnvironmentId) {
      throw new Error("Validated thread is missing a canonical environment");
    }
    if (entry.environmentId !== canonicalEnvironmentId) {
      throw new ApiError(
        400,
        "invalid_request",
        "Event batch contains environmentIds that do not match the thread environment",
      );
    }
    canonicalEnvironmentIds.push(canonicalEnvironmentId);
  }

  return {
    canonicalEnvironmentIds,
  };
}

export function registerInternalEventRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post("/session/events", hostDaemonEventBatchRequestSchema, async (context, payload) => {
    const daemon = getAuthenticatedDaemon(context);
    const session = requireAuthorizedActiveSession(deps.db, {
      hostId: daemon.hostId,
      sessionId: payload.sessionId,
    });
    const { canonicalEnvironmentIds } = validateAndResolveCanonicalEventBatchEnvironments(deps, {
      hostId: session.hostId,
      events: payload.events,
    });

    const insertResult = insertEvents(
      deps.db,
      deps.hub,
      payload.events.map((entry, index) => {
        const environmentId = canonicalEnvironmentIds[index];
        if (!environmentId) {
          throw new Error("Missing canonical environment for validated event");
        }
        return toStoredEvent({
          envelope: entry,
          environmentId,
        });
      }),
    );

    await applyEventEffects(
      deps,
      resolveEventsToApply({
        db: deps.db,
        events: payload.events,
        insertedEventIndexes: insertResult.insertedInputIndexes,
      }),
    );
    for (const candidate of resolveActivePruneCandidates({
      events: payload.events,
      insertedEventIndexes: insertResult.insertedInputIndexes,
    })) {
      maybePruneActiveThreadEventHistory(deps, candidate);
    }

    return context.json({
      threadHighWaterMarks: getHighWaterMarks(
        deps.db,
        payload.events.map((event) => event.threadId),
      ),
    });
  });
}
