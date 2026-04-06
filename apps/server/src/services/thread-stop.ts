import {
  getActiveSession,
  getCommand,
  getThreadOperation,
  markThreadOperationQueued,
  markThreadStopRequested,
  queueCommand,
  upsertThreadOperation,
  type ThreadOperationRow,
} from "@bb/db";
import type {
  PromptInput,
  ResolvedThreadExecutionOptions,
  Thread,
  WorkspaceProvisionType,
} from "@bb/domain";
import {
  threadStartCommandSchema,
  threadStopCommandSchema,
} from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { getLastProviderThreadId } from "./thread-events.js";
import {
  buildThreadStartCommand,
  buildThreadStopCommand,
  queueTurnRunCommand,
  type QueueThreadStartCommandArgs,
  type QueueThreadStopCommandArgs,
} from "./thread-commands.js";
import { requireConnectedHostSession } from "./entity-lookup.js";

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

function isActiveThreadOperationState(
  state: ThreadOperationRow["state"],
): boolean {
  return state === "requested" || state === "queued" || state === "fetched";
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
    && isActiveThreadOperationState(existingOperation.state)
    && hasQueuedThreadOperationCommand(deps, existingOperation.commandId)
  ) {
    return;
  }

  const command = await buildThreadStartCommand(deps, args);
  upsertThreadOperation(deps.db, {
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
  if (!operation || !isActiveThreadOperationState(operation.state)) {
    return null;
  }

  if (hasQueuedThreadOperationCommand(deps, operation.commandId)) {
    return operation.commandId;
  }

  const session = getActiveSession(deps.db, args.hostId);
  if (!session || session.leaseExpiresAt <= Date.now()) {
    return null;
  }

  const command = threadStartCommandSchema.parse(JSON.parse(operation.payload));
  const queuedCommand = queueCommand(deps.db, deps.hub, {
    hostId: args.hostId,
    sessionId: session.id,
    type: command.type,
    payload: JSON.stringify(command),
  });
  markThreadOperationQueued(deps.db, {
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
    && isActiveThreadOperationState(existingOperation.state)
    && hasQueuedThreadOperationCommand(deps, existingOperation.commandId)
  ) {
    return;
  }

  const command = buildThreadStopCommand(args);
  upsertThreadOperation(deps.db, {
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
  if (!operation || !isActiveThreadOperationState(operation.state)) {
    return null;
  }

  if (hasQueuedThreadOperationCommand(deps, operation.commandId)) {
    return operation.commandId;
  }

  const session = getActiveSession(deps.db, args.hostId);
  const command = threadStopCommandSchema.parse(JSON.parse(operation.payload));
  const queuedCommand = queueCommand(deps.db, deps.hub, {
    hostId: args.hostId,
    sessionId: session?.id ?? null,
    type: command.type,
    payload: JSON.stringify(command),
  });
  markThreadOperationQueued(deps.db, {
    threadId: args.threadId,
    kind: "stop",
    commandId: queuedCommand.id,
  });
  return queuedCommand.id;
}
