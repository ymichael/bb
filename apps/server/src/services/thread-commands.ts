import {
  hostDaemonCommands,
  getActiveSession,
  queueCommand,
  transitionThreadStatus,
} from "@bb/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  PromptInput,
  ResolvedThreadExecutionOptions,
  Thread,
  WorkspaceProvisionType,
} from "@bb/domain";
import type {
  CreateThreadRequest,
} from "@bb/server-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requireConnectedHostSession } from "./entity-lookup.js";
import { getLastProviderThreadId } from "./thread-events.js";
import {
  resolveExecutionOptions,
  resolveThreadRuntimeCommandConfig,
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

export async function buildExecutionOptions(
  deps: Pick<AppDeps, "db" | "hub">,
  request: ExecutionOptionsRequest,
  args: {
    threadId: string;
  },
  source: "client/thread/start" | "client/turn/requested" | "client/turn/start",
): Promise<ResolvedThreadExecutionOptions> {
  return resolveExecutionOptions(deps, {
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

export async function queueThreadStartCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
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
  },
): Promise<void> {
  const runtimeContext = await resolveThreadRuntimeCommandConfig(deps, {
    thread: args.thread,
    environment: args.environment,
    isThreadCreation: true,
  });
  const session = requireConnectedHostSession(deps, args.environment.hostId);
  queueCommand(deps.db, deps.hub, {
    hostId: args.environment.hostId,
    sessionId: session.id,
    type: "thread.start",
    payload: JSON.stringify({
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
    }),
  });
}

export async function queueReadyThreadTurnCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environment: ThreadRuntimeCommandEnvironment & { path: string };
    eventSequence: number;
    execution: ResolvedThreadExecutionOptions;
    input: PromptInput[];
    thread: Thread;
  },
): Promise<void> {
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
    return;
  }

  await queueThreadStartCommand(deps, {
    thread: args.thread,
    environment: args.environment,
    input: args.input,
    eventSequence: args.eventSequence,
    execution: args.execution,
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
  });
}

export async function queueTurnRunCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    eventSequence: number;
    environment: ThreadRuntimeCommandEnvironment;
    execution: ResolvedThreadExecutionOptions;
    input: PromptInput[];
    providerThreadId?: string;
    thread: Thread;
  },
): Promise<void> {
  const session = requireConnectedHostSession(deps, args.environment.hostId);
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
    type: "turn.run",
    payload: JSON.stringify({
      type: "turn.run",
      environmentId: args.environment.id,
      threadId: args.thread.id,
      eventSequence: args.eventSequence,
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

  if (args.thread.status === "idle") {
    transitionThreadStatus(deps.db, deps.hub, args.thread.id, "active");
  }
}

export async function queueTurnSteerCommand(
  deps: Pick<AppDeps, "db" | "hub">,
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
  const session = requireConnectedHostSession(deps, args.environment.hostId);
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

export function queueThreadStopCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueThreadStopCommandArgs,
): void {
  const existing = deps.db
    .select({ id: hostDaemonCommands.id })
    .from(hostDaemonCommands)
    .where(
      and(
        eq(hostDaemonCommands.hostId, args.hostId),
        eq(hostDaemonCommands.type, "thread.stop"),
        inArray(hostDaemonCommands.state, ["pending", "fetched"]),
        sql`json_extract(${hostDaemonCommands.payload}, '$.threadId') = ${args.threadId}`,
      ),
    )
    .get();

  if (existing) {
    return;
  }

  const session = getActiveSession(deps.db, args.hostId);
  queueCommand(deps.db, deps.hub, {
    hostId: args.hostId,
    sessionId: session?.id ?? null,
    type: "thread.stop",
    payload: JSON.stringify({
      type: "thread.stop",
      environmentId: args.environmentId,
      threadId: args.threadId,
    }),
  });
}
