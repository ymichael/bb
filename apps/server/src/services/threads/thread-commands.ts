import {
  getActiveSession,
  queueCommand,
  queueCommandInTransaction,
  transitionThreadStatus,
} from "@bb/db";
import type {
  DbTransaction,
} from "@bb/db";
import type {
  PromptInput,
  ProjectExecutionDefaults,
  PermissionEscalation,
  ResolvedThreadExecutionOptions,
  RuntimeThreadExecutionOptions,
  Thread,
  WorkspaceProvisionType,
} from "@bb/domain";
import type {
  CreateThreadRequest,
} from "@bb/server-contract";
import type { HostDaemonCommand, TurnSubmitTarget } from "@bb/host-daemon-contract";
import type { AppDeps, SandboxWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { getLastProviderThreadId } from "./thread-events.js";
import {
  resolveExecutionOptions,
  resolveThreadRuntimeCommandConfig,
  type ResolvedThreadRuntimeCommandConfig,
  type ThreadRuntimeCommandEnvironment,
} from "./thread-runtime-config.js";

export interface ExecutionOptionsRequest {
  model?: CreateThreadRequest["model"];
  permissionMode?: CreateThreadRequest["permissionMode"];
  reasoningLevel?: CreateThreadRequest["reasoningLevel"];
  serviceTier?: CreateThreadRequest["serviceTier"];
}

export interface QueueThreadStopCommandArgs {
  environmentId: string;
  hostId: string;
  threadId: string;
}

export interface QueueThreadStartCommandEnvironment {
  hostId: string;
  id: string;
  path: string | null;
  workspaceProvisionType: WorkspaceProvisionType;
}

export interface ThreadHostCommandEnvironment {
  hostId: string;
  id: string;
}

export interface QueueThreadStartCommandArgs {
  eventSequence: number;
  environment: QueueThreadStartCommandEnvironment;
  execution: ResolvedThreadExecutionOptions;
  permissionEscalation: PermissionEscalation;
  input: PromptInput[];
  projectId: string;
  providerId: string;
  thread: Thread;
}

export interface TurnSubmitCommandPayloadArgs {
  environmentId: string;
  eventSequence: number;
  execution: ResolvedThreadExecutionOptions;
  permissionEscalation: PermissionEscalation;
  input: PromptInput[];
  providerThreadId: string;
  runtimeContext: ResolvedThreadRuntimeCommandConfig;
  target: TurnSubmitTarget;
  threadId: string;
}

export interface PrepareTurnSubmitCommandPayloadArgs {
  environment: ThreadRuntimeCommandEnvironment;
  execution: ResolvedThreadExecutionOptions;
  permissionEscalation: PermissionEscalation;
  input: PromptInput[];
  providerThreadId?: string;
  target: TurnSubmitTarget;
  thread: Thread;
}

export interface CreateTurnSubmitCommandPayloadArgs extends PrepareTurnSubmitCommandPayloadArgs {
  eventSequence: number;
}

export interface FinalizeTurnSubmitCommandPayloadArgs {
  eventSequence: number;
  preparedCommand: PreparedTurnSubmitCommandPayload;
}

export type PreparedTurnSubmitCommandPayload = Omit<
  Extract<HostDaemonCommand, { type: "turn.submit" }>,
  "eventSequence"
>;
type PreparedTurnSubmitCommandBuildArgs = Omit<TurnSubmitCommandPayloadArgs, "eventSequence">;

interface RuntimeExecutionOptionsArgs {
  execution: ResolvedThreadExecutionOptions;
  permissionEscalation: PermissionEscalation;
}

interface BuildExecutionOptionsArgs {
  projectDefaults?: ProjectExecutionDefaults | null;
  threadId: string;
}

type BuildExecutionOptionsSource =
  | "client/thread/start"
  | "client/turn/requested"
  | "client/turn/start";

interface QueueTurnSubmitCommandInTransactionArgs {
  command: Extract<HostDaemonCommand, { type: "turn.submit" }>;
  hostId: string;
  sessionId: string | null;
}

export interface QueueTurnSubmitCommandArgs extends PrepareTurnSubmitCommandPayloadArgs {
  eventSequence: number;
}

export interface QueueThreadRenameCommandArgs {
  environment: ThreadHostCommandEnvironment;
  threadId: string;
  title: string;
}

export interface QueueThreadDeletedCommandArgs {
  environment: ThreadHostCommandEnvironment;
  threadId: string;
}

function toRuntimeExecutionOptions(
  args: RuntimeExecutionOptionsArgs,
): RuntimeThreadExecutionOptions {
  const base = {
    model: args.execution.model,
    serviceTier: args.execution.serviceTier,
    reasoningLevel: args.execution.reasoningLevel,
  };
  if (args.execution.permissionMode === "full") {
    return {
      ...base,
      permissionMode: args.execution.permissionMode,
      permissionEscalation: null,
    };
  }
  return {
    ...base,
    permissionMode: args.execution.permissionMode,
    permissionEscalation: args.permissionEscalation,
  };
}

export async function buildExecutionOptions(
  deps: Pick<AppDeps, "db" | "hub">,
  request: ExecutionOptionsRequest,
  args: BuildExecutionOptionsArgs,
  source: BuildExecutionOptionsSource,
): Promise<ResolvedThreadExecutionOptions> {
  return resolveExecutionOptions(deps, {
    ...(args.projectDefaults ? { projectDefaults: args.projectDefaults } : {}),
    requestedExecution: {
      ...(request.model ? { model: request.model } : {}),
      ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
      ...(request.reasoningLevel ? { reasoningLevel: request.reasoningLevel } : {}),
      ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
      source,
    },
    threadId: args.threadId,
  });
}

export async function buildThreadStartCommand(
  deps: SandboxWorkSessionDeps,
  args: QueueThreadStartCommandArgs,
): Promise<Extract<HostDaemonCommand, { type: "thread.start" }>> {
  const runtimeContext = await resolveThreadRuntimeCommandConfig(deps, {
    thread: args.thread,
    environment: args.environment,
    isThreadCreation: true,
  });
  return {
    type: "thread.start",
    environmentId: args.environment.id,
    threadId: args.thread.id,
    workspaceContext: {
      workspacePath: runtimeContext.workspacePath,
      workspaceProvisionType: runtimeContext.workspaceProvisionType,
    },
    projectId: args.projectId,
    providerId: args.providerId,
    eventSequence: args.eventSequence,
    input: args.input,
    options: toRuntimeExecutionOptions(args),
    instructions: runtimeContext.instructions,
    dynamicTools: runtimeContext.dynamicTools,
    instructionMode: runtimeContext.instructionMode,
    threadStoragePath: runtimeContext.threadStoragePath,
  };
}

function buildPreparedTurnSubmitCommandPayload(
  args: PreparedTurnSubmitCommandBuildArgs,
): PreparedTurnSubmitCommandPayload {
  return {
    type: "turn.submit",
    environmentId: args.environmentId,
    threadId: args.threadId,
    input: args.input,
    options: toRuntimeExecutionOptions(args),
    target: args.target,
    resumeContext: {
      workspaceContext: {
        workspacePath: args.runtimeContext.workspacePath,
        workspaceProvisionType: args.runtimeContext.workspaceProvisionType,
      },
      projectId: args.runtimeContext.projectId,
      providerId: args.runtimeContext.providerId,
      providerThreadId: args.providerThreadId,
      instructions: args.runtimeContext.instructions,
      dynamicTools: args.runtimeContext.dynamicTools,
      instructionMode: args.runtimeContext.instructionMode,
    },
  };
}

export function addEventSequenceToTurnSubmitCommandPayload(
  args: FinalizeTurnSubmitCommandPayloadArgs,
): Extract<HostDaemonCommand, { type: "turn.submit" }> {
  return {
    ...args.preparedCommand,
    eventSequence: args.eventSequence,
  };
}

export async function prepareTurnSubmitCommandPayload(
  deps: SandboxWorkSessionDeps,
  args: PrepareTurnSubmitCommandPayloadArgs,
): Promise<PreparedTurnSubmitCommandPayload> {
  const providerThreadId = requireProviderThreadId(
    args.providerThreadId ?? getLastProviderThreadId(deps, args.thread.id),
    args.thread.id,
  );
  const runtimeContext = await resolveThreadRuntimeCommandConfig(deps, {
    thread: args.thread,
    environment: args.environment,
  });
  return buildPreparedTurnSubmitCommandPayload({
    environmentId: args.environment.id,
    execution: args.execution,
    permissionEscalation: args.permissionEscalation,
    input: args.input,
    providerThreadId,
    runtimeContext,
    target: args.target,
    threadId: args.thread.id,
  });
}

async function createTurnSubmitCommandPayload(
  deps: SandboxWorkSessionDeps,
  args: CreateTurnSubmitCommandPayloadArgs,
): Promise<Extract<HostDaemonCommand, { type: "turn.submit" }>> {
  const preparedCommand = await prepareTurnSubmitCommandPayload(deps, args);
  return addEventSequenceToTurnSubmitCommandPayload({
    eventSequence: args.eventSequence,
    preparedCommand,
  });
}

export function queueTurnSubmitCommandInTransaction(
  db: DbTransaction,
  args: QueueTurnSubmitCommandInTransactionArgs,
) {
  return queueCommandInTransaction(db, {
    hostId: args.hostId,
    sessionId: args.sessionId,
    type: "turn.submit",
    payload: JSON.stringify(args.command),
  });
}

export async function queueTurnSubmitCommand(
  deps: SandboxWorkSessionDeps,
  args: QueueTurnSubmitCommandArgs,
): Promise<void> {
  const session = await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });
  const command = await createTurnSubmitCommandPayload(deps, args);
  queueCommand(deps.db, deps.hub, {
    hostId: args.environment.hostId,
    sessionId: session.id,
    type: "turn.submit",
    payload: JSON.stringify(command),
  });

  if (args.thread.status === "idle") {
    transitionThreadStatus(deps.db, deps.hub, args.thread.id, "active");
  }
}

function requireProviderThreadId(
  providerThreadId: string | null | undefined,
  threadId: string,
): string {
  if (!providerThreadId) {
    throw new ApiError(
      409,
      "invalid_request",
      `Thread ${threadId} has no provider session`,
    );
  }

  return providerThreadId;
}

export function queueThreadRenameCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueThreadRenameCommandArgs,
): void {
  const session = getActiveSession(deps.db, args.environment.hostId);
  queueCommand(deps.db, deps.hub, {
    hostId: args.environment.hostId,
    sessionId: session?.id ?? null,
    type: "thread.rename",
    payload: JSON.stringify({
      type: "thread.rename",
      environmentId: args.environment.id,
      threadId: args.threadId,
      title: args.title,
    }),
  });
}

export function queueThreadDeletedCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueThreadDeletedCommandArgs,
): boolean {
  const session = getActiveSession(deps.db, args.environment.hostId);
  if (!session) {
    return false;
  }
  queueCommand(deps.db, deps.hub, {
    hostId: args.environment.hostId,
    sessionId: session.id,
    type: "thread.deleted",
    payload: JSON.stringify({
      type: "thread.deleted",
      environmentId: args.environment.id,
      threadId: args.threadId,
    }),
  });
  return true;
}

export function buildThreadStopCommand(
  args: QueueThreadStopCommandArgs,
): Extract<HostDaemonCommand, { type: "thread.stop" }> {
  return {
    type: "thread.stop",
    environmentId: args.environmentId,
    threadId: args.threadId,
  };
}
