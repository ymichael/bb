import {
  applyProvisionedEnvironment,
  createEnvironment,
  createHostId,
  createThread,
  deleteEnvironment,
  deleteHost,
  deleteThread,
  findEnvironmentByHostPath,
  getHighWaterMarks,
  transitionThreadStatus,
  updateHost,
  upsertHost,
} from "@bb/db";
import type {
  Environment,
  GitHubRepoProjectSource,
  LocalPathProjectSource,
} from "@bb/domain";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { SandboxHost } from "@bb/sandbox-host";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  waitForQueuedCommandResult,
} from "./command-wait.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { requireConnectedHostSession } from "./entity-lookup.js";
import { destroyHost, waitForHostSession } from "./host-lifecycle.js";
import { requireReachablePublicServerUrl } from "./public-server-url.js";
import { createSandboxBackendForId } from "./sandbox-backends.js";
import { appendClientTurnEvent, appendProvisioningEvent, buildCwdBranchEntries } from "./thread-events.js";
import { buildExecutionOptions, queueThreadStartCommand } from "./thread-commands.js";
import { generateThreadTitle } from "./title-generation.js";
import {
  buildManagedBranchName,
  buildEnvironmentProvisionCommand,
  buildManagedTargetPath,
  buildSandboxTargetPath,
  createThreadRecord,
  getThreadSafe,
  requireProjectExists,
  SETUP_SCRIPT_NAME,
  SETUP_TIMEOUT_MS,
} from "./thread-create-helpers.js";
import {
  advanceEnvironmentProvisioning,
  requestEnvironmentProvision,
} from "./environment-provisioning.js";
import {
  resolveStableThreadRequestEnvironment,
} from "./thread-request-eligibility.js";
import {
  type ThreadCreateServiceRequest,
} from "./thread-create-request.js";

interface CreateThreadInEnvironmentArgs {
  environment: Environment;
  request: ThreadCreateServiceRequest;
  threadStatus: "idle" | "provisioning";
}

interface ReuseEnvironmentByHostPathArgs {
  hostId: string;
  path: string;
  request: ThreadCreateServiceRequest;
}

interface CreateSandboxHostThreadArgs {
  cloneSource: GitHubRepoProjectSource;
  request: ThreadCreateServiceRequest;
  sandboxType: string;
}

interface CleanupFailedSandboxHostThreadArgs {
  environmentId?: string;
  hostId: string;
  logger: Pick<AppDeps["logger"], "warn">;
  threadId?: string;
}

async function createThreadInEnvironment(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
  args: CreateThreadInEnvironmentArgs,
) {
  const thread = createThreadRecord(
    deps,
    args.request,
    args.environment.id,
  );
  try {
    transitionThreadStatus(deps.db, deps.hub, thread.id, args.threadStatus);

    const execution = await buildExecutionOptions(
      deps,
      args.request,
      {
        threadId: thread.id,
      },
      "client/thread/start",
    );

    const eventSequence = appendClientTurnEvent(
      deps,
      {
        threadId: thread.id,
        environmentId: args.environment.id,
        type: "client/thread/start",
        input: args.request.input,
        execution,
        initiator: args.request.spawnInitiator ?? "user",
        requestMethod: "thread/start",
        source: "spawn",
      },
    );

    if (args.threadStatus === "provisioning") {
      appendProvisioningEvent(deps, {
        threadId: thread.id,
        environmentId: args.environment.id,
        status: "started",
        entries: [
          {
            type: "step",
            key: "provision",
            text: "Waiting for environment...",
            status: "started",
          },
        ],
      });
    }

    if (args.threadStatus === "idle") {
      let latestSequence = eventSequence;
      if (args.environment.path) {
        const cwdEntries = buildCwdBranchEntries({
          path: args.environment.path,
          branchName: args.environment.branchName,
        });
        latestSequence = appendProvisioningEvent(deps, {
          threadId: thread.id,
          environmentId: args.environment.id,
          status: "completed",
          entries: cwdEntries,
        });
      }
      await startQueuedThreadIfNeeded(deps, {
        thread,
        environment: args.environment,
        execution,
        eventSequence: latestSequence,
        request: args.request,
      });
    }
  } catch (error) {
    deleteThread(deps.db, deps.hub, thread.id);
    throw error;
  }

  if (!args.request.title) {
    void generateThreadTitle(deps, {
      threadId: thread.id,
      input: args.request.input,
    });
  }

  return getThreadSafe(deps, thread.id);
}

async function cleanupFailedSandboxHostThread(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
  args: CleanupFailedSandboxHostThreadArgs,
): Promise<void> {
  if (args.threadId) {
    deleteThread(deps.db, deps.hub, args.threadId);
  }
  if (args.environmentId) {
    deleteEnvironment(deps.db, deps.hub, args.environmentId);
  }
  try {
    await destroyHost(deps, args.hostId);
  } catch (destroyError) {
    args.logger.warn(
      {
        err: destroyError,
        hostId: args.hostId,
      },
      "Failed to destroy sandbox host after provisioning failure",
    );
  }
}

async function reuseEnvironmentByHostPath(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
  args: ReuseEnvironmentByHostPathArgs,
): Promise<ReturnType<typeof getThreadSafe> | null> {
  const existing = findEnvironmentByHostPath(deps.db, args.hostId, args.path);
  if (!existing) {
    return null;
  }

  if (existing.projectId !== args.request.projectId) {
    throw new ApiError(
      409,
      "invalid_request",
      "Workspace path is already attached to a different project",
    );
  }

  if (existing.status === "ready") {
    return createThreadInEnvironment(deps, {
      environment: existing,
      request: args.request,
      threadStatus: "idle",
    });
  }

  if (existing.status === "provisioning") {
    return createThreadInEnvironment(deps, {
      environment: existing,
      request: args.request,
      threadStatus: "provisioning",
    });
  }

  throw new ApiError(
    409,
    "invalid_request",
    `Workspace path is already attached to an environment in ${existing.status} state`,
  );
}

async function startQueuedThreadIfNeeded(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environment: Environment;
    execution: Awaited<ReturnType<typeof buildExecutionOptions>>;
    eventSequence: number;
    request: ThreadCreateServiceRequest;
    thread: ReturnType<typeof createThread>;
  },
): Promise<void> {
  await queueThreadStartCommand(deps, {
    thread: args.thread,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      workspaceProvisionType: args.environment.workspaceProvisionType,
    },
    input: args.request.input,
    eventSequence: args.eventSequence,
    execution: args.execution,
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
  });
  transitionThreadStatus(deps.db, deps.hub, args.thread.id, "active");
}

async function createSandboxHostThread(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
  args: CreateSandboxHostThreadArgs,
) {
  const hostId = createHostId();
  const hostName = `sandbox-${hostId.slice(-6)}`;
  const sandboxBackend = createSandboxBackendForId(args.sandboxType);

  upsertHost(deps.db, deps.hub, {
    id: hostId,
    name: hostName,
    provider: args.sandboxType,
    type: "ephemeral",
  });

  let sandboxHost: SandboxHost;
  try {
    sandboxHost = await sandboxBackend.provisionHost({
      config: deps.config,
      hostId,
      hostName,
      serverUrl: requireReachablePublicServerUrl(deps.config),
    });
  } catch (error) {
    deleteHost(deps.db, deps.hub, hostId);
    throw error;
  }

  updateHost(deps.db, deps.hub, hostId, {
    externalId: sandboxHost.externalId,
  });
  deps.sandboxRegistry.set(hostId, sandboxHost);

  const environment = createEnvironment(deps.db, deps.hub, {
    hostId,
    managed: true,
    projectId: args.request.projectId,
    status: "provisioning",
    workspaceProvisionType: "managed-clone",
  });

  let thread;
  try {
    thread = await createThreadInEnvironment(deps, {
      environment,
      request: args.request,
      threadStatus: "provisioning",
    });
  } catch (error) {
    await cleanupFailedSandboxHostThread(deps, {
      environmentId: environment.id,
      hostId,
      logger: deps.logger,
    });
    throw error;
  }

  try {
    await waitForHostSession(deps, hostId);
  } catch (error) {
    await cleanupFailedSandboxHostThread(deps, {
      environmentId: environment.id,
      hostId,
      logger: deps.logger,
      threadId: thread.id,
    });
    throw error;
  }
  const provisionEventSequence = getHighWaterMarks(deps.db, [thread.id])[thread.id] ?? 0;

  const command = buildEnvironmentProvisionCommand({
    branchName: buildManagedBranchName(args.request, thread.id),
    environmentId: environment.id,
    hostId,
    initiator: { threadId: thread.id, eventSequence: provisionEventSequence },
    sourcePath: args.cloneSource.repoUrl,
    targetPath: buildSandboxTargetPath(args.request.projectId, thread.id),
    workspaceProvisionType: "managed-clone",
    setupScript: SETUP_SCRIPT_NAME,
    setupTimeoutMs: SETUP_TIMEOUT_MS,
  });
  requestEnvironmentProvision(deps, {
    environmentId: environment.id,
    kind: "provision",
    command,
  });
  advanceEnvironmentProvisioning(deps, {
    environmentId: environment.id,
  });

  return thread;
}

export async function createThreadFromRequest(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
  request: ThreadCreateServiceRequest,
) {
  requireProjectExists(deps, request.projectId);
  const resolvedEnvironment = resolveStableThreadRequestEnvironment(deps, {
    environment: request.environment,
    projectId: request.projectId,
  });

  if (resolvedEnvironment.type === "sandbox-host") {
    return createSandboxHostThread(deps, {
      cloneSource: resolvedEnvironment.cloneSource,
      request,
      sandboxType: resolvedEnvironment.sandboxType,
    });
  }

  if (resolvedEnvironment.type === "reuse") {
    const environment = resolvedEnvironment.environment;
    requireConnectedHostSession(deps, environment.hostId);
    if (environment.status === "ready") {
      if (!environment.path) {
        throw new ApiError(409, "invalid_request", "Environment is not ready");
      }
      return createThreadInEnvironment(deps, {
        environment,
        request,
        threadStatus: "idle",
      });
    }
    if (environment.status === "provisioning") {
      return createThreadInEnvironment(deps, {
        environment,
        request,
        threadStatus: "provisioning",
      });
    }
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  const hostId = resolvedEnvironment.hostId;
  const workspace = resolvedEnvironment.workspace;
  const managedSource: LocalPathProjectSource | null =
    workspace.type === "unmanaged" ? null : resolvedEnvironment.localSource;
  const unmanagedPath =
    workspace.type === "unmanaged" ? resolvedEnvironment.unmanagedPath : null;
  requireConnectedHostSession(deps, hostId);

  if (workspace.type === "unmanaged" && unmanagedPath === null) {
    throw new Error("Validated unmanaged host request is missing a workspace path");
  }

  if (workspace.type === "unmanaged" && unmanagedPath) {
    const reusedThread = await reuseEnvironmentByHostPath(deps, {
      hostId,
      path: unmanagedPath,
      request,
    });
    if (reusedThread) {
      return reusedThread;
    }
  }
  const environment = createEnvironment(deps.db, deps.hub, {
    projectId: request.projectId,
    hostId,
    managed: workspace.type !== "unmanaged",
    workspaceProvisionType: workspace.type,
    status: "provisioning",
  });
  const thread = createThreadRecord(
    deps,
    request,
    environment.id,
  );
  transitionThreadStatus(deps.db, deps.hub, thread.id, "provisioning");

  const execution = await buildExecutionOptions(
    deps,
    request,
    {
      threadId: thread.id,
    },
    "client/thread/start",
  );
  appendClientTurnEvent(deps, {
    threadId: thread.id,
    environmentId: environment.id,
    type: "client/thread/start",
    input: request.input,
    execution,
    initiator: request.spawnInitiator ?? "user",
    requestMethod: "thread/start",
    source: "spawn",
  });

  const provisioningLabel = workspace.type === "unmanaged"
    ? "Provisioning environment"
    : workspace.type === "managed-worktree"
      ? "Provisioning worktree"
      : "Provisioning clone";
  const provisionEventSequence = appendProvisioningEvent(deps, {
    threadId: thread.id,
    environmentId: environment.id,
    status: "started",
    entries: [
      {
        type: "step",
        key: "provision",
        text: provisioningLabel,
        status: "started",
      },
    ],
  });

  let provisionCommand: ReturnType<typeof buildEnvironmentProvisionCommand>;
  switch (workspace.type) {
    case "unmanaged": {
      if (unmanagedPath === null) {
        throw new Error("Validated unmanaged host request is missing a workspace path");
      }
      provisionCommand = buildEnvironmentProvisionCommand({
        environmentId: environment.id,
        hostId,
        initiator: { threadId: thread.id, eventSequence: provisionEventSequence },
        path: unmanagedPath,
        workspaceProvisionType: "unmanaged",
      });
      break;
    }
    case "managed-worktree":
    case "managed-clone": {
      if (!managedSource) {
        throw new Error("Validated managed host request is missing a local source");
      }
      provisionCommand = buildEnvironmentProvisionCommand({
        environmentId: environment.id,
        hostId,
        initiator: { threadId: thread.id, eventSequence: provisionEventSequence },
        workspaceProvisionType: workspace.type,
        sourcePath: managedSource.path,
        targetPath: buildManagedTargetPath(
          managedSource.path,
          request.projectId,
          thread.id,
        ),
        branchName: buildManagedBranchName(request, thread.id),
        setupScript: SETUP_SCRIPT_NAME,
        setupTimeoutMs: SETUP_TIMEOUT_MS,
      });
      break;
    }
    default: {
      const _exhaustive: never = workspace;
      throw new Error(`Unsupported workspace request: ${_exhaustive}`);
    }
  }

  requestEnvironmentProvision(deps, {
    environmentId: environment.id,
    kind: "provision",
    command: provisionCommand,
  });
  advanceEnvironmentProvisioning(deps, {
    environmentId: environment.id,
  });

  if (!request.title) {
    void generateThreadTitle(deps, {
      threadId: thread.id,
      input: request.input,
    });
  }
  return getThreadSafe(deps, thread.id);
}

export async function ensureProjectSourceEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    hostId: string;
    path: string;
    projectId: string;
  },
): Promise<Environment> {
  const existing = findEnvironmentByHostPath(deps.db, args.hostId, args.path);
  if (existing && existing.status === "ready") {
    return existing;
  }

  const environment = existing ?? createEnvironment(deps.db, deps.hub, {
    projectId: args.projectId,
    hostId: args.hostId,
    managed: false,
    workspaceProvisionType: "unmanaged",
    status: "provisioning",
  });

  requireConnectedHostSession(deps, args.hostId);
  const command = buildEnvironmentProvisionCommand({
    environmentId: environment.id,
    hostId: args.hostId,
    initiator: null,
    workspaceProvisionType: "unmanaged",
    path: args.path,
  });
  requestEnvironmentProvision(deps, {
    environmentId: environment.id,
    kind: "provision",
    command,
  });
  const commandId = advanceEnvironmentProvisioning(deps, {
    environmentId: environment.id,
  });
  if (!commandId) {
    throw new ApiError(
      500,
      "internal_error",
      "Failed to queue environment provisioning",
    );
  }
  const rawResult = await waitForQueuedCommandResult(deps, {
    commandId,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const result = hostDaemonCommandResultSchemaByType["environment.provision"].parse(rawResult);

  const updated = applyProvisionedEnvironment(deps.db, deps.hub, environment.id, {
    path: result.path,
    status: "ready",
    isGitRepo: result.isGitRepo,
    isWorktree: result.isWorktree,
    branchName: result.branchName,
    defaultBranch: result.defaultBranch,
  });
  if (!updated) {
    throw new ApiError(500, "internal_error", "Failed to update environment");
  }
  return updated;
}
