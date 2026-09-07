import { environments, events, threads } from "@bb/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  PromptInput,
  PromptMode,
  ProjectExecutionDefaults,
  PermissionEscalation,
  ResolvedThreadExecutionOptions,
  RuntimeThreadExecutionOptions,
  Thread,
  ClientTurnRequestId,
  EnvironmentStatus,
  promptInputHasCommandMention,
} from "@bb/domain";
import {
  type HostDaemonCommand,
  type ThreadStopIntent,
  type TurnSubmitTarget,
} from "@bb/host-daemon-contract";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import { ApiError } from "../../errors.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  startLiveHostCommand,
} from "../hosts/live-command.js";
import { getLastProviderThreadId } from "./thread-events.js";
import type { ThreadForkDescriptor } from "./thread-provisioning-context.js";
import {
  resolveThreadRuntimeCommandConfig,
  type ResolvedThreadRuntimeCommandConfig,
  type ThreadRuntimeCommandEnvironment,
} from "./thread-runtime-config.js";
import {
  buildExistingThreadExecutionInput,
  resolveExistingThreadExecutionPlan,
  type ExistingThreadExecutionInputRequest,
} from "./thread-execution-plan.js";
import { clampPermissionModeToHost } from "../hosts/permission-ceiling.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { resolveProviderPlanCommand } from "../providers/provider-plan-command.js";
import { workspaceContextFromPath } from "../environments/workspace-command-target.js";
import {
  requireBridgeLaunchForProviderId,
  resolveBridgeLaunchForProviderId,
} from "../system/provider-bridge-launch.js";

type ExecutionOptionsRequest = ExistingThreadExecutionInputRequest;

export interface ThreadStopCommandArgs {
  environmentId: string;
  hostId: string;
  intent: ThreadStopIntent;
  threadId: string;
}

interface ThreadHostCommandEnvironment {
  hostId: string;
  id: string;
}

interface ThreadUnarchiveCommandEnvironment {
  hostId: string;
  id: string;
  status: EnvironmentStatus;
}

export interface ThreadStartCommandArgs {
  environment: ThreadRuntimeCommandEnvironment;
  execution: ResolvedThreadExecutionOptions;
  fork: ThreadForkDescriptor | null;
  permissionEscalation: PermissionEscalation;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  projectId: string;
  providerId: string;
  requestId: ClientTurnRequestId;
  syncGeneratedTitle: boolean;
  thread: Thread;
}

interface PreparedTurnSubmitCommandBuildArgs {
  deps: Pick<
    AppDeps,
    "config" | "db" | "providerRegistry" | "pluginHostArtifacts"
  >;
  environmentId: string;
  hostId: string;
  execution: ResolvedThreadExecutionOptions;
  permissionEscalation: PermissionEscalation;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  providerThreadId: string;
  runtimeContext: ResolvedThreadRuntimeCommandConfig;
  target: TurnSubmitTarget;
  threadId: string;
}

interface PrepareTurnSubmitCommandPayloadArgs {
  environment: ThreadRuntimeCommandEnvironment;
  execution: ResolvedThreadExecutionOptions;
  permissionEscalation: PermissionEscalation;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  providerThreadId?: string;
  target: TurnSubmitTarget;
  thread: Thread;
}

interface FinalizeTurnSubmitCommandPayloadArgs {
  requestId: ClientTurnRequestId;
  preparedCommand: PreparedTurnSubmitCommandPayload;
}

export type PreparedTurnSubmitCommandPayload = Omit<
  Extract<HostDaemonCommand, { type: "turn.submit" }>,
  "requestId"
>;

interface RuntimeExecutionOptionsArgs {
  deps: Pick<AppDeps, "db" | "providerRegistry">;
  execution: ResolvedThreadExecutionOptions;
  hostId: string;
  input: PromptInput[];
  permissionEscalation: PermissionEscalation;
  projectId: string;
  providerId: string;
  threadId: string;
}

interface BuildExecutionOptionsArgs {
  hostId?: string | null;
  projectDefaults?: ProjectExecutionDefaults | null;
  threadId: string;
}

interface DispatchThreadRenameCommandArgs {
  environment: ThreadHostCommandEnvironment;
  providerId: string;
  threadId: string;
  title: string;
}

interface DispatchThreadUnarchiveCommandArgs {
  environment: ThreadUnarchiveCommandEnvironment;
  providerThreadId: string;
  thread: Thread;
}

interface DispatchArchivedThreadProviderArchiveCommandArgs {
  threadId: string;
}

function providerSupportsThreadRename(
  registry: ProviderRegistryService,
  providerId: string,
): boolean {
  const registration = registry.get(providerId);
  if (!registration) {
    return true;
  }
  return registration.info.capabilities.supportsThreadRename;
}

function providerSupportsThreadArchiveForwarding(
  registry: ProviderRegistryService,
  providerId: string,
): boolean {
  const registration = registry.get(providerId);
  if (!registration) {
    return false;
  }
  return registration.info.capabilities.supportsThreadArchive;
}

function resolvePromptMode(
  registry: ProviderRegistryService,
  args: { input: PromptInput[]; providerId: string },
): PromptMode | undefined {
  const planCommand = resolveProviderPlanCommand(registry, args.providerId);
  if (planCommand === null) return undefined;
  return promptInputHasCommandMention(args.input, {
    trigger: planCommand.trigger,
    name: planCommand.name,
  })
    ? "plan"
    : undefined;
}

function toRuntimeExecutionOptions(
  args: RuntimeExecutionOptionsArgs,
): RuntimeThreadExecutionOptions {
  const permissionMode = clampPermissionModeToHost(args.deps, {
    hostId: args.hostId,
    permissionMode: args.execution.permissionMode,
    providerId: args.providerId,
  });
  const promptMode = resolvePromptMode(args.deps.providerRegistry, {
    input: args.input,
    providerId: args.providerId,
  });
  const providerOptions =
    args.deps.providerRegistry.get(args.providerId)?.deriveProviderOptions({
      threadId: args.threadId,
      projectId: args.projectId,
      model: args.execution.model,
      permissionMode,
      ...(promptMode !== undefined ? { promptMode } : {}),
    }) ?? {};
  const base = {
    model: args.execution.model,
    serviceTier: args.execution.serviceTier,
    reasoningLevel: args.execution.reasoningLevel,
    ...(promptMode !== undefined ? { promptMode } : {}),
    providerOptions,
  };
  if (permissionMode === "full") {
    return {
      ...base,
      permissionMode,
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    };
  }
  if (permissionMode === "auto") {
    return {
      ...base,
      permissionMode: "auto",
      permissionScope: "workspace",
      approvalReviewer: "automatic",
      permissionEscalation: args.permissionEscalation,
    };
  }
  return {
    ...base,
    permissionMode: "accept-edits",
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: args.permissionEscalation,
  };
}

export async function buildExecutionOptions(
  deps: Pick<AppDeps, "db" | "hub" | "providerRegistry">,
  request: ExecutionOptionsRequest,
  args: BuildExecutionOptionsArgs,
): Promise<ResolvedThreadExecutionOptions> {
  const plan = await resolveExistingThreadExecutionPlan(deps, {
    ...(args.projectDefaults !== undefined
      ? { projectDefaults: args.projectDefaults }
      : {}),
    ...(args.hostId !== undefined ? { hostId: args.hostId } : {}),
    executionSource: "client/turn/requested",
    input: buildExistingThreadExecutionInput(request),
    threadId: args.threadId,
  });
  return plan.resolvedExecution;
}

export async function buildThreadStartCommand(
  deps: LoggedWorkSessionDeps,
  args: ThreadStartCommandArgs,
): Promise<Extract<HostDaemonCommand, { type: "thread.start" }>> {
  await deps.providerRegistry.whenRegistrationsSettled();
  const runtimeContext = await resolveThreadRuntimeCommandConfig(deps, {
    thread: args.thread,
    environment: args.environment,
    model: args.execution.model,
  });
  const bridgeLaunch = requireBridgeLaunchForProviderId(deps, args.providerId);
  return {
    type: "thread.start",
    environmentId: args.environment.id,
    threadId: args.thread.id,
    workspaceContext: workspaceContextFromPath({
      path: runtimeContext.workspacePath,
      workspaceProvisionType: runtimeContext.workspaceProvisionType,
    }),
    projectId: args.projectId,
    providerId: args.providerId,
    bridgeLaunch,
    requestId: args.requestId,
    input: args.input,
    ...(args.inputGroups !== undefined
      ? { inputGroups: args.inputGroups }
      : {}),
    options: toRuntimeExecutionOptions({
      ...args,
      deps,
      hostId: args.environment.hostId,
      input: args.input,
      threadId: args.thread.id,
    }),
    instructions: runtimeContext.instructions,
    dynamicTools: runtimeContext.dynamicTools,
    contributedEnv: runtimeContext.contributedEnv,
    injectedSkillSources: runtimeContext.injectedSkillSources,
    instructionMode: runtimeContext.instructionMode,
    threadStoragePath: runtimeContext.threadStoragePath,
    ...(args.fork ? { fork: args.fork } : {}),
  };
}

function buildPreparedTurnSubmitCommandPayload(
  args: PreparedTurnSubmitCommandBuildArgs,
): PreparedTurnSubmitCommandPayload {
  const bridgeLaunch = requireBridgeLaunchForProviderId(
    args.deps,
    args.runtimeContext.providerId,
  );
  return {
    type: "turn.submit",
    environmentId: args.environmentId,
    threadId: args.threadId,
    bridgeLaunch,
    input: args.input,
    ...(args.inputGroups !== undefined
      ? { inputGroups: args.inputGroups }
      : {}),
    options: toRuntimeExecutionOptions({
      ...args,
      input: args.input,
      projectId: args.runtimeContext.projectId,
      providerId: args.runtimeContext.providerId,
    }),
    target: args.target,
    resumeContext: {
      workspaceContext: workspaceContextFromPath({
        path: args.runtimeContext.workspacePath,
        workspaceProvisionType: args.runtimeContext.workspaceProvisionType,
      }),
      projectId: args.runtimeContext.projectId,
      providerId: args.runtimeContext.providerId,
      bridgeLaunch,
      providerThreadId: args.providerThreadId,
      instructions: args.runtimeContext.instructions,
      dynamicTools: args.runtimeContext.dynamicTools,
      contributedEnv: args.runtimeContext.contributedEnv,
      injectedSkillSources: args.runtimeContext.injectedSkillSources,
      instructionMode: args.runtimeContext.instructionMode,
    },
  };
}

export function addRequestIdToTurnSubmitCommandPayload(
  args: FinalizeTurnSubmitCommandPayloadArgs,
): Extract<HostDaemonCommand, { type: "turn.submit" }> {
  return {
    ...args.preparedCommand,
    requestId: args.requestId,
  };
}

export async function prepareTurnSubmitCommandPayload(
  deps: LoggedWorkSessionDeps,
  args: PrepareTurnSubmitCommandPayloadArgs,
): Promise<PreparedTurnSubmitCommandPayload> {
  await deps.providerRegistry.whenRegistrationsSettled();
  const providerThreadId = requireProviderThreadId(
    args.providerThreadId ?? getLastProviderThreadId(deps, args.thread.id),
    args.thread.id,
  );
  const runtimeContext = await resolveThreadRuntimeCommandConfig(deps, {
    thread: args.thread,
    environment: args.environment,
    model: args.execution.model,
  });
  return buildPreparedTurnSubmitCommandPayload({
    deps,
    environmentId: args.environment.id,
    hostId: args.environment.hostId,
    execution: args.execution,
    permissionEscalation: args.permissionEscalation,
    input: args.input,
    ...(args.inputGroups !== undefined
      ? { inputGroups: args.inputGroups }
      : {}),
    providerThreadId,
    runtimeContext,
    target: args.target,
    threadId: args.thread.id,
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

function threadHasLiveChildren(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): boolean {
  const row = deps.db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.parentThreadId, threadId),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

function threadHasCodexSpawnAgentToolCall(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): boolean {
  const row = deps.db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.itemKind, "toolCall"),
        sql`json_extract(${events.data}, '$.item.tool') = 'spawnAgent'`,
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

export function dispatchThreadRenameCommand(
  deps: CommandResultSideEffectsDeps,
  args: DispatchThreadRenameCommandArgs,
): void {
  if (!providerSupportsThreadRename(deps.providerRegistry, args.providerId)) {
    return;
  }

  startLiveHostCommand(deps, {
    command: {
      type: "thread.rename",
      environmentId: args.environment.id,
      threadId: args.threadId,
      title: args.title,
    },
    hostId: args.environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: args.threadId },
        "Live thread rename command failed",
      );
    },
  });
}

export function dispatchArchivedThreadProviderArchiveCommand(
  deps: CommandResultSideEffectsDeps,
  args: DispatchArchivedThreadProviderArchiveCommandArgs,
): boolean {
  const thread = deps.db
    .select()
    .from(threads)
    .where(eq(threads.id, args.threadId))
    .get();
  if (!thread || thread.archivedAt === null || thread.deletedAt !== null) {
    return false;
  }

  const providerThreadId = getLastProviderThreadId(deps, thread.id);
  if (!providerThreadId || !thread.environmentId) {
    return false;
  }

  const environment = deps.db
    .select()
    .from(environments)
    .where(eq(environments.id, thread.environmentId))
    .get();
  if (!environment) {
    return false;
  }
  if (environment.status !== "ready") {
    return false;
  }

  if (
    !providerSupportsThreadArchiveForwarding(
      deps.providerRegistry,
      thread.providerId,
    )
  ) {
    return false;
  }

  if (
    threadHasLiveChildren(deps, thread.id) ||
    threadHasCodexSpawnAgentToolCall(deps, thread.id)
  ) {
    return false;
  }

  if (!environment.path) {
    return false;
  }
  const workspaceContext = workspaceContextFromPath({
    path: environment.path,
    workspaceProvisionType: environment.workspaceProvisionType,
  });

  const bridgeLaunch = resolveBridgeLaunchForProviderId(
    deps,
    thread.providerId,
  );
  if (bridgeLaunch === null) {
    return false;
  }

  startLiveHostCommand(deps, {
    command: {
      type: "thread.archive",
      environmentId: environment.id,
      threadId: thread.id,
      workspaceContext,
      providerId: thread.providerId,
      providerThreadId,
      bridgeLaunch,
    },
    hostId: environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: thread.id },
        "Live thread archive command failed",
      );
    },
  });
  return true;
}

export function dispatchThreadUnarchiveCommand(
  deps: CommandResultSideEffectsDeps,
  args: DispatchThreadUnarchiveCommandArgs,
): boolean {
  if (
    !providerSupportsThreadArchiveForwarding(
      deps.providerRegistry,
      args.thread.providerId,
    )
  ) {
    return false;
  }
  if (args.environment.status !== "ready") {
    return false;
  }

  const bridgeLaunch = resolveBridgeLaunchForProviderId(
    deps,
    args.thread.providerId,
  );
  if (bridgeLaunch === null) {
    return false;
  }

  startLiveHostCommand(deps, {
    command: {
      type: "thread.unarchive",
      environmentId: args.environment.id,
      threadId: args.thread.id,
      providerId: args.thread.providerId,
      providerThreadId: args.providerThreadId,
      bridgeLaunch,
    },
    hostId: args.environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: args.thread.id },
        "Live thread unarchive command failed",
      );
    },
  });
  return true;
}

export function buildThreadStopCommand(
  args: ThreadStopCommandArgs,
): Extract<HostDaemonCommand, { type: "thread.stop" }> {
  return {
    type: "thread.stop",
    environmentId: args.environmentId,
    intent: args.intent,
    threadId: args.threadId,
  };
}
