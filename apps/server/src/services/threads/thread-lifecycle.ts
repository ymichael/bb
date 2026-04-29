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
  markThreadStopRequested,
  queueCommand,
  type DbConnection,
  type DbTransaction,
} from "@bb/db";
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
  type Thread,
  type WorkspaceProvisionType,
} from "@bb/domain";
import {
  threadStartCommandSchema,
  threadStopCommandSchema,
} from "@bb/host-daemon-contract";
import type {
  AppDeps,
  PendingInteractionWorkSessionDeps,
  SandboxWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  advanceEnvironmentCleanup,
  requestEnvironmentCleanup,
} from "../environments/environment-cleanup.js";
import { appendThreadInterruptedEvent } from "./thread-events.js";
import { tryTransition } from "./thread-transitions.js";
import { getLastProviderThreadId } from "./thread-events.js";
import {
  buildThreadStartCommand,
  buildThreadStopCommand,
  queueThreadDeletedCommand,
  queueTurnSubmitCommand,
  type QueueThreadStartCommandArgs,
  type QueueThreadStopCommandArgs,
} from "./thread-commands.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { createAsyncDeduper } from "../lib/async-deduper.js";
import { parseJsonWithSchema } from "../lib/json-parsing.js";
import { completeThreadProvisioningForStartHandoff } from "./thread-provisioning-handoff.js";
import { isPreStartThreadStatus } from "./thread-status.js";

type QueueReadyThreadTurnCommandResult = "thread.start" | "turn.submit";
type ThreadStartCommand = Awaited<ReturnType<typeof buildThreadStartCommand>>;

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
  eventSequence: number;
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

export interface ThreadOperationMutationArgs {
  threadId: string;
}

export interface ThreadOperationCommandMutationArgs {
  commandId: string;
}

export interface FailThreadOperationForCommandArgs extends ThreadOperationCommandMutationArgs {
  failureReason: string;
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

interface HasQueuedThreadOperationCommandArgs {
  commandId: string | null;
  db: DbConnection | DbTransaction;
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
  deps: Pick<AppDeps, "db">,
  commandId: string | null,
): boolean {
  return hasQueuedThreadOperationCommandForDb({
    db: deps.db,
    commandId,
  });
}

function getActiveThreadOperation(
  deps: Pick<AppDeps, "db">,
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
  deps: Pick<AppDeps, "db">,
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
  deps: Pick<AppDeps, "db">,
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
  deps: Pick<AppDeps, "db">,
  threadId: string,
): boolean {
  return (
    getActiveThreadOperation(deps, {
      threadId,
      kind: "start",
    }) !== null
  );
}

export function ensureThreadCanQueueStartRequest(
  deps: Pick<AppDeps, "db">,
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
  deps: Pick<AppDeps, "db">,
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
  deps: Pick<AppDeps, "db">,
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
  deps: Pick<AppDeps, "db">,
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
  deps: Pick<AppDeps, "db">,
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
  deps: Pick<AppDeps, "db">,
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
  deps: Pick<AppDeps, "db">,
  args: ThreadOperationMutationArgs,
): boolean {
  return completeThreadOperation(deps, {
    threadId: args.threadId,
    kind: "start",
  });
}

export function completeThreadStartForCommand(
  deps: Pick<AppDeps, "db">,
  args: ThreadOperationCommandMutationArgs,
): boolean {
  return completeThreadOperationForCommand(deps, {
    commandId: args.commandId,
    kind: "start",
  });
}

export function failThreadStartForCommand(
  deps: Pick<AppDeps, "db">,
  args: FailThreadOperationForCommandArgs,
): boolean {
  return failThreadOperationForCommand(deps, {
    commandId: args.commandId,
    kind: "start",
    failureReason: args.failureReason,
  });
}

export function failThreadStopForCommand(
  deps: Pick<AppDeps, "db">,
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
      // The completed provisioning event is the last server-owned lifecycle event
      // before daemon-owned thread.start events. Seed the daemon above it.
      const command =
        completedProvisionSequence === null
          ? args.baseCommand
          : {
              ...args.baseCommand,
              eventSequence: completedProvisionSequence,
            };
      upsertThreadOperationRecord(tx, {
        threadId: args.threadId,
        kind: "start",
        payload: JSON.stringify(command),
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
  deps: SandboxWorkSessionDeps,
  args: QueueThreadStartCommandArgs,
): Promise<void> {
  await threadStartRequestDeduper.run(args.thread.id, () =>
    requestThreadStartOnce(deps, args),
  );
}

async function requestThreadStartOnce(
  deps: SandboxWorkSessionDeps,
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
  deps: SandboxWorkSessionDeps,
  args: QueueReadyThreadTurnCommandArgs,
): Promise<QueueReadyThreadTurnCommandResult> {
  const providerThreadId = getLastProviderThreadId(deps, args.thread.id);
  if (providerThreadId) {
    await queueTurnSubmitCommand(deps, {
      thread: args.thread,
      input: args.input,
      eventSequence: args.eventSequence,
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
    eventSequence: args.eventSequence,
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

export async function finalizeStoppedThread(
  deps: PendingInteractionWorkSessionDeps,
  args: FinalizeStoppedThreadArgs,
): Promise<boolean> {
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
  if (stopCommandState === "fetched") {
    return false;
  }
  if (stopCommandState === "pending" && stopOperation?.commandId) {
    if (args.cancelPendingCommand === false) {
      return false;
    }
    cancelCommand(deps.db, {
      commandId: stopOperation.commandId,
    });
  }

  if (currentThread.status === "active") {
    tryTransition(deps.db, deps.hub, currentThread.id, "idle");
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
    deps.pendingInteractions.interruptPendingInteractionsForThreadIds({
      threadIds: [finalizedThread.id],
      reason: "Thread stopped by user request",
    });
    appendThreadInterruptedEvent(deps, {
      threadId: finalizedThread.id,
      message: "Thread stopped by user request",
    });
  }

  if (finalizedThread.deletedAt !== null) {
    deps.pendingInteractions.interruptPendingInteractionsForThreadIds({
      threadIds: [finalizedThread.id],
      reason: "Thread was deleted while awaiting user interaction",
    });

    const environmentId = finalizedThread.environmentId;
    const environment = environmentId
      ? getEnvironment(deps.db, environmentId)
      : null;
    if (environment) {
      const queuedDelete = queueThreadDeletedCommand(deps, {
        environment: { hostId: environment.hostId, id: environment.id },
        threadId: finalizedThread.id,
      });
      if (!queuedDelete) {
        return false;
      }
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
  deps: PendingInteractionWorkSessionDeps,
  args: FinalizeStoppedThreadArgs,
): Promise<boolean> {
  const threadBeforeFinalize = getThread(deps.db, args.threadId);
  const finalized = await finalizeStoppedThread(deps, args);
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
