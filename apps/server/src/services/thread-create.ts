import {
  applyProvisionedEnvironment,
  createEnvironment,
  createHostId,
  createThread,
  deleteHost,
  deleteThread,
  findEnvironmentByHostPath,
  getEnvironment,
  getHighWaterMarks,
  transitionThreadStatus,
  updateHost,
  upsertHost,
} from "@bb/db";
import type { Environment } from "@bb/domain";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import { provisionHost } from "@bb/sandbox-host";
import type { SandboxHost } from "@bb/sandbox-host";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { queueCommandAndWait } from "./command-wait.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { requireConnectedHostSession } from "./entity-lookup.js";
import { waitForHostSession } from "./host-lifecycle.js";
import { buildSandboxDaemonEnv } from "./sandbox-daemon-env.js";
import { appendClientTurnEvent, appendProvisioningEvent, buildCwdBranchEntries } from "./thread-events.js";
import { buildExecutionOptions, queueThreadStartCommand } from "./thread-commands.js";
import { generateThreadTitle } from "./title-generation.js";
import {
  buildManagedBranchName,
  buildManagedTargetPath,
  buildSandboxTargetPath,
  createThreadRecord,
  getThreadSafe,
  queueEnvironmentProvision,
  requireProjectExists,
  requireSandboxCloneSource,
  SETUP_SCRIPT_NAME,
  SETUP_TIMEOUT_MS,
  requireSourceForHost,
} from "./thread-create-helpers.js";
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
  request: ThreadCreateServiceRequest;
  sandboxType: string;
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
    try {
      await startQueuedThreadIfNeeded(deps, {
        thread,
        environment: args.environment,
        execution,
        eventSequence: latestSequence,
        request: args.request,
      });
    } catch (error) {
      deleteThread(deps.db, deps.hub, thread.id);
      throw error;
    }
  }

  if (!args.request.title) {
    void generateThreadTitle(deps, {
      threadId: thread.id,
      input: args.request.input,
    });
  }

  return getThreadSafe(deps, thread.id);
}

function ensurePublicServerUrl(publicUrl: string): string {
  const parsedUrl = new URL(publicUrl);
  if (
    parsedUrl.hostname === "localhost" ||
    parsedUrl.hostname === "127.0.0.1" ||
    parsedUrl.hostname === "0.0.0.0" ||
    parsedUrl.hostname === "::1" ||
    parsedUrl.hostname === "[::1]"
  ) {
    throw new ApiError(
      409,
      "invalid_request",
      "Sandbox provisioning requires BB_PUBLIC_URL to be reachable from the internet",
    );
  }
  return publicUrl;
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
  if (!deps.config.e2bApiKey) {
    throw new ApiError(
      501,
      "not_configured",
      "Sandbox provisioning requires E2B_API_KEY to be configured",
    );
  }

  const defaultSource = requireSandboxCloneSource(deps, args.request.projectId);
  const hostId = createHostId();
  const hostName = `sandbox-${hostId.slice(-6)}`;

  upsertHost(deps.db, deps.hub, {
    id: hostId,
    name: hostName,
    provider: args.sandboxType,
    type: "ephemeral",
  });

  let sandboxHost: SandboxHost;
  try {
    sandboxHost = await provisionHost({
      apiKey: deps.config.e2bApiKey,
      authToken: deps.config.authToken,
      daemonEnv: buildSandboxDaemonEnv(deps.config.githubPat),
      hostId,
      hostName,
      sandboxType: args.sandboxType,
      serverUrl: ensurePublicServerUrl(deps.config.publicUrl),
      template: deps.config.e2bTemplate === "" ? undefined : deps.config.e2bTemplate,
    });
  } catch (error) {
    deleteHost(deps.db, deps.hub, hostId);
    throw error;
  }

  updateHost(deps.db, deps.hub, hostId, {
    externalId: sandboxHost.externalId,
  });
  deps.sandboxRegistry.set(hostId, sandboxHost);

  try {
    await waitForHostSession(deps, hostId);
  } catch (error) {
    deps.sandboxRegistry.remove(hostId);
    await sandboxHost.destroy().catch(() => {});
    updateHost(deps.db, deps.hub, hostId, { destroyedAt: Date.now() });
    throw error;
  }

  const environment = createEnvironment(deps.db, deps.hub, {
    hostId,
    managed: true,
    projectId: args.request.projectId,
    status: "provisioning",
    workspaceProvisionType: "managed-clone",
  });
  const thread = await createThreadInEnvironment(deps, {
    environment,
    request: args.request,
    threadStatus: "provisioning",
  });
  const provisionEventSequence = getHighWaterMarks(deps.db, [thread.id])[thread.id] ?? 0;

  queueEnvironmentProvision(deps, {
    branchName: buildManagedBranchName(args.request, thread.id),
    environmentId: environment.id,
    hostId,
    initiator: { threadId: thread.id, eventSequence: provisionEventSequence },
    sourcePath: defaultSource.repoUrl,
    targetPath: buildSandboxTargetPath(args.request.projectId, thread.id),
    workspaceProvisionType: "managed-clone",
    setupScript: SETUP_SCRIPT_NAME,
    setupTimeoutMs: SETUP_TIMEOUT_MS,
  });

  return thread;
}

export async function createThreadFromRequest(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
  request: ThreadCreateServiceRequest,
) {
  requireProjectExists(deps, request.projectId);

  if (request.environment.type === "sandbox-host") {
    return createSandboxHostThread(deps, {
      request,
      sandboxType: request.environment.sandboxType,
    });
  }

  if (request.environment.type === "reuse") {
    const environment = getEnvironment(deps.db, request.environment.environmentId);
    if (!environment) {
      throw new ApiError(404, "invalid_request", "Environment not found");
    }
    if (environment.projectId !== request.projectId) {
      throw new ApiError(
        409,
        "invalid_request",
        "Environment belongs to a different project",
      );
    }
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

  const hostId = request.environment.hostId;
  requireConnectedHostSession(deps, hostId);
  const workspace = request.environment.workspace;
  const managedSource = workspace.type === "unmanaged"
    ? null
    : requireSourceForHost(deps, request.projectId, hostId);
  const unmanagedPath = workspace.type === "unmanaged"
    ? workspace.path ?? requireSourceForHost(deps, request.projectId, hostId).path
    : null;

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

  switch (workspace.type) {
    case "unmanaged": {
      queueEnvironmentProvision(deps, {
        environmentId: environment.id,
        hostId,
        initiator: { threadId: thread.id, eventSequence: provisionEventSequence },
        path: unmanagedPath ?? undefined,
        workspaceProvisionType: "unmanaged",
      });
      break;
    }
    case "managed-worktree":
    case "managed-clone": {
      const source = managedSource ?? requireSourceForHost(
        deps,
        request.projectId,
        hostId,
      );
      queueEnvironmentProvision(deps, {
        environmentId: environment.id,
        hostId,
        initiator: { threadId: thread.id, eventSequence: provisionEventSequence },
        workspaceProvisionType: workspace.type,
        sourcePath: source.path,
        targetPath: buildManagedTargetPath(source.path, request.projectId, thread.id),
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

  const rawResult = await queueCommandAndWait(deps, {
    hostId: args.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "environment.provision",
      environmentId: environment.id,
      initiator: null,
      workspaceProvisionType: "unmanaged",
      path: args.path,
    },
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
