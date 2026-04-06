import {
  cancelCommand,
  clearThreadStopRequested,
  deleteThread,
  getActiveSession,
  getCommand,
  getThread,
  getThreadOperation,
  markThreadStopRequested,
  queueCommand,
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
  type ResolvedThreadExecutionOptions,
  type Thread,
  type WorkspaceProvisionType,
} from "@bb/domain";
import {
  threadStartCommandSchema,
  threadStopCommandSchema,
} from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { advanceEnvironmentCleanup, requestEnvironmentCleanup } from "./environment-cleanup.js";
import { appendThreadInterruptedEvent } from "./thread-events.js";
import { tryTransition } from "./thread-transitions.js";
import { getLastProviderThreadId } from "./thread-events.js";
import {
  buildThreadStartCommand,
  buildThreadStopCommand,
  queueTurnRunCommand,
  type QueueThreadStartCommandArgs,
  type QueueThreadStopCommandArgs,
} from "./thread-commands.js";
import { requireConnectedHostSession } from "./entity-lookup.js";
import { parseJsonWithSchema } from "./json-parsing.js";

type QueueReadyThreadTurnCommandResult = "thread.start" | "turn.run";

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
  input: PromptInput[];
  thread: Thread;
}

export interface RequestThreadStopArgs extends QueueThreadStopCommandArgs {
  stopRequestedAt: number | null;
}

export interface FinalizeStoppedThreadArgs {
  cancelPendingCommand?: boolean;
  threadId: string;
}

export interface ThreadOperationMutationArgs {
  threadId: string;
}

export interface FailThreadOperationArgs extends ThreadOperationMutationArgs {
  failureReason: string;
}

function hasQueuedThreadOperationCommand(
  deps: Pick<AppDeps, "db">,
  commandId: string | null,
): boolean {
  if (!commandId) {
    return false;
  }

  const command = getCommand(deps.db, commandId);
  return command !== null
    && (command.state === "pending" || command.state === "fetched");
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
  return getActiveThreadOperation(deps, {
    threadId,
    kind: "start",
  }) !== null;
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

function failThreadOperation(
  deps: Pick<AppDeps, "db">,
  args: {
    failureReason: string;
    kind: "start" | "stop";
    threadId: string;
  },
): boolean {
  const operation = getActiveThreadOperation(deps, args);
  if (!operation) {
    return false;
  }

  markThreadOperationRecordFailed(deps.db, {
    threadId: args.threadId,
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

export function failThreadStart(
  deps: Pick<AppDeps, "db">,
  args: FailThreadOperationArgs,
): boolean {
  return failThreadOperation(deps, {
    threadId: args.threadId,
    kind: "start",
    failureReason: args.failureReason,
  });
}

export function failThreadStop(
  deps: Pick<AppDeps, "db">,
  args: FailThreadOperationArgs,
): boolean {
  return failThreadOperation(deps, {
    threadId: args.threadId,
    kind: "stop",
    failureReason: args.failureReason,
  });
}

export async function requestThreadStart(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueThreadStartCommandArgs,
): Promise<void> {
  requireConnectedHostSession(deps, args.environment.hostId);
  const existingOperation = getThreadOperation(deps.db, {
    threadId: args.thread.id,
    kind: "start",
  });
  if (
    existingOperation
    && isActiveLifecycleOperationState(existingOperation.state)
    && hasQueuedThreadOperationCommand(deps, existingOperation.commandId)
  ) {
    return;
  }

  const command = await buildThreadStartCommand(deps, args);
  upsertThreadOperationRecord(deps.db, {
    threadId: args.thread.id,
    kind: "start",
    payload: JSON.stringify(command),
  });
  await advanceThreadStart(deps, {
    hostId: args.environment.hostId,
    threadId: args.thread.id,
  });
}

export async function advanceThreadStart(
  deps: Pick<AppDeps, "db" | "hub">,
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

  const session = getActiveSession(deps.db, args.hostId);
  if (!session || session.leaseExpiresAt <= Date.now()) {
    return null;
  }

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
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueReadyThreadTurnCommandArgs,
): Promise<QueueReadyThreadTurnCommandResult> {
  const providerThreadId = getLastProviderThreadId(deps, args.thread.id);
  if (providerThreadId) {
    await queueTurnRunCommand(deps, {
      thread: args.thread,
      input: args.input,
      eventSequence: args.eventSequence,
      execution: args.execution,
      environment: args.environment,
      providerThreadId,
    });
    return "turn.run";
  }

  await requestThreadStart(deps, {
    thread: args.thread,
    environment: args.environment,
    input: args.input,
    eventSequence: args.eventSequence,
    execution: args.execution,
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
    existingOperation
    && isActiveLifecycleOperationState(existingOperation.state)
    && hasQueuedThreadOperationCommand(deps, existingOperation.commandId)
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

export function advanceThreadStop(
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
  deps: Pick<AppDeps, "db" | "hub">,
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
  const stopCommandState = getThreadOperationCommandState(
    deps,
    stopOperation?.commandId ?? null,
  );
  if (stopCommandState === "fetched") {
    return false;
  }
  if (
    args.cancelPendingCommand !== false
    && stopCommandState === "pending"
    && stopOperation?.commandId
  ) {
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
    appendThreadInterruptedEvent(deps, {
      threadId: finalizedThread.id,
      message: "Thread stopped by user request",
    });
  }

  if (finalizedThread.deletedAt !== null) {
    const environmentId = finalizedThread.environmentId;
    deleteThread(deps.db, deps.hub, finalizedThread.id);
    requestEnvironmentCleanup(deps, {
      environmentId,
      mode: "force",
    });
    await advanceEnvironmentCleanup(deps, { environmentId });
    return true;
  }

  if (finalizedThread.archivedAt !== null) {
    await advanceEnvironmentCleanup(deps, {
      environmentId: finalizedThread.environmentId,
    });
  }

  return true;
}
