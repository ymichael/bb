import {
  archiveThread,
  getAutomation,
  deriveStoredEventItemFields,
  getHighWaterMarks,
  getThread,
  insertEvents,
  listCompletedTurnsByThreadIds,
  listStoredEventRowsByThreadSequences,
  listThreadEnvironmentAssignmentsOnHost,
  noopNotifier,
  updateThread,
} from "@bb/db";
import type {
  DbQueryConnection,
  InsertEventInput,
  InsertEventsResult,
  StoredEventSequenceRow,
} from "@bb/db";
import {
  hostDaemonEventBatchRequestSchema,
  typedRoutes,
  type HostDaemonEventEnvelope,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import {
  getThreadEventScopeTurnId,
  jsonValueSchema,
  requireThreadEventScopeTurnId,
} from "@bb/domain";
import type { JsonValue } from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import type { Hono } from "hono";
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

interface EventSequenceConflict {
  acceptedSequences: StoredEventSequenceKey[];
  threadHighWaterMarks: Record<string, number>;
}

interface EventBatchInsertedTransactionResult {
  kind: "inserted";
  insertResult: InsertEventsResult;
}

interface EventBatchSequenceConflictTransactionResult {
  kind: "sequence-conflict";
  sequenceConflict: EventSequenceConflict;
}

type EventBatchTransactionResult =
  | EventBatchInsertedTransactionResult
  | EventBatchSequenceConflictTransactionResult;

interface InsertEventInputsAtomicallyDeps {
  db: AppDeps["db"];
}

interface InsertEventInputsAtomicallyArgs {
  eventInputs: InsertEventInput[];
}

interface NotifyInsertedEventThreadsDeps {
  hub: AppDeps["hub"];
}

interface NotifyInsertedEventThreadsArgs {
  eventInputs: InsertEventInput[];
  insertedInputIndexes: number[];
}

interface CanonicalizeStoredEventDataArgs {
  data: string;
}

interface FindEventSequenceConflictArgs {
  db: DbQueryConnection;
  eventInputs: InsertEventInput[];
}

interface StoredEventSequenceKey {
  sequence: number;
  threadId: string;
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

function toStoredEvent(args: ToStoredEventArgs): InsertEventInput {
  const envelope = args.envelope;
  const { scope, type, threadId, ...data } = envelope.event;
  return {
    threadId: envelope.threadId,
    environmentId: args.environmentId,
    ...resolveProviderIdentifiers(envelope.event),
    scope,
    sequence: envelope.sequence,
    type,
    // Provider events keep the daemon timestamp even though server-originated
    // events still use server time.
    createdAt: envelope.createdAt,
    ...deriveStoredEventItemFields(envelope.event),
    data: JSON.stringify(data),
  };
}

function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJsonValue(entry));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const canonicalValue: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const entryValue = value[key];
    if (entryValue !== undefined) {
      canonicalValue[key] = canonicalizeJsonValue(entryValue);
    }
  }
  return canonicalValue;
}

function canonicalizeStoredEventData(
  args: CanonicalizeStoredEventDataArgs,
): string {
  try {
    return JSON.stringify(
      canonicalizeJsonValue(jsonValueSchema.parse(JSON.parse(args.data))),
    );
  } catch {
    throw new Error("Invalid event JSON while comparing stored event data");
  }
}

function storedEventMatchesInput(
  row: StoredEventSequenceRow,
  input: InsertEventInput,
): boolean {
  const storedData = canonicalizeStoredEventData({
    data: row.data,
  });
  const inputData = canonicalizeStoredEventData({
    data: input.data,
  });
  return (
    row.threadId === input.threadId &&
    row.environmentId === (input.environmentId ?? null) &&
    row.scopeKind === input.scope.kind &&
    row.turnId === (getThreadEventScopeTurnId(input.scope) ?? null) &&
    row.providerThreadId === (input.providerThreadId ?? null) &&
    row.sequence === input.sequence &&
    row.type === input.type &&
    row.itemId === input.itemId &&
    row.itemKind === input.itemKind &&
    storedData === inputData
  );
}

function storedEventSequenceKey(key: StoredEventSequenceKey): string {
  return `${key.threadId}:${key.sequence}`;
}

function eventInputsMatch(
  left: InsertEventInput,
  right: InsertEventInput,
): boolean {
  const leftData = canonicalizeStoredEventData({
    data: left.data,
  });
  const rightData = canonicalizeStoredEventData({
    data: right.data,
  });
  return (
    left.threadId === right.threadId &&
    (left.environmentId ?? null) === (right.environmentId ?? null) &&
    left.scope.kind === right.scope.kind &&
    getThreadEventScopeTurnId(left.scope) ===
      getThreadEventScopeTurnId(right.scope) &&
    (left.providerThreadId ?? null) === (right.providerThreadId ?? null) &&
    left.sequence === right.sequence &&
    left.type === right.type &&
    left.itemId === right.itemId &&
    left.itemKind === right.itemKind &&
    leftData === rightData
  );
}

function findEventSequenceConflict(
  args: FindEventSequenceConflictArgs,
): EventSequenceConflict | null {
  if (args.eventInputs.length === 0) {
    return null;
  }

  const rows = listStoredEventRowsByThreadSequences(args.db, {
    keys: args.eventInputs.map((input) => ({
      threadId: input.threadId,
      sequence: input.sequence,
    })),
  });

  const existingRowsByThreadSequence = new Map<
    string,
    StoredEventSequenceRow
  >();
  for (const row of rows) {
    existingRowsByThreadSequence.set(storedEventSequenceKey(row), row);
  }

  const acceptedSequences: StoredEventSequenceKey[] = [];
  const acceptedSequenceKeys = new Set<string>();
  const firstInputByThreadSequence = new Map<string, InsertEventInput>();
  let hasSequenceConflict = false;

  function addAcceptedSequence(input: InsertEventInput): void {
    const sequenceKey = storedEventSequenceKey(input);
    if (acceptedSequenceKeys.has(sequenceKey)) {
      return;
    }
    acceptedSequenceKeys.add(sequenceKey);
    acceptedSequences.push({
      sequence: input.sequence,
      threadId: input.threadId,
    });
  }

  for (const input of args.eventInputs) {
    const sequenceKey = storedEventSequenceKey(input);
    const firstInput = firstInputByThreadSequence.get(sequenceKey);
    if (firstInput === undefined) {
      firstInputByThreadSequence.set(sequenceKey, input);
    } else if (!eventInputsMatch(firstInput, input)) {
      hasSequenceConflict = true;
    }

    const existing = existingRowsByThreadSequence.get(sequenceKey);
    if (!existing) {
      continue;
    }
    if (storedEventMatchesInput(existing, input)) {
      addAcceptedSequence(input);
      continue;
    }
    hasSequenceConflict = true;
  }

  if (!hasSequenceConflict) {
    return null;
  }

  return {
    acceptedSequences,
    threadHighWaterMarks: getHighWaterMarks(
      args.db,
      args.eventInputs.map((eventInput) => eventInput.threadId),
    ),
  };
}

function insertEventInputsAtomically(
  deps: InsertEventInputsAtomicallyDeps,
  args: InsertEventInputsAtomicallyArgs,
): EventBatchTransactionResult {
  return deps.db.transaction(
    (tx): EventBatchTransactionResult => {
      const sequenceConflict = findEventSequenceConflict({
        db: tx,
        eventInputs: args.eventInputs,
      });
      if (sequenceConflict) {
        return {
          kind: "sequence-conflict",
          sequenceConflict,
        };
      }

      return {
        kind: "inserted",
        insertResult: insertEvents(tx, noopNotifier, args.eventInputs),
      };
    },
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
  deps: LoggedPendingInteractionWorkSessionDeps,
  events: HostDaemonEventEnvelope[],
): Promise<EventEffectResult> {
  // Keep event-owned state changes inline so the daemon response contains the
  // right high-water marks. Defer follow-ups that may queue daemon work until
  // after the ingress route returns.
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
          sequence: entry.sequence,
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

    const previousSequence = latestPrunableSequenceByThreadId.get(
      entry.threadId,
    );
    if (previousSequence === undefined || entry.sequence > previousSequence) {
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
          const { canonicalEnvironmentIds } =
            validateAndResolveCanonicalEventBatchEnvironments(deps, {
              hostId: session.hostId,
              events: payload.events,
            });
          if (payload.events.length > 0) {
            void markSandboxActivity(deps, {
              hostId: session.hostId,
              source: "events",
            });
          }

          const eventInputs = payload.events.map((entry, index) => {
            const environmentId = canonicalEnvironmentIds[index];
            if (!environmentId) {
              throw new Error(
                "Missing canonical environment for validated event",
              );
            }
            return toStoredEvent({
              envelope: entry,
              environmentId,
            });
          });
          const eventBatchTransactionResult = insertEventInputsAtomically(deps, {
            eventInputs,
          });
          if (eventBatchTransactionResult.kind === "sequence-conflict") {
            const { sequenceConflict } = eventBatchTransactionResult;
            return {
              followUps: [],
              response: context.json(
                {
                  acceptedSequences: sequenceConflict.acceptedSequences,
                  code: "sequence_conflict",
                  threadHighWaterMarks: sequenceConflict.threadHighWaterMarks,
                },
                409,
              ),
            };
          }

          const { insertResult } = eventBatchTransactionResult;
          notifyInsertedEventThreads(deps, {
            eventInputs,
            insertedInputIndexes: insertResult.insertedInputIndexes,
          });

          const eventEffectResult = await applyEventEffects(
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

          return {
            followUps: eventEffectResult.followUps,
            response: context.json({
              threadHighWaterMarks: getHighWaterMarks(
                deps.db,
                payload.events.map((event) => event.threadId),
              ),
            }),
          };
        },
      });
      deferEventFollowUpBatch(deps, result.followUps);
      return result.response;
    },
  );
}
