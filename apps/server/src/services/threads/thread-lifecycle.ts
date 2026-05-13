import {
  cancelCommand,
  clearThreadStopRequested,
  deleteThread,
  getActiveSession,
  getCommand,
  getEnvironment,
  getThread,
  getThreadOperation,
  getThreadOperationByCommandId,
  listThreadTurnInterruptionEventStates,
  markThreadStopRequested,
  queueCommand,
  transitionThreadStatusInTransaction,
  type DbNotifier,
  type DbQueryConnection,
  type DbTransaction,
} from "@bb/db";
import { assertNever } from "@bb/core-ui";
import {
  markThreadOperationRecordCompleted,
  markThreadOperationRecordFailed,
  markThreadOperationRecordQueued,
  upsertThreadOperationRecord,
} from "@bb/db/internal-lifecycle";
import {
  isActiveLifecycleOperationState,
  type PromptInput,
  type PermissionEscalation,
  type ResolvedThreadExecutionOptions,
  type SystemThreadInterruptedReason,
  type Thread,
  type ThreadStatus,
  type WorkspaceProvisionType,
  threadScope,
  turnScope,
} from "@bb/domain";
import {
  threadStartCommandSchema,
  threadStopCommandSchema,
} from "@bb/host-daemon-contract";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
  LoggedSandboxWorkSessionDeps,
  PendingInteractionWorkSessionDeps,
  SandboxWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  advanceEnvironmentCleanup,
  requestEnvironmentCleanup,
} from "../environments/environment-cleanup.js";
import {
  appendThreadEventInTransaction,
  appendThreadEventsInTransaction,
  appendThreadInterruptedEventInTransaction,
  getActiveTurnId,
  getLastProviderThreadId,
} from "./thread-events.js";
import { tryTransitionInTransaction } from "./thread-transitions.js";
import {
  buildThreadStartCommand,
  buildThreadStopCommand,
  queueArchivedThreadProviderArchiveCommand,
  queueThreadDeletedCommandInTransaction,
  queueTurnSubmitCommand,
  type QueueThreadStartCommandArgs,
  type QueueThreadStopCommandArgs,
} from "./thread-commands.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { createAsyncDeduper } from "../lib/async-deduper.js";
import { parseJsonWithSchema } from "../lib/json-parsing.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { completeThreadProvisioningForStartHandoff } from "./thread-provisioning-handoff.js";
import { isPreStartThreadStatus } from "./thread-status.js";

type QueueReadyThreadTurnCommandResult = "thread.start" | "turn.submit";
type ThreadStartCommand = Awaited<ReturnType<typeof buildThreadStartCommand>>;
type ThreadEventAppendArgs = Parameters<
  typeof appendThreadEventsInTransaction
>[1][number];

const threadStartRequestDeduper = createAsyncDeduper<string, void>();

export interface AdvanceThreadOperationArgs {
  hostId: string;
  threadId: string;
}

export interface QueueReadyThreadTurnCommandArgs {
  environment: {
    hostId: string;
    id: string;
    path: string;
    workspaceProvisionType: WorkspaceProvisionType;
  };
  requestId: QueueThreadStartCommandArgs["requestId"];
  execution: ResolvedThreadExecutionOptions;
  permissionEscalation: PermissionEscalation;
  input: PromptInput[];
  thread: Thread;
}

export interface RequestThreadStopArgs extends QueueThreadStopCommandArgs {
  stopRequestedAt: number | null;
}

export interface FinalizeStoppedThreadArgs {
  cancelPendingCommand?: boolean;
  expectedCommandId?: string;
  threadId: string;
}

export interface InterruptActiveTurnForThreadArgs {
  environmentId: string | null;
  reason: SystemThreadInterruptedReason;
  threadId: string;
}

export interface InterruptActiveThreadArgs {
  environmentId: string | null;
  threadId: string;
}

export interface InterruptActiveThreadsArgs {
  reason: SystemThreadInterruptedReason;
  threads: readonly InterruptActiveThreadArgs[];
}

export interface InterruptedActiveThreadResult {
  interruptedTurnId: string | null;
  threadId: string;
}

export interface InterruptActiveThreadsResult {
  threads: InterruptedActiveThreadResult[];
}

export interface ThreadOperationMutationArgs {
  threadId: string;
}

export interface ThreadOperationCommandMutationArgs {
  commandId: string;
}

export interface FailThreadOperationForCommandArgs extends ThreadOperationCommandMutationArgs {
  failureReason: string;
}

export interface QueueSettledArchivedThreadProviderArchiveCommandArgs {
  threadId: string;
}

function nextStatusForInterruptedThread(
  reason: SystemThreadInterruptedReason,
): Extract<ThreadStatus, "idle" | "error"> {
  switch (reason) {
    case "manual-stop":
    case "host-daemon-restarted":
      return "idle";
    default:
      return assertNever(reason);
  }
}

interface RequestThreadStartHandoffArgs {
  baseCommand: ThreadStartCommand;
  environmentId: string;
  threadId: string;
}

interface RequestThreadStartHandoffResult {
  completedProvisionSequence: number | null;
  startOperationCreated: boolean;
}

interface ThreadLifecycleReadDeps {
  db: DbQueryConnection;
}

interface ThreadLifecycleWriteDeps extends ThreadLifecycleReadDeps {
  hub: DbNotifier;
}

interface ThreadLifecycleCommandQueueDeps {
  db: AppDeps["db"];
  hub: AppDeps["hub"];
}

interface ThreadLifecycleTransactionDeps extends ThreadLifecycleWriteDeps {
  db: DbTransaction;
}

interface FinalizeStoppedThreadTransactionDeps
  extends ThreadLifecycleTransactionDeps {
  pendingInteractions: AppDeps["pendingInteractions"];
}

interface HasQueuedThreadOperationCommandArgs {
  commandId: string | null;
  db: DbQueryConnection;
}

function hasQueuedThreadOperationCommandForDb(
  args: HasQueuedThreadOperationCommandArgs,
): boolean {
  if (!args.commandId) {
    return false;
  }

  const command = getCommand(args.db, args.commandId);
  return (
    command !== null &&
    (command.state === "pending" || command.state === "fetched")
  );
}

function hasQueuedThreadOperationCommand(
  deps: ThreadLifecycleReadDeps,
  commandId: string | null,
): boolean {
  return hasQueuedThreadOperationCommandForDb({
    db: deps.db,
    commandId,
  });
}

function getActiveThreadOperation(
  deps: ThreadLifecycleReadDeps,
  args: {
    kind: "start" | "stop";
    threadId: string;
  },
) {
  const operation = getThreadOperation(deps.db, args);
  if (!operation || !isActiveLifecycleOperationState(operation.state)) {
    return null;
  }

  return operation;
}

function getActiveThreadOperationByCommandId(
  deps: ThreadLifecycleReadDeps,
  args: {
    commandId: string;
    kind: "start" | "stop";
  },
) {
  const operation = getThreadOperationByCommandId(deps.db, args.commandId);
  if (
    !operation ||
    operation.kind !== args.kind ||
    !isActiveLifecycleOperationState(operation.state)
  ) {
    return null;
  }

  return operation;
}

function getThreadOperationCommandState(
  deps: ThreadLifecycleReadDeps,
  commandId: string | null,
): "pending" | "fetched" | "settled" | null {
  if (!commandId) {
    return null;
  }

  const command = getCommand(deps.db, commandId);
  if (!command) {
    return null;
  }
  if (command.state === "pending" || command.state === "fetched") {
    return command.state;
  }

  return "settled";
}

export function hasActiveThreadStartOperation(
  deps: ThreadLifecycleReadDeps,
  threadId: string,
): boolean {
  return (
    getActiveThreadOperation(deps, {
      threadId,
      kind: "start",
    }) !== null
  );
}

export function hasActiveThreadStopOperation(
  deps: ThreadLifecycleReadDeps,
  threadId: string,
): boolean {
  return (
    getActiveThreadOperation(deps, {
      threadId,
      kind: "stop",
    }) !== null
  );
}

export function queueSettledArchivedThreadProviderArchiveCommand(
  deps: ThreadLifecycleCommandQueueDeps,
  args: QueueSettledArchivedThreadProviderArchiveCommandArgs,
): boolean {
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.status === "active") {
    return false;
  }
  if (
    hasActiveThreadStartOperation(deps, thread.id) ||
    hasActiveThreadStopOperation(deps, thread.id)
  ) {
    return false;
  }

  return queueArchivedThreadProviderArchiveCommand(deps, {
    threadId: thread.id,
  });
}

export function ensureThreadCanQueueStartRequest(
  deps: ThreadLifecycleReadDeps,
  thread: Pick<Thread, "id" | "status">,
): void {
  if (
    isPreStartThreadStatus(thread.status) &&
    hasActiveThreadStartOperation(deps, thread.id)
  ) {
    throw new ApiError(409, "invalid_request", "Thread is still starting");
  }
}

export function hasActiveThreadStartOperationForCommand(
  deps: ThreadLifecycleReadDeps,
  args: ThreadOperationCommandMutationArgs,
): boolean {
  return (
    getActiveThreadOperationByCommandId(deps, {
      commandId: args.commandId,
      kind: "start",
    }) !== null
  );
}

export function hasActiveThreadStopOperationForCommand(
  deps: ThreadLifecycleReadDeps,
  args: ThreadOperationCommandMutationArgs,
): boolean {
  return (
    getActiveThreadOperationByCommandId(deps, {
      commandId: args.commandId,
      kind: "stop",
    }) !== null
  );
}

function completeThreadOperation(
  deps: ThreadLifecycleReadDeps,
  args: {
    kind: "start" | "stop";
    threadId: string;
  },
): boolean {
  const operation = getActiveThreadOperation(deps, args);
  if (!operation) {
    return false;
  }

  markThreadOperationRecordCompleted(deps.db, {
    threadId: args.threadId,
    kind: operation.kind,
  });
  return true;
}

function completeThreadOperationForCommand(
  deps: ThreadLifecycleReadDeps,
  args: {
    commandId: string;
    kind: "start" | "stop";
  },
): boolean {
  const operation = getActiveThreadOperationByCommandId(deps, args);
  if (!operation) {
    return false;
  }

  markThreadOperationRecordCompleted(deps.db, {
    threadId: operation.threadId,
    kind: operation.kind,
  });
  return true;
}

function failThreadOperationForCommand(
  deps: ThreadLifecycleReadDeps,
  args: {
    commandId: string;
    failureReason: string;
    kind: "start" | "stop";
  },
): boolean {
  const operation = getActiveThreadOperationByCommandId(deps, args);
  if (!operation) {
    return false;
  }

  markThreadOperationRecordFailed(deps.db, {
    threadId: operation.threadId,
    kind: operation.kind,
    failureReason: args.failureReason,
  });
  return true;
}

export function completeThreadStart(
  deps: ThreadLifecycleReadDeps,
  args: ThreadOperationMutationArgs,
): boolean {
  return completeThreadOperation(deps, {
    threadId: args.threadId,
    kind: "start",
  });
}

export function completeThreadStartForCommand(
  deps: ThreadLifecycleReadDeps,
  args: ThreadOperationCommandMutationArgs,
): boolean {
  return completeThreadOperationForCommand(deps, {
    commandId: args.commandId,
    kind: "start",
  });
}

export function failThreadStartForCommand(
  deps: ThreadLifecycleReadDeps,
  args: FailThreadOperationForCommandArgs,
): boolean {
  return failThreadOperationForCommand(deps, {
    commandId: args.commandId,
    kind: "start",
    failureReason: args.failureReason,
  });
}

export function failThreadStopForCommand(
  deps: ThreadLifecycleReadDeps,
  args: FailThreadOperationForCommandArgs,
): boolean {
  return failThreadOperationForCommand(deps, {
    commandId: args.commandId,
    kind: "stop",
    failureReason: args.failureReason,
  });
}

async function advanceActiveThreadStartIfPresent(
  deps: SandboxWorkSessionDeps,
  args: QueueThreadStartCommandArgs,
): Promise<boolean> {
  const operation = getThreadOperation(deps.db, {
    threadId: args.thread.id,
    kind: "start",
  });
  if (!operation || !isActiveLifecycleOperationState(operation.state)) {
    return false;
  }

  if (hasQueuedThreadOperationCommand(deps, operation.commandId)) {
    return true;
  }
  if (operation.state !== "requested") {
    return false;
  }

  await advanceThreadStart(deps, {
    hostId: args.environment.hostId,
    threadId: args.thread.id,
  });
  return true;
}

/**
 * Makes the provision-to-start durability boundary atomic: after a crash, the
 * thread should have either an active provision op to retry or an active start
 * op for the lifecycle sweep to advance.
 */
function requestThreadStartHandoff(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadStartHandoffArgs,
): RequestThreadStartHandoffResult {
  const result: RequestThreadStartHandoffResult = deps.db.transaction(
    (tx) => {
      const existingStartOperation = getThreadOperation(tx, {
        threadId: args.threadId,
        kind: "start",
      });
      if (
        existingStartOperation &&
        isActiveLifecycleOperationState(existingStartOperation.state) &&
        hasQueuedThreadOperationCommandForDb({
          db: tx,
          commandId: existingStartOperation.commandId,
        })
      ) {
        return {
          completedProvisionSequence: null,
          startOperationCreated: false,
        };
      }

      const completedProvisionSequence =
        completeThreadProvisioningForStartHandoff(tx, {
          threadId: args.threadId,
          environmentId: args.environmentId,
        });
      upsertThreadOperationRecord(tx, {
        threadId: args.threadId,
        kind: "start",
        payload: JSON.stringify(args.baseCommand),
      });
      return {
        completedProvisionSequence,
        startOperationCreated: true,
      };
    },
    { behavior: "immediate" },
  );

  if (result.completedProvisionSequence !== null) {
    deps.hub.notifyThread(args.threadId, ["events-appended"]);
  }
  return result;
}

export async function requestThreadStart(
  deps: LoggedSandboxWorkSessionDeps,
  args: QueueThreadStartCommandArgs,
): Promise<void> {
  await threadStartRequestDeduper.run(args.thread.id, () =>
    requestThreadStartOnce(deps, args),
  );
}

async function requestThreadStartOnce(
  deps: LoggedSandboxWorkSessionDeps,
  args: QueueThreadStartCommandArgs,
): Promise<void> {
  if (await advanceActiveThreadStartIfPresent(deps, args)) {
    return;
  }

  const baseCommand = await buildThreadStartCommand(deps, {
    ...args,
  });
  if (await advanceActiveThreadStartIfPresent(deps, args)) {
    return;
  }

  const handoff = requestThreadStartHandoff(deps, {
    baseCommand,
    environmentId: args.environment.id,
    threadId: args.thread.id,
  });
  if (!handoff.startOperationCreated) {
    await advanceActiveThreadStartIfPresent(deps, args);
    return;
  }

  await advanceThreadStart(deps, {
    hostId: args.environment.hostId,
    threadId: args.thread.id,
  });
}

export async function advanceThreadStart(
  deps: SandboxWorkSessionDeps,
  args: AdvanceThreadOperationArgs,
): Promise<string | null> {
  const operation = getThreadOperation(deps.db, {
    threadId: args.threadId,
    kind: "start",
  });
  if (!operation || !isActiveLifecycleOperationState(operation.state)) {
    return null;
  }

  if (hasQueuedThreadOperationCommand(deps, operation.commandId)) {
    return operation.commandId;
  }

  const session = await ensureHostSessionReadyForWork(deps, {
    hostId: args.hostId,
  });

  const command = parseJsonWithSchema(
    operation.payload,
    threadStartCommandSchema,
  );
  const queuedCommand = queueCommand(deps.db, deps.hub, {
    hostId: args.hostId,
    sessionId: session.id,
    type: command.type,
    payload: JSON.stringify(command),
  });
  markThreadOperationRecordQueued(deps.db, {
    threadId: args.threadId,
    kind: "start",
    commandId: queuedCommand.id,
  });
  return queuedCommand.id;
}

export async function queueReadyThreadTurnCommand(
  deps: LoggedSandboxWorkSessionDeps,
  args: QueueReadyThreadTurnCommandArgs,
): Promise<QueueReadyThreadTurnCommandResult> {
  const providerThreadId = getLastProviderThreadId(deps, args.thread.id);
  if (providerThreadId) {
    await queueTurnSubmitCommand(deps, {
      thread: args.thread,
      input: args.input,
      requestId: args.requestId,
      execution: args.execution,
      permissionEscalation: args.permissionEscalation,
      environment: args.environment,
      providerThreadId,
      target: { mode: "start" },
    });
    return "turn.submit";
  }

  await requestThreadStart(deps, {
    thread: args.thread,
    environment: args.environment,
    input: args.input,
    requestId: args.requestId,
    execution: args.execution,
    permissionEscalation: args.permissionEscalation,
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
  });
  return "thread.start";
}

export function requestThreadStop(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadStopArgs,
): void {
  if (args.stopRequestedAt === null) {
    markThreadStopRequested(deps.db, deps.hub, {
      threadId: args.threadId,
    });
  }

  const existingOperation = getThreadOperation(deps.db, {
    threadId: args.threadId,
    kind: "stop",
  });
  if (
    existingOperation &&
    isActiveLifecycleOperationState(existingOperation.state) &&
    hasQueuedThreadOperationCommand(deps, existingOperation.commandId)
  ) {
    return;
  }

  const command = buildThreadStopCommand(args);
  upsertThreadOperationRecord(deps.db, {
    threadId: args.threadId,
    kind: "stop",
    payload: JSON.stringify(command),
  });
  advanceThreadStop(deps, {
    hostId: args.hostId,
    threadId: args.threadId,
  });
}

export function requestThreadStopIfNeeded(
  deps: Pick<AppDeps, "db" | "hub">,
  thread: Pick<Thread, "id" | "status" | "stopRequestedAt">,
  environment: {
    hostId: string;
    id: string;
  },
): void {
  if (
    thread.status !== "active" &&
    !hasActiveThreadStartOperation(deps, thread.id)
  ) {
    return;
  }
  requestThreadStop(deps, {
    environmentId: environment.id,
    hostId: environment.hostId,
    stopRequestedAt: thread.stopRequestedAt,
    threadId: thread.id,
  });
}

export function interruptActiveTurnForThread(
  deps: Pick<AppDeps, "db" | "hub">,
  args: InterruptActiveTurnForThreadArgs,
): boolean {
  const activeTurnId = getActiveTurnId(deps, args.threadId);
  if (!activeTurnId) {
    return false;
  }

  const providerThreadId = getLastProviderThreadId(deps, args.threadId);
  const nextStatus = nextStatusForInterruptedThread(args.reason);

  deps.db.transaction(
    (tx) => {
      appendThreadEventInTransaction(tx, {
        threadId: args.threadId,
        environmentId: args.environmentId,
        providerThreadId,
        type: "turn/completed",
        scope: turnScope(activeTurnId),
        data: {
          providerThreadId,
          status: "interrupted",
        },
      });
      appendThreadInterruptedEventInTransaction(tx, {
        threadId: args.threadId,
        reason: args.reason,
      });
      transitionThreadStatusInTransaction(tx, {
        id: args.threadId,
        newStatus: nextStatus,
      });
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.threadId, ["events-appended", "status-changed"]);

  return true;
}

function interruptActiveTurnForThreadInTransaction(
  deps: ThreadLifecycleTransactionDeps,
  args: InterruptActiveTurnForThreadArgs,
): boolean {
  const activeTurnId = getActiveTurnId(deps, args.threadId);
  if (!activeTurnId) {
    return false;
  }

  const providerThreadId = getLastProviderThreadId(deps, args.threadId);
  const nextStatus = nextStatusForInterruptedThread(args.reason);

  appendThreadEventInTransaction(deps.db, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId,
    type: "turn/completed",
    scope: turnScope(activeTurnId),
    data: {
      providerThreadId,
      status: "interrupted",
    },
  });
  appendThreadInterruptedEventInTransaction(deps.db, {
    threadId: args.threadId,
    reason: args.reason,
  });
  transitionThreadStatusInTransaction(deps.db, {
    id: args.threadId,
    newStatus: nextStatus,
  });
  deps.hub.notifyThread(args.threadId, ["events-appended", "status-changed"]);

  return true;
}

/**
 * Reconciles threads whose server status is active after the host runtime no
 * longer reports them. Every supplied thread gets a thread interruption event;
 * threads with an open turn also get an interrupted turn completion event.
 */
export function interruptActiveThreads(
  deps: Pick<AppDeps, "db" | "hub">,
  args: InterruptActiveThreadsArgs,
): InterruptActiveThreadsResult {
  if (args.threads.length === 0) {
    return { threads: [] };
  }

  const results: InterruptedActiveThreadResult[] = [];
  const threadIds = args.threads.map((thread) => thread.threadId);
  const nextStatus = nextStatusForInterruptedThread(args.reason);

  deps.db.transaction(
    (tx) => {
      const stateByThreadId = new Map(
        listThreadTurnInterruptionEventStates(tx, { threadIds }).map(
          (state) => [state.threadId, state],
        ),
      );
      const eventArgs: ThreadEventAppendArgs[] = [];

      for (const thread of args.threads) {
        const state = stateByThreadId.get(thread.threadId);
        const activeTurnId = state?.activeTurnId ?? null;
        const providerThreadId = state?.latestProviderThreadId ?? null;

        if (activeTurnId !== null) {
          eventArgs.push({
            threadId: thread.threadId,
            environmentId: thread.environmentId,
            providerThreadId,
            type: "turn/completed",
            scope: turnScope(activeTurnId),
            data: {
              providerThreadId,
              status: "interrupted",
            },
          });
        }

        eventArgs.push({
          threadId: thread.threadId,
          type: "system/thread/interrupted",
          scope: threadScope(),
          data: {
            reason: args.reason,
          },
        });
        results.push({
          threadId: thread.threadId,
          interruptedTurnId: activeTurnId,
        });
      }

      appendThreadEventsInTransaction(tx, eventArgs);

      for (const thread of args.threads) {
        transitionThreadStatusInTransaction(tx, {
          id: thread.threadId,
          newStatus: nextStatus,
        });
      }
    },
    { behavior: "immediate" },
  );

  for (const thread of args.threads) {
    deps.hub.notifyThread(thread.threadId, [
      "events-appended",
      "status-changed",
    ]);
  }

  return { threads: results };
}

function advanceThreadStop(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AdvanceThreadOperationArgs,
): string | null {
  const operation = getThreadOperation(deps.db, {
    threadId: args.threadId,
    kind: "stop",
  });
  if (!operation || !isActiveLifecycleOperationState(operation.state)) {
    return null;
  }

  if (hasQueuedThreadOperationCommand(deps, operation.commandId)) {
    return operation.commandId;
  }

  const session = getActiveSession(deps.db, args.hostId);
  const command = parseJsonWithSchema(
    operation.payload,
    threadStopCommandSchema,
  );
  const queuedCommand = queueCommand(deps.db, deps.hub, {
    hostId: args.hostId,
    sessionId: session?.id ?? null,
    type: command.type,
    payload: JSON.stringify(command),
  });
  markThreadOperationRecordQueued(deps.db, {
    threadId: args.threadId,
    kind: "stop",
    commandId: queuedCommand.id,
  });
  return queuedCommand.id;
}

export function finalizeStoppedThread(
  deps: PendingInteractionWorkSessionDeps,
  args: FinalizeStoppedThreadArgs,
): boolean {
  const notificationBuffer = new NotificationBuffer();
  const finalized = deps.db.transaction(
    (tx) =>
      finalizeStoppedThreadInTransaction(
        {
          ...deps,
          db: tx,
          hub: notificationBuffer,
        },
        args,
      ),
    { behavior: "immediate" },
  );
  notificationBuffer.flushInto(deps.hub);
  if (finalized) {
    queueSettledArchivedThreadProviderArchiveCommand(deps, {
      threadId: args.threadId,
    });
  }
  return finalized;
}

export function finalizeStoppedThreadInTransaction(
  deps: FinalizeStoppedThreadTransactionDeps,
  args: FinalizeStoppedThreadArgs,
): boolean {
  const currentThread = getThread(deps.db, args.threadId);
  if (!currentThread) {
    return true;
  }

  const startOperation = getActiveThreadOperation(deps, {
    threadId: args.threadId,
    kind: "start",
  });
  if (startOperation) {
    return false;
  }

  const stopOperation = getActiveThreadOperation(deps, {
    threadId: args.threadId,
    kind: "stop",
  });
  if (
    args.expectedCommandId &&
    stopOperation &&
    stopOperation.commandId !== args.expectedCommandId
  ) {
    return false;
  }
  const stopCommandState = getThreadOperationCommandState(
    deps,
    stopOperation?.commandId ?? null,
  );
  const isSettlingExpectedCommand =
    args.expectedCommandId !== undefined &&
    stopOperation?.commandId === args.expectedCommandId;
  if (stopCommandState === "fetched" && !isSettlingExpectedCommand) {
    return false;
  }
  if (
    stopCommandState === "pending" &&
    stopOperation?.commandId &&
    !isSettlingExpectedCommand
  ) {
    if (args.cancelPendingCommand === false) {
      return false;
    }
    cancelCommand(deps.db, {
      commandId: stopOperation.commandId,
    });
  }

  let appendedThreadInterruptedEvent = false;
  if (currentThread.status === "active") {
    appendedThreadInterruptedEvent = interruptActiveTurnForThreadInTransaction(
      deps,
      {
        environmentId: currentThread.environmentId,
        threadId: currentThread.id,
        reason: "manual-stop",
      },
    );
    if (!appendedThreadInterruptedEvent) {
      tryTransitionInTransaction(deps.db, deps.hub, currentThread.id, "idle");
    }
  }

  completeThreadOperation(deps, {
    threadId: args.threadId,
    kind: "stop",
  });

  if (currentThread.stopRequestedAt !== null) {
    clearThreadStopRequested(deps.db, deps.hub, currentThread.id);
  }

  const finalizedThread = getThread(deps.db, args.threadId);
  if (!finalizedThread) {
    return true;
  }

  if (finalizedThread.deletedAt === null) {
    deps.pendingInteractions.interruptPendingInteractionsForThreadIdsInTransaction(
      deps,
      {
        threadIds: [finalizedThread.id],
        reason: "Thread stopped by user request",
      },
    );
    if (!appendedThreadInterruptedEvent) {
      appendThreadInterruptedEventInTransaction(deps.db, {
        threadId: finalizedThread.id,
        reason: "manual-stop",
      });
      deps.hub.notifyThread(finalizedThread.id, ["events-appended"]);
    }
  }

  if (finalizedThread.deletedAt !== null) {
    deps.pendingInteractions.interruptPendingInteractionsForThreadIdsInTransaction(
      deps,
      {
        threadIds: [finalizedThread.id],
        reason: "Thread was deleted while awaiting user interaction",
      },
    );

    const environmentId = finalizedThread.environmentId;
    const environment = environmentId
      ? getEnvironment(deps.db, environmentId)
      : null;
    if (environment) {
      const queuedDelete = queueThreadDeletedCommandInTransaction(deps.db, {
        environment: { hostId: environment.hostId, id: environment.id },
        threadId: finalizedThread.id,
      });
      if (!queuedDelete) {
        return false;
      }
      deps.hub.notifyCommand(environment.hostId);
    }
    deleteThread(deps.db, deps.hub, finalizedThread.id);
    requestEnvironmentCleanup(deps, {
      environmentId,
      mode: "force",
    });
    return true;
  }

  return true;
}

export async function finalizeStoppedThreadAndAdvanceCleanup(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: FinalizeStoppedThreadArgs,
): Promise<boolean> {
  const threadBeforeFinalize = getThread(deps.db, args.threadId);
  const finalized = finalizeStoppedThread(deps, args);
  if (!finalized) {
    return false;
  }

  const threadAfterFinalize = getThread(deps.db, args.threadId);
  const environmentId =
    threadAfterFinalize?.environmentId ??
    threadBeforeFinalize?.environmentId ??
    null;
  if (environmentId) {
    await advanceEnvironmentCleanup(deps, { environmentId });
  }
  return true;
}
