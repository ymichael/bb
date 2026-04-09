import { and, eq, isNull } from "drizzle-orm";
import {
  type EnvironmentOperationRow,
  getActiveSession,
  getCommand,
  getEnvironment,
  getEnvironmentOperation,
  getEnvironmentOperationByCommandId,
  getHost,
  queueCommand,
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
  Thread,
} from "@bb/domain";
import {
  type HostDaemonCommand,
} from "@bb/host-daemon-contract";
import type { SandboxHostProgressEvent } from "@bb/sandbox-host";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  appendProvisioningEvent,
  appendSystemErrorEvent,
} from "../threads/thread-events.js";
import {
  buildEnvironmentProvisionCommand,
  buildManagedBranchNameFromSeed,
  buildManagedTargetPath,
  SETUP_TIMEOUT_MS,
  requireSourceForHost,
} from "../threads/thread-create-helpers.js";
import {
  buildDirectEnvironmentProvisionRequest,
  environmentProvisionRequestSchema,
  type EnvironmentProvisionRequest,
  type SandboxHostEnvironmentProvisionRequest,
} from "./environment-provision-request.js";
import { createAsyncDeduper } from "../lib/async-deduper.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";
import { parseJsonWithSchema } from "../lib/json-parsing.js";
import {
  destroyHost,
  ensureSandboxHostSessionReady,
} from "../hosts/host-lifecycle.js";
import { advanceEnvironmentCleanup } from "./environment-cleanup.js";
import { tryTransition } from "../threads/thread-transitions.js";

type EnvironmentProvisionOperationKind = Extract<
  EnvironmentOperationKind,
  "provision" | "reprovision"
>;

type EnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.provision" }
>;

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

export interface FailEnvironmentProvisioningForCommandArgs
  extends EnvironmentProvisioningCommandMutationArgs {
  failureReason: string;
}

interface QueueEnvironmentProvisionCommandArgs {
  command: EnvironmentProvisionCommand;
  environment: Environment;
  kind: EnvironmentProvisionOperationKind;
}

type LiveEnvironmentThread = Pick<Thread, "id" | "projectId">;
const sandboxBootstrapDeduper = createAsyncDeduper<string, void>();

function listLiveEnvironmentThreads(
  deps: Pick<AppDeps, "db">,
  environmentId: string,
): LiveEnvironmentThread[] {
  return deps.db
    .select({
      id: threads.id,
      projectId: threads.projectId,
    })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, environmentId),
        isNull(threads.deletedAt),
      ),
    )
    .all();
}

function appendProvisioningEventToEnvironmentThreads(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    entries: ProvisioningTranscriptEntry[];
    environmentId: string;
    status: "completed" | "failed" | "in_progress" | "started";
    threads?: LiveEnvironmentThread[];
  },
): void {
  const liveThreads =
    args.threads
    // Refresh the thread list for in-progress broadcasts so reuse threads that
    // attach mid-provision receive subsequent transcript updates.
    ?? listLiveEnvironmentThreads(deps, args.environmentId);

  for (const thread of liveThreads) {
    appendProvisioningEvent(deps, {
      entries: args.entries,
      environmentId: args.environmentId,
      status: args.status,
      threadId: thread.id,
    });
  }
}

function assertNeverSandboxHostProgressStage(value: never): never {
  throw new Error(`Unsupported sandbox host progress stage: ${String(value)}`);
}

function assertNeverWorkspaceProvisionType(value: never): never {
  throw new Error(`Unsupported workspace provision type: ${String(value)}`);
}

function sandboxHostProgressEntry(
  event: SandboxHostProgressEvent,
): ProvisioningTranscriptEntry {
  const startedAt = Date.now();

  switch (event.stage) {
    case "host":
      return {
        type: "step",
        key: "sandbox-host",
        text:
          event.status === "completed"
            ? "Sandbox host ready"
            : "Preparing sandbox host",
        startedAt,
        status: event.status,
      };
    case "daemon-start":
      return {
        type: "step",
        key: "sandbox-daemon",
        text:
          event.status === "completed"
            ? "Sandbox daemon started"
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

function isActiveProvisionOperationState(
  state: EnvironmentOperationRow["state"],
): boolean {
  return state === "requested" || state === "queued" || state === "fetched";
}

function toProvisioningLabel(
  workspaceProvisionType: Environment["workspaceProvisionType"],
): string {
  switch (workspaceProvisionType) {
    case "unmanaged":
      return "Environment";
    case "managed-worktree":
      return "Worktree";
    case "managed-clone":
      return "Clone";
  }

  return assertNeverWorkspaceProvisionType(workspaceProvisionType);
}

function getActiveProvisionOperation(
  deps: Pick<AppDeps, "db">,
  environmentId: string,
): (EnvironmentOperationRow & { kind: EnvironmentProvisionOperationKind }) | null {
  for (const kind of ["reprovision", "provision"] as const) {
    const operation = getEnvironmentOperation(deps.db, {
      environmentId,
      kind,
    });
    if (operation && isActiveProvisionOperationState(operation.state)) {
      return {
        ...operation,
        kind,
      };
    }
  }

  return null;
}

function getActiveProvisionOperationByCommandId(
  deps: Pick<AppDeps, "db">,
  commandId: string,
) {
  const operation = getEnvironmentOperationByCommandId(deps.db, commandId);
  if (
    !operation
    || (operation.kind !== "provision" && operation.kind !== "reprovision")
    || !isActiveProvisionOperationState(operation.state)
  ) {
    return null;
  }

  return operation;
}

function hasQueuedProvisionCommand(
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

export function completeEnvironmentProvisioning(
  deps: Pick<AppDeps, "db">,
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
  deps: Pick<AppDeps, "db">,
  args: EnvironmentProvisioningCommandMutationArgs,
): boolean {
  return getActiveProvisionOperationByCommandId(deps, args.commandId) !== null;
}

export function completeEnvironmentProvisioningForCommand(
  deps: Pick<AppDeps, "db">,
  args: EnvironmentProvisioningCommandMutationArgs,
): boolean {
  const operation = getActiveProvisionOperationByCommandId(deps, args.commandId);
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
  deps: Pick<AppDeps, "db" | "hub">,
  args: FailEnvironmentProvisioningForCommandArgs,
): boolean {
  const operation = getActiveProvisionOperationByCommandId(deps, args.commandId);
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
    environment
    && environment.status !== "destroyed"
    && environment.status !== "error"
  ) {
    setEnvironmentStatus(deps.db, deps.hub, operation.environmentId, {
      status: "error",
    });
  }

  return true;
}

export function failEnvironmentProvisioning(
  deps: Pick<AppDeps, "db" | "hub">,
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
    environment
    && environment.status !== "destroyed"
    && environment.status !== "error"
  ) {
    setEnvironmentStatus(deps.db, deps.hub, environment.id, {
      status: "error",
    });
  }

  return true;
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
    "config" | "db" | "hub" | "machineAuth" | "sandboxRegistry"
  >,
  args: {
    environment: Environment;
    operationKind: EnvironmentProvisionOperationKind;
    request: SandboxHostEnvironmentProvisionRequest;
  },
): Promise<void> {
  appendProvisioningEventToEnvironmentThreads(deps, {
    environmentId: args.environment.id,
    status: "in_progress",
    entries: [
      {
        type: "step",
        key: "sandbox-connect",
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
          appendProvisioningEventToEnvironmentThreads(deps, {
            environmentId: args.environment.id,
            status: "in_progress",
            entries: [sandboxHostProgressEntry(event)],
          });
        },
      },
      sandboxType: args.request.sandboxType,
    });

    appendProvisioningEventToEnvironmentThreads(deps, {
      environmentId: args.environment.id,
      status: "in_progress",
      entries: [
        {
          type: "step",
          key: "sandbox-connect",
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
    const liveThreads = listLiveEnvironmentThreads(deps, args.environment.id);

    failEnvironmentProvisioning(deps, {
      environmentId: args.environment.id,
      failureReason,
    });

    appendProvisioningEventToEnvironmentThreads(deps, {
      environmentId: args.environment.id,
      status: "failed",
      threads: liveThreads,
      entries: [
        {
          type: "step",
          key: "sandbox-host",
          text: failureReason,
          startedAt: Date.now(),
          status: "failed",
        },
      ],
    });

    for (const thread of liveThreads) {
      appendSystemErrorEvent(deps, {
        threadId: thread.id,
        environmentId: args.environment.id,
        code: "thread_provisioning_failed",
        message: `Thread provisioning failed for project ${thread.projectId}`,
        detail: failureReason,
      });
      tryTransition(deps.db, deps.hub, thread.id, "error");
    }

    const host = getHost(deps.db, args.environment.hostId);
    if (host && host.destroyedAt === null) {
      await destroyHost(deps, host.id).catch(() => undefined);
    }

    await advanceEnvironmentCleanup(deps, {
      environmentId: args.environment.id,
    });
  }
}

export function advanceEnvironmentProvisioning(
  deps: Pick<
    AppDeps,
    "config" | "db" | "hub" | "machineAuth" | "sandboxRegistry"
  >,
  args: AdvanceEnvironmentProvisioningArgs,
): string | null {
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
    void sandboxBootstrapDeduper.run(environment.id, async () => {
      await bootstrapSandboxProvisioning(deps, {
        environment,
        operationKind: operation.kind,
        request,
      });
    });
    return null;
  }

  return queueEnvironmentProvisionCommand(deps, {
    command: request.command,
    environment,
    kind: operation.kind,
  });
}

export const MANAGED_REPROVISION_QUEUED = "queued" as const;
export const MANAGED_REPROVISION_IN_PROGRESS = "already-provisioning" as const;
export type ManagedReprovisionResult =
  | typeof MANAGED_REPROVISION_QUEUED
  | typeof MANAGED_REPROVISION_IN_PROGRESS;

export function queueManagedEnvironmentReprovision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environment: Environment;
    thread: Thread;
  },
): ManagedReprovisionResult {
  const provisionType = args.environment.workspaceProvisionType;
  if (!args.environment.managed || provisionType === "unmanaged") {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment cannot be reprovisioned automatically",
    );
  }

  const activeOperation = getActiveProvisionOperation(deps, args.environment.id);
  if (activeOperation) {
    return MANAGED_REPROVISION_IN_PROGRESS;
  }

  const source = requireSourceForHost(
    deps,
    args.thread.projectId,
    args.environment.hostId,
  );
  requireConnectedHostSession(deps, args.environment.hostId);

  const targetPath =
    args.environment.path ??
    buildManagedTargetPath(source.path, args.thread.projectId, args.thread.id);
  const branchName =
    args.environment.branchName ??
    buildManagedBranchNameFromSeed(
      args.thread.title ?? args.thread.titleFallback ?? args.thread.id,
      args.thread.id,
    );

  if (args.thread.status === "idle") {
    tryTransition(deps.db, deps.hub, args.thread.id, "provisioning");
  }
  const provisionEventSequence = appendProvisioningEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    status: "started",
    entries: [
      {
        type: "step",
        key: "provision",
        text: `Provisioning ${toProvisioningLabel(args.environment.workspaceProvisionType).toLowerCase()}`,
        status: "started",
      },
    ],
  });

  const command = buildEnvironmentProvisionCommand({
    branchName,
    environmentId: args.environment.id,
    hostId: args.environment.hostId,
    initiator: { threadId: args.thread.id, eventSequence: provisionEventSequence },
    sourcePath: source.path,
    targetPath,
    workspaceProvisionType: provisionType,
    setupTimeoutMs: SETUP_TIMEOUT_MS,
  });

  requestEnvironmentProvision(deps, {
    environmentId: args.environment.id,
    kind: "reprovision",
    request: buildDirectEnvironmentProvisionRequest(command),
  });
  queueEnvironmentProvisionCommand(deps, {
    command,
    environment: args.environment,
    kind: "reprovision",
  });
  return MANAGED_REPROVISION_QUEUED;
}
