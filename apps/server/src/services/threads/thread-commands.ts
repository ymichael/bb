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
  ResolvedThreadExecutionOptions,
  Thread,
  WorkspaceProvisionType,
} from "@bb/domain";
import type {
  CreateThreadRequest,
} from "@bb/server-contract";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
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
  reasoningLevel?: CreateThreadRequest["reasoningLevel"];
  sandboxMode?: CreateThreadRequest["sandboxMode"];
  serviceTier?: CreateThreadRequest["serviceTier"];
}

export interface QueueThreadStopCommandArgs {
  environmentId: string;
  hostId: string;
  threadId: string;
}

export interface QueueThreadStartCommandArgs {
  eventSequence: number;
  environment: {
    hostId: string;
    id: string;
    path: string | null;
    workspaceProvisionType: WorkspaceProvisionType;
  };
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  projectId: string;
  providerId: string;
  thread: Thread;
}

export interface TurnRunCommandPayloadArgs {
  environmentId: string;
  eventSequence: number;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  providerThreadId: string;
  runtimeContext: ResolvedThreadRuntimeCommandConfig;
  threadId: string;
}

export interface PrepareTurnRunCommandPayloadArgs {
  environment: ThreadRuntimeCommandEnvironment;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  providerThreadId?: string;
  thread: Thread;
}

export interface CreateTurnRunCommandPayloadArgs extends PrepareTurnRunCommandPayloadArgs {
  eventSequence: number;
}

export interface FinalizeTurnRunCommandPayloadArgs {
  eventSequence: number;
  preparedCommand: PreparedTurnRunCommandPayload;
}

export type PreparedTurnRunCommandPayload = Omit<
  Extract<HostDaemonCommand, { type: "turn.run" }>,
  "eventSequence"
>;
type PreparedTurnRunCommandBuildArgs = Omit<TurnRunCommandPayloadArgs, "eventSequence">;

export async function buildExecutionOptions(
  deps: Pick<AppDeps, "db" | "hub">,
  request: ExecutionOptionsRequest,
  args: {
    projectDefaults?: ProjectExecutionDefaults | null;
    threadId: string;
  },
  source: "client/thread/start" | "client/turn/requested" | "client/turn/start",
): Promise<ResolvedThreadExecutionOptions> {
  return resolveExecutionOptions(deps, {
    ...(args.projectDefaults ? { projectDefaults: args.projectDefaults } : {}),
    requestedExecution: {
      ...(request.model ? { model: request.model } : {}),
      ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
      ...(request.reasoningLevel ? { reasoningLevel: request.reasoningLevel } : {}),
      ...(request.sandboxMode ? { sandboxMode: request.sandboxMode } : {}),
      source,
    },
    threadId: args.threadId,
  });
}

export async function buildThreadStartCommand(
  deps: Pick<AppDeps, "db" | "hub">,
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
    options: args.execution,
    instructions: runtimeContext.instructions,
    dynamicTools: runtimeContext.dynamicTools,
    threadStoragePath: runtimeContext.threadStoragePath,
  };
}

function buildPreparedTurnRunCommandPayload(
  args: PreparedTurnRunCommandBuildArgs,
): PreparedTurnRunCommandPayload {
  return {
    type: "turn.run",
    environmentId: args.environmentId,
    threadId: args.threadId,
    input: args.input,
    options: args.execution,
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
    },
  };
}

export function addEventSequenceToTurnRunCommandPayload(
  args: FinalizeTurnRunCommandPayloadArgs,
): Extract<HostDaemonCommand, { type: "turn.run" }> {
  return {
    ...args.preparedCommand,
    eventSequence: args.eventSequence,
  };
}

export async function prepareTurnRunCommandPayload(
  deps: Pick<AppDeps, "db" | "hub">,
  args: PrepareTurnRunCommandPayloadArgs,
): Promise<PreparedTurnRunCommandPayload> {
  const providerThreadId = requireProviderThreadId(
    args.providerThreadId ?? getLastProviderThreadId(deps, args.thread.id),
    args.thread.id,
  );
  const runtimeContext = await resolveThreadRuntimeCommandConfig(deps, {
    thread: args.thread,
    environment: args.environment,
  });
  return buildPreparedTurnRunCommandPayload({
    environmentId: args.environment.id,
    execution: args.execution,
    input: args.input,
    providerThreadId,
    runtimeContext,
    threadId: args.thread.id,
  });
}

async function createTurnRunCommandPayload(
  deps: Pick<AppDeps, "db" | "hub">,
  args: CreateTurnRunCommandPayloadArgs,
): Promise<Extract<HostDaemonCommand, { type: "turn.run" }>> {
  const preparedCommand = await prepareTurnRunCommandPayload(deps, args);
  return addEventSequenceToTurnRunCommandPayload({
    eventSequence: args.eventSequence,
    preparedCommand,
  });
}

export function queueTurnRunCommandInTransaction(
  db: DbTransaction,
  args: {
    command: Extract<HostDaemonCommand, { type: "turn.run" }>;
    hostId: string;
    sessionId: string | null;
  },
) {
  return queueCommandInTransaction(db, {
    hostId: args.hostId,
    sessionId: args.sessionId,
    type: "turn.run",
    payload: JSON.stringify(args.command),
  });
}

export async function queueTurnRunCommand(
  deps: SandboxWorkSessionDeps,
  args: {
    eventSequence: number;
    environment: ThreadRuntimeCommandEnvironment;
    execution: ResolvedThreadExecutionOptions;
    input: PromptInput[];
    providerThreadId?: string;
    thread: Thread;
  },
): Promise<void> {
  const session = await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });
  const command = await createTurnRunCommandPayload(deps, args);
  queueCommand(deps.db, deps.hub, {
    hostId: args.environment.hostId,
    sessionId: session.id,
    type: "turn.run",
    payload: JSON.stringify(command),
  });

  if (args.thread.status === "idle") {
    transitionThreadStatus(deps.db, deps.hub, args.thread.id, "active");
  }
}

export async function queueTurnSteerCommand(
  deps: SandboxWorkSessionDeps,
  args: {
    eventSequence: number;
    environment: ThreadRuntimeCommandEnvironment;
    execution: ResolvedThreadExecutionOptions;
    expectedTurnId: string;
    input: PromptInput[];
    providerThreadId?: string;
    thread: Thread;
  },
): Promise<void> {
  const session = await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });
  const providerThreadId = requireProviderThreadId(
    args.providerThreadId ?? getLastProviderThreadId(deps, args.thread.id),
    args.thread.id,
  );
  const runtimeContext = await resolveThreadRuntimeCommandConfig(deps, {
    thread: args.thread,
    environment: args.environment,
  });
  queueCommand(deps.db, deps.hub, {
    hostId: args.environment.hostId,
    sessionId: session.id,
    type: "turn.steer",
    payload: JSON.stringify({
      type: "turn.steer",
      environmentId: args.environment.id,
      threadId: args.thread.id,
      eventSequence: args.eventSequence,
      expectedTurnId: args.expectedTurnId,
      input: args.input,
      options: args.execution,
      resumeContext: {
        workspaceContext: {
          workspacePath: runtimeContext.workspacePath,
          workspaceProvisionType: runtimeContext.workspaceProvisionType,
        },
        projectId: runtimeContext.projectId,
        providerId: runtimeContext.providerId,
        providerThreadId,
        instructions: runtimeContext.instructions,
        dynamicTools: runtimeContext.dynamicTools,
      },
    }),
  });
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
  args: {
    environment: {
      hostId: string;
      id: string;
    };
    threadId: string;
    title: string;
  },
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
  args: {
    environment: {
      hostId: string;
      id: string;
    };
    threadId: string;
  },
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
