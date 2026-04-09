import {
  createEnvironment,
  createHostId,
  createThread,
  deleteEnvironment,
  deleteHost,
  deleteThread,
  findEnvironmentByHostPath,
  getHighWaterMarks,
  upsertHost,
} from "@bb/db";
import { applyProvisionedEnvironmentRecord } from "@bb/db/internal-lifecycle";
import type {
  Environment,
  GitHubRepoProjectSource,
  LocalPathProjectSource,
  ProvisioningTranscriptEntry,
} from "@bb/domain";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  waitForQueuedCommandResult,
} from "../hosts/command-wait.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import {
  requireConnectedHostSession,
  requireNonDestroyedHostWithStatus,
} from "../lib/entity-lookup.js";
import { requireReachablePublicServerUrl } from "../hosts/public-server-url.js";
import { assertSandboxProvisioningConfig } from "../hosts/sandbox-backends.js";
import { appendClientTurnEvent, appendProvisioningEvent, buildCwdBranchEntries } from "./thread-events.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  rememberProjectExecutionDefaultsForCreate,
  resolveProjectExecutionDefaultsForCreate,
} from "./project-execution-defaults.js";
import { generateThreadTitle } from "./title-generation.js";
import {
  buildManagedBranchName,
  buildEnvironmentProvisionCommand,
  buildManagedTargetPath,
  buildSandboxTargetPath,
  createThreadRecord,
  getThreadSafe,
  requireProjectExists,
  SETUP_TIMEOUT_MS,
} from "./thread-create-helpers.js";
import {
  advanceEnvironmentProvisioning,
  requestEnvironmentProvision,
} from "../environments/environment-provisioning.js";
import {
  buildDirectEnvironmentProvisionRequest,
  buildSandboxHostEnvironmentProvisionRequest,
} from "../environments/environment-provision-request.js";
import { requestThreadStart } from "./thread-lifecycle.js";
import {
  resolveStableThreadRequestEnvironment,
} from "./thread-request-eligibility.js";
import {
  type ThreadCreateServiceRequestInput,
  type ThreadCreateServiceRequest,
} from "./thread-create-request.js";

interface CreateThreadInEnvironmentArgs {
  environment: Environment;
  projectDefaults: Parameters<typeof buildExecutionOptions>[2]["projectDefaults"];
  provisioningEntries?: ProvisioningTranscriptEntry[];
  request: ThreadCreateServiceRequest;
  threadStatus: "created" | "provisioning";
}

interface ReuseEnvironmentByHostPathArgs {
  hostId: string;
  path: string;
  projectDefaults: Parameters<typeof buildExecutionOptions>[2]["projectDefaults"];
  request: ThreadCreateServiceRequest;
}

interface CreateSandboxHostThreadArgs {
  cloneSource: GitHubRepoProjectSource;
  projectDefaults: Parameters<typeof buildExecutionOptions>[2]["projectDefaults"];
  request: ThreadCreateServiceRequest;
  sandboxType: string;
}

async function createThreadInEnvironment(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
  args: CreateThreadInEnvironmentArgs,
) {
  const thread = createThreadRecord(
    deps,
    {
      request: args.request,
      environmentId: args.environment.id,
      status: args.threadStatus,
    },
  );
  let execution: Awaited<ReturnType<typeof buildExecutionOptions>>;
  try {
    execution = await buildExecutionOptions(
      deps,
      args.request,
      {
        ...(args.projectDefaults ? { projectDefaults: args.projectDefaults } : {}),
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
        initiator: args.request.type === "manager" ? "system" : "user",
        requestMethod: "thread/start",
        source: "spawn",
      },
    );

    if (args.threadStatus === "provisioning") {
      appendProvisioningEvent(deps, {
        threadId: thread.id,
        environmentId: args.environment.id,
        status: "started",
        entries: args.provisioningEntries ?? [
          {
            type: "step",
            key: "provision",
            text: "Waiting for environment...",
            status: "started",
          },
        ],
      });
    }

    if (args.threadStatus === "created") {
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
  rememberProjectExecutionDefaultsForCreate(deps, {
    execution,
    request: args.request,
  });

  if (!args.request.title) {
    void generateThreadTitle(deps, {
      threadId: thread.id,
      input: args.request.input,
    });
  }

  return getThreadSafe(deps, thread.id);
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
      projectDefaults: args.projectDefaults,
      request: args.request,
      threadStatus: "created",
    });
  }

  if (existing.status === "provisioning") {
    return createThreadInEnvironment(deps, {
      environment: existing,
      projectDefaults: args.projectDefaults,
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
  await requestThreadStart(deps, {
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
}

async function createSandboxHostThread(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "machineAuth" | "sandboxRegistry">,
  args: CreateSandboxHostThreadArgs,
) {
  requireReachablePublicServerUrl(deps.config);
  assertSandboxProvisioningConfig(args.sandboxType, deps.config);

  const hostId = createHostId();
  const hostName = `sandbox-${hostId.slice(-6)}`;

  upsertHost(deps.db, deps.hub, {
    id: hostId,
    name: hostName,
    provider: args.sandboxType,
    type: "ephemeral",
  });

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
      projectDefaults: args.projectDefaults,
      provisioningEntries: [
        {
          type: "step",
          key: "sandbox-host",
          text: "Preparing sandbox host",
          status: "started",
        },
      ],
      request: args.request,
      threadStatus: "provisioning",
    });
  } catch (error) {
    deleteEnvironment(deps.db, deps.hub, environment.id);
    deleteHost(deps.db, deps.hub, hostId);
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
    setupTimeoutMs: SETUP_TIMEOUT_MS,
  });
  requestEnvironmentProvision(deps, {
    environmentId: environment.id,
    kind: "provision",
    request: buildSandboxHostEnvironmentProvisionRequest({
      command,
      sandboxType: args.sandboxType,
    }),
  });
  advanceEnvironmentProvisioning(deps, {
    environmentId: environment.id,
  });

  return thread;
}

export async function createThreadFromRequest(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "machineAuth" | "sandboxRegistry">,
  requestInput: ThreadCreateServiceRequestInput,
) {
  requireProjectExists(deps, requestInput.projectId);
  const { executionDefaults, providerId } = resolveProjectExecutionDefaultsForCreate(
    deps,
    {
      model: requestInput.model,
      origin: requestInput.origin,
      projectId: requestInput.projectId,
      providerId: requestInput.providerId,
      threadType: requestInput.type,
    },
  );
  const request: ThreadCreateServiceRequest = {
    ...requestInput,
    providerId,
  };
  const resolvedEnvironment = resolveStableThreadRequestEnvironment(deps, {
    environment: request.environment,
    projectId: request.projectId,
  });

  if (resolvedEnvironment.type === "sandbox-host") {
    return createSandboxHostThread(deps, {
      cloneSource: resolvedEnvironment.cloneSource,
      projectDefaults: executionDefaults,
      request,
      sandboxType: resolvedEnvironment.sandboxType,
    });
  }

  if (resolvedEnvironment.type === "reuse") {
    const environment = resolvedEnvironment.environment;
    if (environment.status === "provisioning") {
      requireNonDestroyedHostWithStatus(deps.db, environment.hostId);
      return createThreadInEnvironment(deps, {
        environment,
        projectDefaults: executionDefaults,
        request,
        threadStatus: "provisioning",
      });
    }

    requireConnectedHostSession(deps, environment.hostId);
    if (environment.status === "ready") {
      if (!environment.path) {
        throw new ApiError(409, "invalid_request", "Environment is not ready");
      }
      return createThreadInEnvironment(deps, {
        environment,
        projectDefaults: executionDefaults,
        request,
        threadStatus: "created",
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
      projectDefaults: executionDefaults,
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
    {
      request,
      environmentId: environment.id,
      status: "provisioning",
    },
  );

  const execution = await buildExecutionOptions(
    deps,
    request,
    {
      ...(executionDefaults ? { projectDefaults: executionDefaults } : {}),
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
    initiator: request.type === "manager" ? "system" : "user",
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
    request: buildDirectEnvironmentProvisionRequest(provisionCommand),
  });
  advanceEnvironmentProvisioning(deps, {
    environmentId: environment.id,
  });
  rememberProjectExecutionDefaultsForCreate(deps, {
    execution,
    request,
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
  deps: Pick<
    AppDeps,
    "config" | "db" | "hub" | "machineAuth" | "sandboxRegistry"
  >,
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
    request: buildDirectEnvironmentProvisionRequest(command),
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

  const updated = applyProvisionedEnvironmentRecord(deps.db, deps.hub, environment.id, {
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
