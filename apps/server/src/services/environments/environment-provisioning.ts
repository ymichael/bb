import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  type DbNotifier,
  type DbQueryConnection,
  type DbTransaction,
  type EnvironmentOperationRow,
  getActiveSession,
  getCommand,
  getEnvironment,
  getEnvironmentOperation,
  getEnvironmentOperationByCommandId,
  getHost,
  queueCommand,
  threadOperations,
  threads,
} from "@bb/db";
import {
  markEnvironmentOperationRecordCompleted,
  markEnvironmentOperationRecordFailed,
  markEnvironmentOperationRecordQueued,
  setEnvironmentStatus,
  upsertEnvironmentOperationRecord,
} from "@bb/db/internal-lifecycle";
import type {
  Environment,
  EnvironmentOperationKind,
  ProvisioningTranscriptEntry,
  SystemThreadProvisioningStatus,
  ThreadProvisioningStage,
} from "@bb/domain";
import {
  activeLifecycleOperationStates,
  isActiveLifecycleOperationState,
  threadScope,
} from "@bb/domain";
import { type HostDaemonCommand } from "@bb/host-daemon-contract";
import type { BaseBranchSpec } from "@bb/server-contract";
import type { SandboxHostProgressEvent } from "@bb/sandbox-host";
import type { AppDeps, SandboxWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  appendThreadProvisioningEvent,
  appendSystemErrorEvent,
  appendSystemErrorEventInTransaction,
  appendThreadProvisioningEventInTransaction,
} from "../threads/thread-events.js";
import {
  buildEnvironmentProvisionCommand,
  buildManagedBranchName,
  SETUP_TIMEOUT_MS,
  requireSourceForHost,
} from "../threads/thread-create-helpers.js";
import { resolveManagedTargetPath } from "../threads/worktree-paths.js";
import {
  buildDirectEnvironmentProvisionRequest,
  environmentProvisionRequestSchema,
  type EnvironmentProvisionRequest,
  type SandboxHostEnvironmentProvisionRequest,
} from "./environment-provision-request.js";
import { parseJsonWithSchema } from "../lib/json-parsing.js";
import {
  destroyHost,
  ensureHostSessionReadyForWork,
  ensureSandboxHostSessionReady,
} from "../hosts/host-lifecycle.js";
import { advanceEnvironmentCleanup } from "./environment-cleanup.js";
import {
  tryTransition,
  tryTransitionInTransaction,
} from "../threads/thread-transitions.js";
import { readThreadProvisioningIdFromRecord } from "../threads/thread-provisioning-state.js";

type EnvironmentProvisionOperationKind = Extract<
  EnvironmentOperationKind,
  "provision" | "reprovision"
>;

type EnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.provision" }
>;

interface EnvironmentProvisionReadDeps {
  db: DbQueryConnection;
}

interface EnvironmentProvisionWriteDeps extends EnvironmentProvisionReadDeps {
  hub: DbNotifier;
}

interface EnvironmentProvisionTransactionDeps
  extends EnvironmentProvisionWriteDeps {
  db: DbTransaction;
}

export interface RequestEnvironmentProvisionArgs {
  environmentId: string;
  kind: EnvironmentProvisionOperationKind;
  request: EnvironmentProvisionRequest;
}

export interface AdvanceEnvironmentProvisioningArgs {
  environmentId: string | null | undefined;
}

export interface EnvironmentProvisioningCommandMutationArgs {
  commandId: string;
}

export interface EnvironmentProvisioningCommandLookupArgs {
  commandId: string;
}

export interface FailEnvironmentProvisioningForCommandArgs extends EnvironmentProvisioningCommandMutationArgs {
  failureReason: string;
}

interface QueueEnvironmentProvisionCommandArgs {
  command: EnvironmentProvisionCommand;
  environment: Environment;
  kind: EnvironmentProvisionOperationKind;
}

interface FailEnvironmentProvisioningDurablyArgs {
  commandId?: string;
  environmentId: string;
  failureEntry: ProvisioningTranscriptEntry;
  failureReason: string;
}

interface LiveEnvironmentThread {
  id: string;
  provisionEventSequence: number | null;
  provisionOperationProvisioningEnvironmentId: string | null;
  provisionOperationProvisioningId: string | null;
  provisionOperationProvisioningStage: ThreadProvisioningStage | null;
  workspaceReadyEventSequence: number | null;
}

interface AppendThreadProvisioningEventToEnvironmentThreadsArgs {
  entries: ProvisioningTranscriptEntry[];
  environmentId: string;
  fallbackProvisioningId: string;
  status: SystemThreadProvisioningStatus;
  threads?: LiveEnvironmentThread[];
}

function listLiveEnvironmentThreads(
  deps: EnvironmentProvisionReadDeps,
  environmentId: string,
): LiveEnvironmentThread[] {
  return deps.db
    .select({
      id: threads.id,
      provisionEventSequence: threadOperations.provisionEventSequence,
      provisionOperationProvisioningEnvironmentId:
        threadOperations.provisioningEnvironmentId,
      provisionOperationProvisioningId: threadOperations.provisioningId,
      provisionOperationProvisioningStage: threadOperations.provisioningStage,
      workspaceReadyEventSequence: threadOperations.workspaceReadyEventSequence,
    })
    .from(threads)
    .leftJoin(
      threadOperations,
      and(
        eq(threadOperations.threadId, threads.id),
        eq(threadOperations.kind, "provision"),
        inArray(threadOperations.state, [...activeLifecycleOperationStates]),
      ),
    )
    .where(
      and(eq(threads.environmentId, environmentId), isNull(threads.deletedAt)),
    )
    .all();
}

function resolveLiveThreadProvisioningId(
  thread: LiveEnvironmentThread,
  fallbackProvisioningId: string,
): string {
  if (
    thread.provisionOperationProvisioningId === null &&
    thread.provisionOperationProvisioningStage === null
  ) {
    return fallbackProvisioningId;
  }
  return readThreadProvisioningIdFromRecord({
    provisionEventSequence: thread.provisionEventSequence,
    provisioningEnvironmentId:
      thread.provisionOperationProvisioningEnvironmentId,
    provisioningId: thread.provisionOperationProvisioningId,
    provisioningStage: thread.provisionOperationProvisioningStage,
    workspaceReadyEventSequence: thread.workspaceReadyEventSequence,
  });
}

function appendThreadProvisioningEventToEnvironmentThreads(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadProvisioningEventToEnvironmentThreadsArgs,
): void {
  const liveThreads =
    args.threads ??
    // Refresh the thread list for in-progress broadcasts so reuse threads that
    // attach mid-provision receive subsequent transcript updates.
    listLiveEnvironmentThreads(deps, args.environmentId);

  for (const thread of liveThreads) {
    const provisioningId = resolveLiveThreadProvisioningId(
      thread,
      args.fallbackProvisioningId,
    );
    appendThreadProvisioningEvent(deps, {
      entries: args.entries,
      environmentId: args.environmentId,
      provisioningId,
      status: args.status,
      threadId: thread.id,
    });
  }
}

function appendThreadProvisioningEventToEnvironmentThreadsInTransaction(
  deps: EnvironmentProvisionTransactionDeps,
  args: AppendThreadProvisioningEventToEnvironmentThreadsArgs,
): void {
  const liveThreads =
    args.threads ?? listLiveEnvironmentThreads(deps, args.environmentId);

  for (const thread of liveThreads) {
    const provisioningId = resolveLiveThreadProvisioningId(
      thread,
      args.fallbackProvisioningId,
    );
    appendThreadProvisioningEventInTransaction(deps.db, {
      entries: args.entries,
      environmentId: args.environmentId,
      provisioningId,
      status: args.status,
      threadId: thread.id,
    });
    deps.hub.notifyThread(thread.id, ["events-appended"]);
  }
}

function assertNeverSandboxHostProgressStage(value: never): never {
  throw new Error(`Unsupported sandbox host progress stage: ${String(value)}`);
}

function sandboxHostProgressEntry(
  event: SandboxHostProgressEvent,
): ProvisioningTranscriptEntry {
  const startedAt = Date.now();

  switch (event.stage) {
    case "host":
      return {
        type: "step",
        key: `sandbox-host-${event.status}`,
        text:
          event.status === "completed"
            ? "Sandbox host ready"
            : "Preparing sandbox",
        startedAt,
        status: event.status,
      };
    case "daemon-start":
      return {
        type: "step",
        key: `sandbox-daemon-${event.status}`,
        text:
          event.status === "completed"
            ? "Sandbox daemon ready"
            : "Starting sandbox daemon",
        startedAt,
        status: event.status,
      };
  }

  return assertNeverSandboxHostProgressStage(event.stage);
}

function queueEnvironmentProvisionCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueEnvironmentProvisionCommandArgs,
): string | null {
  const session = getActiveSession(deps.db, args.environment.hostId);
  if (!session || session.leaseExpiresAt <= Date.now()) {
    return null;
  }

  const queuedCommand = queueCommand(deps.db, deps.hub, {
    hostId: args.environment.hostId,
    sessionId: session.id,
    type: args.command.type,
    payload: JSON.stringify(args.command),
  });

  markEnvironmentOperationRecordQueued(deps.db, {
    environmentId: args.environment.id,
    kind: args.kind,
    commandId: queuedCommand.id,
  });

  return queuedCommand.id;
}

function getActiveProvisionOperation(
  deps: EnvironmentProvisionReadDeps,
  environmentId: string,
):
  | (EnvironmentOperationRow & { kind: EnvironmentProvisionOperationKind })
  | null {
  for (const kind of ["reprovision", "provision"] as const) {
    const operation = getEnvironmentOperation(deps.db, {
      environmentId,
      kind,
    });
    if (operation && isActiveLifecycleOperationState(operation.state)) {
      return {
        ...operation,
        kind,
      };
    }
  }

  return null;
}

function getActiveProvisionOperationByCommandId(
  deps: EnvironmentProvisionReadDeps,
  commandId: string,
) {
  const operation = getEnvironmentOperationByCommandId(deps.db, commandId);
  if (
    !operation ||
    (operation.kind !== "provision" && operation.kind !== "reprovision") ||
    !isActiveLifecycleOperationState(operation.state)
  ) {
    return null;
  }

  return operation;
}

function readEnvironmentProvisioningIdFromOperation(
  operation: EnvironmentOperationRow,
): string {
  return parseJsonWithSchema(
    operation.payload,
    environmentProvisionRequestSchema,
  ).provisioningId;
}

export function getEnvironmentProvisioningIdForCommand(
  deps: EnvironmentProvisionReadDeps,
  args: EnvironmentProvisioningCommandLookupArgs,
): string | null {
  const operation = getActiveProvisionOperationByCommandId(
    deps,
    args.commandId,
  );
  if (!operation) {
    return null;
  }
  return readEnvironmentProvisioningIdFromOperation(operation);
}

function hasQueuedProvisionCommand(
  deps: EnvironmentProvisionReadDeps,
  commandId: string | null,
): boolean {
  if (!commandId) {
    return false;
  }

  const command = getCommand(deps.db, commandId);
  return (
    command !== null &&
    (command.state === "pending" || command.state === "fetched")
  );
}

export function completeEnvironmentProvisioning(
  deps: EnvironmentProvisionReadDeps,
  args: { environmentId: string },
): boolean {
  const operation = getActiveProvisionOperation(deps, args.environmentId);
  if (!operation) {
    return false;
  }

  markEnvironmentOperationRecordCompleted(deps.db, {
    environmentId: args.environmentId,
    kind: operation.kind,
  });
  return true;
}

export function hasActiveEnvironmentProvisionOperationForCommand(
  deps: EnvironmentProvisionReadDeps,
  args: EnvironmentProvisioningCommandMutationArgs,
): boolean {
  return getActiveProvisionOperationByCommandId(deps, args.commandId) !== null;
}

export function completeEnvironmentProvisioningForCommand(
  deps: EnvironmentProvisionReadDeps,
  args: EnvironmentProvisioningCommandMutationArgs,
): boolean {
  const operation = getActiveProvisionOperationByCommandId(
    deps,
    args.commandId,
  );
  if (!operation) {
    return false;
  }

  markEnvironmentOperationRecordCompleted(deps.db, {
    environmentId: operation.environmentId,
    kind: operation.kind,
  });
  return true;
}

export function failEnvironmentProvisioningForCommand(
  deps: EnvironmentProvisionWriteDeps,
  args: FailEnvironmentProvisioningForCommandArgs,
): boolean {
  const operation = getActiveProvisionOperationByCommandId(
    deps,
    args.commandId,
  );
  if (!operation) {
    return false;
  }

  markEnvironmentOperationRecordFailed(deps.db, {
    environmentId: operation.environmentId,
    kind: operation.kind,
    failureReason: args.failureReason,
  });

  const environment = getEnvironment(deps.db, operation.environmentId);
  if (
    environment &&
    environment.status !== "destroyed" &&
    environment.status !== "error"
  ) {
    setEnvironmentStatus(deps.db, deps.hub, operation.environmentId, {
      status: "error",
    });
  }

  return true;
}

export function failEnvironmentProvisioning(
  deps: EnvironmentProvisionWriteDeps,
  args: { environmentId: string; failureReason: string },
): boolean {
  const operation = getActiveProvisionOperation(deps, args.environmentId);
  if (!operation) {
    return false;
  }

  markEnvironmentOperationRecordFailed(deps.db, {
    environmentId: args.environmentId,
    kind: operation.kind,
    failureReason: args.failureReason,
  });

  const environment = getEnvironment(deps.db, args.environmentId);
  if (
    environment &&
    environment.status !== "destroyed" &&
    environment.status !== "error"
  ) {
    setEnvironmentStatus(deps.db, deps.hub, environment.id, {
      status: "error",
    });
  }

  return true;
}

export function recordEnvironmentProvisioningFailure(
  deps: Pick<AppDeps, "db" | "hub">,
  args: FailEnvironmentProvisioningDurablyArgs,
): boolean {
  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment) {
    return false;
  }
  const operation = args.commandId
    ? getActiveProvisionOperationByCommandId(deps, args.commandId)
    : getActiveProvisionOperation(deps, environment.id);
  if (!operation) {
    return false;
  }
  const liveThreads = listLiveEnvironmentThreads(deps, environment.id);
  const provisioningId = readEnvironmentProvisioningIdFromOperation(operation);

  if (args.commandId) {
    failEnvironmentProvisioningForCommand(deps, {
      commandId: args.commandId,
      failureReason: args.failureReason,
    });
  } else {
    failEnvironmentProvisioning(deps, {
      environmentId: environment.id,
      failureReason: args.failureReason,
    });
  }

  appendThreadProvisioningEventToEnvironmentThreads(deps, {
    environmentId: environment.id,
    fallbackProvisioningId: provisioningId,
    status: "failed",
    threads: liveThreads,
    entries: [args.failureEntry],
  });

  for (const thread of liveThreads) {
    appendSystemErrorEvent(deps, {
      threadId: thread.id,
      environmentId: environment.id,
      code: "thread_provisioning_failed",
      message: "Provisioning thread failed",
      detail: args.failureReason,
      scope: threadScope(),
    });
    tryTransition(deps.db, deps.hub, thread.id, "error");
  }

  return true;
}

export function recordEnvironmentProvisioningFailureInTransaction(
  deps: EnvironmentProvisionTransactionDeps,
  args: FailEnvironmentProvisioningDurablyArgs,
): boolean {
  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment) {
    return false;
  }
  const operation = args.commandId
    ? getActiveProvisionOperationByCommandId(deps, args.commandId)
    : getActiveProvisionOperation(deps, environment.id);
  if (!operation) {
    return false;
  }
  const liveThreads = listLiveEnvironmentThreads(deps, environment.id);
  const provisioningId = readEnvironmentProvisioningIdFromOperation(operation);

  if (args.commandId) {
    failEnvironmentProvisioningForCommand(deps, {
      commandId: args.commandId,
      failureReason: args.failureReason,
    });
  } else {
    failEnvironmentProvisioning(deps, {
      environmentId: environment.id,
      failureReason: args.failureReason,
    });
  }

  appendThreadProvisioningEventToEnvironmentThreadsInTransaction(deps, {
    environmentId: environment.id,
    fallbackProvisioningId: provisioningId,
    status: "failed",
    threads: liveThreads,
    entries: [args.failureEntry],
  });

  for (const thread of liveThreads) {
    appendSystemErrorEventInTransaction(deps, {
      threadId: thread.id,
      environmentId: environment.id,
      code: "thread_provisioning_failed",
      message: "Provisioning thread failed",
      detail: args.failureReason,
      scope: threadScope(),
    });
    tryTransitionInTransaction(deps.db, deps.hub, thread.id, "error");
  }

  return true;
}

export async function failEnvironmentProvisioningDurably(
  deps: Pick<
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "lifecycleDedupers"
    | "machineAuth"
    | "sandboxEnv"
    | "sandboxRegistry"
  >,
  args: FailEnvironmentProvisioningDurablyArgs,
): Promise<void> {
  const recorded = recordEnvironmentProvisioningFailure(deps, args);
  if (!recorded) {
    return;
  }

  await advanceEnvironmentCleanup(deps, {
    environmentId: args.environmentId,
  });
}

export function requestEnvironmentProvision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestEnvironmentProvisionArgs,
): void {
  upsertEnvironmentOperationRecord(deps.db, {
    environmentId: args.environmentId,
    kind: args.kind,
    payload: JSON.stringify(args.request),
  });

  const environment = getEnvironment(deps.db, args.environmentId);
  if (environment && environment.status !== "provisioning") {
    setEnvironmentStatus(deps.db, deps.hub, environment.id, {
      status: "provisioning",
    });
  }
}

async function bootstrapSandboxProvisioning(
  deps: Pick<
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "lifecycleDedupers"
    | "machineAuth"
    | "sandboxEnv"
    | "sandboxRegistry"
  >,
  args: {
    environment: Environment;
    operationKind: EnvironmentProvisionOperationKind;
    request: SandboxHostEnvironmentProvisionRequest;
  },
): Promise<void> {
  const operation = getActiveProvisionOperation(deps, args.environment.id);
  if (!operation) {
    throw new Error("Environment provision operation is no longer active");
  }
  const provisioningId = readEnvironmentProvisioningIdFromOperation(operation);
  appendThreadProvisioningEventToEnvironmentThreads(deps, {
    environmentId: args.environment.id,
    fallbackProvisioningId: provisioningId,
    status: "active",
    entries: [
      {
        type: "step",
        key: "sandbox-connect-started",
        text: "Waiting for sandbox host to connect",
        startedAt: Date.now(),
        status: "started",
      },
    ],
  });

  try {
    await ensureSandboxHostSessionReady(deps, {
      hostId: args.environment.hostId,
      progressCallbacks: {
        onProgress: (event) => {
          appendThreadProvisioningEventToEnvironmentThreads(deps, {
            environmentId: args.environment.id,
            fallbackProvisioningId: provisioningId,
            status: "active",
            entries: [sandboxHostProgressEntry(event)],
          });
        },
      },
    });

    appendThreadProvisioningEventToEnvironmentThreads(deps, {
      environmentId: args.environment.id,
      fallbackProvisioningId: provisioningId,
      status: "active",
      entries: [
        {
          type: "step",
          key: "sandbox-connect-completed",
          text: "Sandbox host connected",
          startedAt: Date.now(),
          status: "completed",
        },
      ],
    });

    queueEnvironmentProvisionCommand(deps, {
      command: args.request.command,
      environment: args.environment,
      kind: args.operationKind,
    });
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : String(error);

    await failEnvironmentProvisioningDurably(deps, {
      environmentId: args.environment.id,
      failureReason,
      failureEntry: {
        type: "step",
        key: "sandbox-failed",
        text: failureReason,
        startedAt: Date.now(),
        status: "failed",
      },
    });

    const host = getHost(deps.db, args.environment.hostId);
    if (host && host.destroyedAt === null) {
      await destroyHost(deps, host.id).catch(() => undefined);
    }
  }
}

export async function advanceEnvironmentProvisioning(
  deps: Pick<
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "lifecycleDedupers"
    | "machineAuth"
    | "sandboxEnv"
    | "sandboxRegistry"
  >,
  args: AdvanceEnvironmentProvisioningArgs,
): Promise<string | null> {
  if (!args.environmentId) {
    return null;
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment || environment.status === "destroyed") {
    return null;
  }

  const operation = getActiveProvisionOperation(deps, environment.id);
  if (!operation) {
    return null;
  }

  if (hasQueuedProvisionCommand(deps, operation.commandId)) {
    return operation.commandId;
  }

  const request = parseJsonWithSchema(
    operation.payload,
    environmentProvisionRequestSchema,
  );

  if (request.mode === "sandbox-host") {
    // Sandbox bootstrap is intentionally fire-and-forget here: failures are
    // handled inside bootstrapSandboxProvisioning so the request path and
    // sweeps both converge on the same async lifecycle.
    void deps.lifecycleDedupers.sandboxBootstrap.run(
      environment.id,
      async () => {
        await bootstrapSandboxProvisioning(deps, {
          environment,
          operationKind: operation.kind,
          request,
        });
      },
    );
    return null;
  }

  await ensureHostSessionReadyForWork(deps, {
    hostId: environment.hostId,
  });
  return queueEnvironmentProvisionCommand(deps, {
    command: request.command,
    environment,
    kind: operation.kind,
  });
}

export const MANAGED_REPROVISION_QUEUED = "queued" as const;
export const MANAGED_REPROVISION_IN_PROGRESS = "already-provisioning" as const;
export interface QueuedManagedReprovision {
  provisionEventSequence: number;
  status: typeof MANAGED_REPROVISION_QUEUED;
}
export type ManagedReprovisionResult =
  | QueuedManagedReprovision
  | typeof MANAGED_REPROVISION_IN_PROGRESS;

export interface ActiveManagedEnvironmentProvisionArgs {
  environmentId: string;
}

export interface QueueManagedEnvironmentReprovisionArgs {
  environment: Environment;
  projectId: string;
  provisionEventSequence: number;
  provisioningId: string;
  threadId: string;
}

export function hasActiveManagedEnvironmentProvision(
  deps: Pick<AppDeps, "db">,
  args: ActiveManagedEnvironmentProvisionArgs,
): boolean {
  return Boolean(getActiveProvisionOperation(deps, args.environmentId));
}

export async function queueManagedEnvironmentReprovision(
  deps: SandboxWorkSessionDeps,
  args: QueueManagedEnvironmentReprovisionArgs,
): Promise<ManagedReprovisionResult> {
  const provisionType = args.environment.workspaceProvisionType;
  if (!args.environment.managed || provisionType === "unmanaged") {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment cannot be reprovisioned automatically",
    );
  }

  const activeOperation = getActiveProvisionOperation(
    deps,
    args.environment.id,
  );
  if (activeOperation) {
    return MANAGED_REPROVISION_IN_PROGRESS;
  }

  const source = requireSourceForHost(
    deps,
    args.projectId,
    args.environment.hostId,
  );
  const hostSession = await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });

  const targetPath =
    args.environment.path ??
    resolveManagedTargetPath({
      dataDir: hostSession.dataDir,
      environmentId: args.environment.id,
      sourcePath: source.path,
    });
  const branchName =
    args.environment.branchName ??
    buildManagedBranchName({ threadId: args.threadId });
  // Reprovision doesn't track the originally-picked base branch on the env
  // row, so we ask the daemon to use the source's default. (TODO: persist
  // baseBranch on the env row so reprovision matches the original pick.)
  const baseBranch: BaseBranchSpec = { kind: "default" };

  const command = buildEnvironmentProvisionCommand({
    branchName,
    baseBranch,
    environmentId: args.environment.id,
    hostId: args.environment.hostId,
    initiator: {
      threadId: args.threadId,
      provisioningId: args.provisioningId,
    },
    sourcePath: source.path,
    targetPath,
    workspaceProvisionType: provisionType,
    setupTimeoutMs: SETUP_TIMEOUT_MS,
  });

  requestEnvironmentProvision(deps, {
    environmentId: args.environment.id,
    kind: "reprovision",
    request: buildDirectEnvironmentProvisionRequest({
      command,
      provisioningId: args.provisioningId,
    }),
  });
  queueEnvironmentProvisionCommand(deps, {
    command,
    environment: args.environment,
    kind: "reprovision",
  });
  return {
    provisionEventSequence: args.provisionEventSequence,
    status: MANAGED_REPROVISION_QUEUED,
  };
}
