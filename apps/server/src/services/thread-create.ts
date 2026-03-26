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
import type { CreateThreadRequest } from "@bb/server-contract";
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

function startQueuedThreadIfNeeded(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environment: Environment;
    request: CreateThreadRequest;
    thread: ReturnType<typeof createThread>;
  },
): void {
  if (!args.request.input || args.request.input.length === 0) {
    return;
  }

  queueThreadStartCommand(deps, {
    thread: args.thread,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
    },
    input: args.request.input,
    execution: buildExecutionOptions(args.request, "client/thread/start"),
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
  });
  transitionThreadStatus(deps.db, deps.hub, args.thread.id, "active");
}

export async function createThreadFromRequest(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
  request: CreateThreadRequest,
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

    const thread = createThreadRecord(deps, request, environment.id);
    transitionThreadStatus(deps.db, deps.hub, thread.id, "idle");
    if (request.input && request.input.length > 0) {
      appendClientTurnEvent(deps, thread.id, environment.id, "client/thread/start", {
        input: request.input,
        execution: buildExecutionOptions(request, "client/thread/start"),
        initiator: request.spawnInitiator ?? "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      try {
        startQueuedThreadIfNeeded(deps, {
          thread,
          environment,
          request,
        });
      } catch (error) {
        deleteThread(deps.db, deps.hub, thread.id);
        throw error;
      }
    }

    if (!request.title && request.input && request.input.length > 0) {
      void generateThreadTitle(deps, {
        threadId: thread.id,
        input: request.input,
      });
    }
    return getEnvironment(deps.db, environment.id) ? getThreadSafe(deps, thread.id) : thread;
  }

  const hostId = request.environment.hostId;
  requireConnectedHostSession(deps, hostId);
  const workspace = request.environment.workspace;
  const defaultSource = requireDefaultSource(deps, request.projectId);
  const unmanagedPath = workspace.type === "unmanaged"
    ? workspace.path ?? defaultSource.path
    : null;

  if (workspace.type === "unmanaged" && !unmanagedPath) {
    throw new ApiError(409, "invalid_request", "Workspace path is required");
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
  const thread = createThreadRecord(deps, request, environment.id);
  transitionThreadStatus(deps.db, deps.hub, thread.id, "provisioning");

  if (request.input && request.input.length > 0) {
    appendClientTurnEvent(deps, thread.id, environment.id, "client/thread/start", {
      input: request.input,
      execution: buildExecutionOptions(request, "client/thread/start"),
      initiator: request.spawnInitiator ?? "user",
      requestMethod: "thread/start",
      source: "spawn",
    });
  }

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

  if (!request.title && request.input && request.input.length > 0) {
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
  });
  if (!updated) {
    throw new ApiError(500, "internal_error", "Failed to update environment");
  }
  return updated;
}
