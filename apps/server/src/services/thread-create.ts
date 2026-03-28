import {
  createEnvironment,
  createThread,
  deleteThread,
  findEnvironmentByHostPath,
  getEnvironment,
  transitionThreadStatus,
  updateEnvironment,
} from "@bb/db";
import type { Environment } from "@bb/domain";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { queueCommandAndWait } from "./command-wait.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { requireConnectedHostSession } from "./entity-lookup.js";
import { appendClientTurnEvent, appendProvisioningEvent } from "./thread-events.js";
import { buildExecutionOptions, queueThreadStartCommand } from "./thread-commands.js";
import { generateThreadTitle } from "./title-generation.js";
import {
  buildManagedBranchName,
  buildManagedTargetPath,
  createThreadRecord,
  getThreadSafe,
  queueEnvironmentProvision,
  requireDefaultSource,
  requireProjectExists,
} from "./thread-create-helpers.js";
import {
  hasThreadStartInput,
  type PublicThreadCreateServiceRequest,
  type ThreadCreateServiceRequest,
} from "./thread-create-request.js";

interface CreateThreadInEnvironmentArgs {
  environment: Environment;
  mergeBaseBranch: string | null;
  request: ThreadCreateServiceRequest;
  threadStatus: "idle" | "provisioning";
}

interface ReuseUnmanagedEnvironmentArgs {
  hostId: string;
  mergeBaseBranch: string | null;
  path: string;
  request: ThreadCreateServiceRequest;
}

async function createThreadInEnvironment(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
  args: CreateThreadInEnvironmentArgs,
) {
  const thread = createThreadRecord(
    deps,
    args.request,
    args.environment.id,
    args.mergeBaseBranch,
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
      ...(hasThreadStartInput(args.request) ? { input: args.request.input } : {}),
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
          key: "environment",
          text: "environment: Direct",
          status: "completed",
        },
      ],
    });
  }

  if (hasThreadStartInput(args.request) && args.threadStatus === "idle") {
    try {
      await startQueuedThreadIfNeeded(deps, {
        thread,
        environment: args.environment,
        execution,
        eventSequence,
        request: args.request,
      });
    } catch (error) {
      deleteThread(deps.db, deps.hub, thread.id);
      throw error;
    }
  }

  if (!args.request.title && hasThreadStartInput(args.request)) {
    void generateThreadTitle(deps, {
      threadId: thread.id,
      input: args.request.input,
    });
  }

  return getThreadSafe(deps, thread.id);
}

async function maybeReuseUnmanagedEnvironment(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
  args: ReuseUnmanagedEnvironmentArgs,
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
      mergeBaseBranch: args.mergeBaseBranch,
      request: args.request,
      threadStatus: "idle",
    });
  }

  if (existing.status === "provisioning") {
    return createThreadInEnvironment(deps, {
      environment: existing,
      mergeBaseBranch: args.mergeBaseBranch,
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
    request: PublicThreadCreateServiceRequest;
    thread: ReturnType<typeof createThread>;
  },
): Promise<void> {
  await queueThreadStartCommand(deps, {
    thread: args.thread,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
    },
    input: args.request.input,
    eventSequence: args.eventSequence,
    execution: args.execution,
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
  });
  transitionThreadStatus(deps.db, deps.hub, args.thread.id, "active");
}

export async function createThreadFromRequest(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
  request: ThreadCreateServiceRequest,
) {
  requireProjectExists(deps, request.projectId);

  if (request.environment.type === "sandbox-host") {
    // 501: sandbox-host is intentionally deferred until Phase 8.
    throw new ApiError(
      501,
      "unsupported_operation",
      "Sandbox host provisioning is not implemented yet",
    );
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
    const mergeBaseBranch = environment.defaultBranch ?? null;
    if (environment.status === "ready") {
      if (!environment.path) {
        throw new ApiError(409, "invalid_request", "Environment is not ready");
      }
      return createThreadInEnvironment(deps, {
        environment,
        mergeBaseBranch,
        request,
        threadStatus: "idle",
      });
    }
    if (environment.status === "provisioning") {
      return createThreadInEnvironment(deps, {
        environment,
        mergeBaseBranch,
        request,
        threadStatus: "provisioning",
      });
    }
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  const hostId = request.environment.hostId;
  requireConnectedHostSession(deps, hostId);
  const workspace = request.environment.workspace;
  const defaultSource = requireDefaultSource(deps, request.projectId);
  const unmanagedPath = workspace.type === "unmanaged"
    ? workspace.path ?? defaultSource.path
    : null;
  const mergeBaseBranch = null;

  if (workspace.type === "unmanaged" && !unmanagedPath) {
    throw new ApiError(409, "invalid_request", "Workspace path is required");
  }
  if (workspace.type === "unmanaged" && unmanagedPath) {
    const reusedThread = await maybeReuseUnmanagedEnvironment(deps, {
      hostId,
      mergeBaseBranch,
      path: unmanagedPath,
      request,
    });
    if (reusedThread) {
      return reusedThread;
    }
  }
  if (
    (workspace.type === "managed-worktree" || workspace.type === "managed-clone") &&
    defaultSource.hostId !== hostId
  ) {
    throw new ApiError(
      409,
      "invalid_request",
      "Managed workspaces must run on the default source host",
    );
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
    mergeBaseBranch,
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
    ...(hasThreadStartInput(request) ? { input: request.input } : {}),
    execution,
    initiator: request.spawnInitiator ?? "user",
    requestMethod: "thread/start",
    source: "spawn",
  });

  const provisioningLabel = workspace.type === "unmanaged"
    ? "Direct"
    : workspace.type === "managed-worktree"
      ? "Worktree"
      : "Clone";
  appendProvisioningEvent(deps, {
    threadId: thread.id,
    environmentId: environment.id,
    status: "started",
    entries: [
      {
        type: "step",
        key: "environment",
        text: `environment: ${provisioningLabel}`,
        status: "completed",
      },
    ],
  });

  switch (workspace.type) {
    case "unmanaged": {
      queueEnvironmentProvision(deps, {
        environmentId: environment.id,
        hostId,
        path: unmanagedPath ?? undefined,
        projectId: request.projectId,
        workspaceProvisionType: "unmanaged",
      });
      break;
    }
    case "managed-worktree":
    case "managed-clone": {
      queueEnvironmentProvision(deps, {
        environmentId: environment.id,
        hostId,
        projectId: request.projectId,
        workspaceProvisionType: workspace.type,
        sourcePath: defaultSource.path,
        targetPath: buildManagedTargetPath(defaultSource.path, request.projectId, thread.id),
        branchName: buildManagedBranchName(request, thread.id),
      });
      break;
    }
    default: {
      const _exhaustive: never = workspace;
      throw new Error(`Unsupported workspace request: ${_exhaustive}`);
    }
  }

  if (!request.title && hasThreadStartInput(request)) {
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
      projectId: args.projectId,
      workspaceProvisionType: "unmanaged",
      path: args.path,
    },
  });
  const result = hostDaemonCommandResultSchemaByType["environment.provision"].parse(rawResult);

  const updated = updateEnvironment(deps.db, deps.hub, environment.id, {
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
