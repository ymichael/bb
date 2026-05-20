import {
  getActiveSession,
  queueCommand,
  queueCommandInTransaction,
  hasPendingHostCommandForThread,
  hostDaemonCommands,
  environments,
  events,
  transitionThreadStatus,
  threads,
} from "@bb/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type AgentProviderId,
  getBuiltInAgentProviderInfo,
  isAgentProviderId,
} from "@bb/agent-providers";
import type { DbTransaction } from "@bb/db";
import type {
  Environment,
  PromptInput,
  ProjectExecutionDefaults,
  PermissionEscalation,
  ResolvedThreadExecutionOptions,
  RuntimeThreadExecutionOptions,
  Thread,
  ClientTurnRequestId,
  ManagerTemplateName,
  WorkspaceProvisionType,
} from "@bb/domain";
import type { CreateThreadRequest } from "@bb/server-contract";
import type {
  HostDaemonCommand,
  TurnSubmitTarget,
  WorkspaceContext,
} from "@bb/host-daemon-contract";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { getLastProviderThreadId } from "./thread-events.js";
import {
  resolveExecutionOptions,
  resolveThreadRuntimeCommandConfig,
  type ResolvedThreadRuntimeCommandConfig,
  type ThreadRuntimeCommandEnvironment,
} from "./thread-runtime-config.js";
import { appendManagerToolReminder } from "./manager-tool-reminder.js";

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

export interface ThreadCommandHost {
  hostId: string;
}

export interface ThreadWorkspaceCommandEnvironment extends ThreadHostCommandEnvironment {
  path: string | null;
  workspaceProvisionType: WorkspaceProvisionType;
}

export interface QueueThreadStartCommandArgs {
  environment: QueueThreadStartCommandEnvironment;
  execution: ResolvedThreadExecutionOptions;
  permissionEscalation: PermissionEscalation;
  input: PromptInput[];
  managerTemplateName: ManagerTemplateName | null;
  projectId: string;
  providerId: string;
  requestId: ClientTurnRequestId;
  thread: Thread;
}

export interface TurnSubmitCommandPayloadArgs {
  environmentId: string;
  execution: ResolvedThreadExecutionOptions;
  permissionEscalation: PermissionEscalation;
  input: PromptInput[];
  providerThreadId: string;
  requestId: ClientTurnRequestId;
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
  requestId: ClientTurnRequestId;
}

export interface FinalizeTurnSubmitCommandPayloadArgs {
  requestId: ClientTurnRequestId;
  preparedCommand: PreparedTurnSubmitCommandPayload;
}

export type PreparedTurnSubmitCommandPayload = Omit<
  Extract<HostDaemonCommand, { type: "turn.submit" }>,
  "requestId"
>;
type PreparedTurnSubmitCommandBuildArgs = Omit<
  TurnSubmitCommandPayloadArgs,
  "requestId"
>;

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
  requestId: ClientTurnRequestId;
}

export interface QueueThreadRenameCommandArgs {
  environment: ThreadHostCommandEnvironment;
  providerId: string;
  threadId: string;
  title: string;
}

export interface QueueThreadArchiveCommandArgs {
  environment: ThreadWorkspaceCommandEnvironment;
  providerThreadId: string;
  thread: Thread;
}

export interface QueueThreadUnarchiveCommandArgs {
  host: ThreadCommandHost;
  providerThreadId: string;
  thread: Thread;
}

export interface EnsureThreadNativeArchiveSettledArgs {
  environment: Pick<Environment, "hostId">;
  thread: Pick<Thread, "id">;
}

export interface QueueArchivedThreadProviderArchiveCommandArgs {
  threadId: string;
}

interface ExistingThreadArchiveCommandLookup {
  hostId: string;
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

interface ThreadCommandReadDeps {
  db: AppDeps["db"];
}

export interface QueueThreadDeletedCommandArgs {
  environment: ThreadHostCommandEnvironment;
  threadId: string;
}

function providerSupportsThreadRename(providerId: string): boolean {
  if (!isAgentProviderId(providerId)) {
    return true;
  }

  return getBuiltInAgentProviderInfo(providerId).capabilities.supportsRename;
}

type ThreadArchiveForwardingAction = "archive" | "unarchive";

function providerSupportsThreadArchiveForwarding(
  providerId: string,
  action: ThreadArchiveForwardingAction,
): boolean {
  if (!isAgentProviderId(providerId)) {
    return false;
  }

  // Codex archived threads remain follow-up-capable through thread/resume.
  // Native unarchive would expose them in Codex's active list again, which is
  // not needed for BB follow-ups and can fight BB-owned archive state.
  if (providerId === "codex" && action === "unarchive") {
    return false;
  }

  return getBuiltInAgentProviderInfo(providerId).capabilities.supportsArchive;
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

function requireAgentProviderId(providerId: string): AgentProviderId {
  if (isAgentProviderId(providerId)) {
    return providerId;
  }

  throw new ApiError(
    500,
    "internal_error",
    `Manager thread has unsupported provider ${providerId}`,
  );
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
      ...(request.reasoningLevel
        ? { reasoningLevel: request.reasoningLevel }
        : {}),
      ...(request.permissionMode
        ? { permissionMode: request.permissionMode }
        : {}),
      source,
    },
    threadId: args.threadId,
  });
}

export async function buildThreadStartCommand(
  deps: LoggedWorkSessionDeps,
  args: QueueThreadStartCommandArgs,
): Promise<Extract<HostDaemonCommand, { type: "thread.start" }>> {
  const runtimeContext = await resolveThreadRuntimeCommandConfig(deps, {
    thread: args.thread,
    environment: args.environment,
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
    requestId: args.requestId,
    input: args.input,
    options: toRuntimeExecutionOptions(args),
    instructions: runtimeContext.instructions,
    dynamicTools: runtimeContext.dynamicTools,
    ...(runtimeContext.disallowedTools?.length
      ? { disallowedTools: [...runtimeContext.disallowedTools] }
      : {}),
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
      ...(args.runtimeContext.disallowedTools?.length
        ? { disallowedTools: [...args.runtimeContext.disallowedTools] }
        : {}),
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
  const providerThreadId = requireProviderThreadId(
    args.providerThreadId ?? getLastProviderThreadId(deps, args.thread.id),
    args.thread.id,
  );
  const runtimeContext = await resolveThreadRuntimeCommandConfig(deps, {
    thread: args.thread,
    environment: args.environment,
  });
  const input =
    args.thread.type === "manager"
      ? appendManagerToolReminder(
          args.input,
          requireAgentProviderId(args.thread.providerId),
        )
      : args.input;
  return buildPreparedTurnSubmitCommandPayload({
    environmentId: args.environment.id,
    execution: args.execution,
    permissionEscalation: args.permissionEscalation,
    input,
    providerThreadId,
    runtimeContext,
    target: args.target,
    threadId: args.thread.id,
  });
}

async function createTurnSubmitCommandPayload(
  deps: LoggedWorkSessionDeps,
  args: CreateTurnSubmitCommandPayloadArgs,
): Promise<Extract<HostDaemonCommand, { type: "turn.submit" }>> {
  const preparedCommand = await prepareTurnSubmitCommandPayload(deps, args);
  return addRequestIdToTurnSubmitCommandPayload({
    requestId: args.requestId,
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
  deps: LoggedWorkSessionDeps,
  args: QueueTurnSubmitCommandArgs,
): Promise<void> {
  ensureThreadNativeArchiveSettled(deps, {
    environment: args.environment,
    thread: args.thread,
  });
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

function shouldSkipArchiveForwardingForCascadeRisk(
  deps: Pick<AppDeps, "db">,
  thread: Thread,
): boolean {
  return (
    threadHasLiveChildren(deps, thread.id) ||
    threadHasCodexSpawnAgentToolCall(deps, thread.id)
  );
}

function buildThreadWorkspaceContext(
  environment: ThreadWorkspaceCommandEnvironment,
): WorkspaceContext | null {
  if (!environment.path) {
    return null;
  }

  return {
    workspacePath: environment.path,
    workspaceProvisionType: environment.workspaceProvisionType,
  };
}

function hasExistingThreadArchiveCommand(
  deps: ThreadCommandReadDeps,
  args: ExistingThreadArchiveCommandLookup,
): boolean {
  const row = deps.db
    .select({ id: hostDaemonCommands.id })
    .from(hostDaemonCommands)
    .where(
      and(
        eq(hostDaemonCommands.hostId, args.hostId),
        eq(hostDaemonCommands.type, "thread.archive"),
        // Completed command payload pruning rewrites old terminal payloads to
        // "{}" after 24h, so successful-command dedupe is intentionally bounded
        // by that retention window. Pending/fetched commands remain durable
        // enough to block active archive sync.
        inArray(hostDaemonCommands.state, ["pending", "fetched", "success"]),
        sql`json_extract(${hostDaemonCommands.payload}, '$.threadId') = ${args.threadId}`,
        sql`json_extract(${hostDaemonCommands.payload}, '$.providerId') = ${args.providerId}`,
        sql`json_extract(${hostDaemonCommands.payload}, '$.providerThreadId') = ${args.providerThreadId}`,
      ),
    )
    .get();

  return row !== undefined;
}

export function queueThreadRenameCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueThreadRenameCommandArgs,
): void {
  if (!providerSupportsThreadRename(args.providerId)) {
    return;
  }

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

export function queueThreadRenameCommandInTransaction(
  db: DbTransaction,
  args: QueueThreadRenameCommandArgs,
): boolean {
  if (!providerSupportsThreadRename(args.providerId)) {
    return false;
  }

  const session = getActiveSession(db, args.environment.hostId);
  queueCommandInTransaction(db, {
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
  return true;
}

export function queueThreadArchiveCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueThreadArchiveCommandArgs,
): boolean {
  if (
    !providerSupportsThreadArchiveForwarding(args.thread.providerId, "archive")
  ) {
    return false;
  }

  if (shouldSkipArchiveForwardingForCascadeRisk(deps, args.thread)) {
    return false;
  }

  const workspaceContext = buildThreadWorkspaceContext(args.environment);
  if (!workspaceContext) {
    return false;
  }

  if (
    hasExistingThreadArchiveCommand(deps, {
      hostId: args.environment.hostId,
      providerId: args.thread.providerId,
      providerThreadId: args.providerThreadId,
      threadId: args.thread.id,
    })
  ) {
    return false;
  }

  const session = getActiveSession(deps.db, args.environment.hostId);
  queueCommand(deps.db, deps.hub, {
    hostId: args.environment.hostId,
    sessionId: session?.id ?? null,
    type: "thread.archive",
    payload: JSON.stringify({
      type: "thread.archive",
      environmentId: args.environment.id,
      threadId: args.thread.id,
      workspaceContext,
      providerId: args.thread.providerId,
      providerThreadId: args.providerThreadId,
    }),
  });
  return true;
}

export function ensureThreadNativeArchiveSettled(
  deps: Pick<AppDeps, "db">,
  args: EnsureThreadNativeArchiveSettledArgs,
): void {
  if (
    !hasPendingHostCommandForThread(deps.db, {
      hostId: args.environment.hostId,
      threadId: args.thread.id,
      type: "thread.archive",
    })
  ) {
    return;
  }

  throw new ApiError(
    409,
    "thread_archive_in_progress",
    "Thread archive is still syncing with the provider",
  );
}

export function queueArchivedThreadProviderArchiveCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueArchivedThreadProviderArchiveCommandArgs,
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

  return queueThreadArchiveCommand(deps, {
    environment: {
      id: environment.id,
      hostId: environment.hostId,
      path: environment.path,
      workspaceProvisionType: environment.workspaceProvisionType,
    },
    providerThreadId,
    thread,
  });
}

export function queueThreadUnarchiveCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueThreadUnarchiveCommandArgs,
): void {
  if (
    !providerSupportsThreadArchiveForwarding(
      args.thread.providerId,
      "unarchive",
    )
  ) {
    return;
  }

  const session = getActiveSession(deps.db, args.host.hostId);
  queueCommand(deps.db, deps.hub, {
    hostId: args.host.hostId,
    sessionId: session?.id ?? null,
    type: "thread.unarchive",
    payload: JSON.stringify({
      type: "thread.unarchive",
      threadId: args.thread.id,
      providerId: args.thread.providerId,
      providerThreadId: args.providerThreadId,
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

export function queueThreadDeletedCommandInTransaction(
  db: DbTransaction,
  args: QueueThreadDeletedCommandArgs,
): boolean {
  const session = getActiveSession(db, args.environment.hostId);
  if (!session) {
    return false;
  }
  queueCommandInTransaction(db, {
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
