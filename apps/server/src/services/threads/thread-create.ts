import {
  createEnvironment,
  createEnvironmentProvisioningId,
  deleteThread,
  findEnvironmentByHostPath,
  getEnvironment,
} from "@bb/db";
import { applyProvisionedEnvironmentRecord } from "@bb/db/internal-lifecycle";
import type { Environment } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { waitForQueuedCommandResult } from "../hosts/command-wait.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { requireNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { seedManagerThreadStorage } from "./manager-storage-templates.js";
import {
  prependManagerPreferencesSystemMessageIfChanged,
  recordManagerDynamicFileDelivery,
  withManagerPreferencesDeliveryLock,
} from "./manager-dynamic-file-delivery.js";
import {
  rememberProjectExecutionDefaultsForCreate,
  resolveProjectExecutionDefaultsForCreate,
} from "./project-execution-defaults.js";
import {
  buildEnvironmentProvisionCommand,
  createThreadRecord,
  getThreadSafe,
  requirePublicProjectForThreadCreate,
} from "./thread-create-helpers.js";
import {
  advanceEnvironmentProvisioning,
  requestEnvironmentProvision,
} from "../environments/environment-provisioning.js";
import { buildDirectEnvironmentProvisionRequest } from "../environments/environment-provision-request.js";
import { resolveStableThreadRequestEnvironment } from "./thread-request-eligibility.js";
import { resolveCreateThreadEnvironment } from "./thread-default-policy.js";
import { assertValidManagerParentThread } from "./thread-parent.js";
import {
  type ThreadCreateServiceRequestInput,
  type ThreadCreateServiceRequest,
} from "./thread-create-request.js";
import {
  advanceThreadProvisioning,
  requestThreadProvision,
  type RequestThreadProvisionArgs,
} from "./thread-provisioning.js";
import { requireThreadStoragePath } from "./thread-storage.js";

type ThreadCreateDeps = Pick<
  AppDeps,
  | "config"
  | "db"
  | "hostLifecycle"
  | "hub"
  | "lifecycleDedupers"
  | "logger"
  | "machineAuth"
>;

interface ReuseEnvironmentIntentByHostPathArgs {
  hostId: string;
  path: string;
  request: ThreadCreateServiceRequest;
}

interface CreateProvisioningThreadArgs {
  environmentId: string | null;
  executionDefaults: Parameters<
    typeof buildExecutionOptions
  >[2]["projectDefaults"];
  request: ThreadCreateServiceRequest;
}

interface EnsureProjectSourceEnvironmentArgs {
  hostId: string;
  path: string;
  projectId: string;
}

type ThreadProvisionEnvironmentIntent =
  RequestThreadProvisionArgs["environmentIntent"];

interface PrepareManagerThreadInitialInputArgs {
  environmentIntent: ThreadProvisionEnvironmentIntent;
  input: ThreadCreateServiceRequest["input"];
  request: ThreadCreateServiceRequest;
  thread: NonNullable<ReturnType<typeof createThreadRecord>>;
}

function scheduleThreadProvisioningAdvance(
  deps: ThreadCreateDeps,
  threadId: string,
): void {
  void advanceThreadProvisioning(deps, {
    threadId,
  }).catch((error) => {
    deps.logger.warn(
      { err: error, threadId },
      "Failed to advance thread provisioning after thread creation",
    );
  });
}

function resolveProvisionHostId(
  deps: ThreadCreateDeps,
  environmentIntent: ThreadProvisionEnvironmentIntent,
): string {
  switch (environmentIntent.type) {
    case "direct-managed":
    case "direct-unmanaged":
      return environmentIntent.hostId;
    case "reuse": {
      const environment = getEnvironment(
        deps.db,
        environmentIntent.environmentId,
      );
      if (!environment) {
        throw new ApiError(
          404,
          "environment_not_found",
          "Environment not found",
        );
      }
      return environment.hostId;
    }
  }
}

async function prepareManagerThreadInitialInput(
  deps: ThreadCreateDeps,
  args: PrepareManagerThreadInitialInputArgs,
) {
  if (args.thread.type !== "manager") {
    return { input: args.input, stateUpdate: null };
  }

  const hostId = resolveProvisionHostId(deps, args.environmentIntent);
  const threadStoragePath = await requireThreadStoragePath(deps, {
    hostId,
    threadId: args.thread.id,
  });
  await seedManagerThreadStorage(deps, {
    explicitTemplateName: args.request.managerTemplateName,
    hostId,
    threadId: args.thread.id,
    threadStoragePath,
  });
  return prependManagerPreferencesSystemMessageIfChanged(deps, {
    hostId,
    input: args.input,
    mode: "first-boot",
    thread: args.thread,
  });
}

function reuseEnvironmentIntentByHostPath(
  deps: ThreadCreateDeps,
  args: ReuseEnvironmentIntentByHostPathArgs,
): Extract<ThreadProvisionEnvironmentIntent, { type: "reuse" }> | null {
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

  if (existing.status === "ready" || existing.status === "provisioning") {
    return {
      type: "reuse",
      environmentId: existing.id,
    };
  }

  throw new ApiError(
    409,
    "invalid_request",
    `Workspace path is already attached to an environment in ${existing.status} state`,
  );
}

async function createProvisioningThread(
  deps: ThreadCreateDeps,
  args: CreateProvisioningThreadArgs & {
    environmentIntent: ThreadProvisionEnvironmentIntent;
  },
) {
  const thread = createThreadRecord(deps, {
    request: args.request,
    environmentId: args.environmentId,
    status: "provisioning",
  });
  let execution: Awaited<ReturnType<typeof buildExecutionOptions>>;
  try {
    execution = await buildExecutionOptions(
      deps,
      args.request,
      {
        ...(args.executionDefaults
          ? { projectDefaults: args.executionDefaults }
          : {}),
        threadId: thread.id,
      },
      "client/turn/requested",
    );
    await withManagerPreferencesDeliveryLock({ thread }, async () => {
      const preparedInput = await prepareManagerThreadInitialInput(deps, {
        environmentIntent: args.environmentIntent,
        input: args.request.input,
        request: args.request,
        thread,
      });
      requestThreadProvision(deps, {
        thread,
        environmentIntent: args.environmentIntent,
        execution,
        input: preparedInput.input,
        managerTemplateName: args.request.managerTemplateName,
        titleProvided: Boolean(args.request.title),
      });
      recordManagerDynamicFileDelivery(deps, preparedInput.stateUpdate);
    });
  } catch (error) {
    deleteThread(deps.db, deps.hub, thread.id);
    throw error;
  }
  rememberProjectExecutionDefaultsForCreate(deps, {
    execution,
    request: args.request,
  });
  scheduleThreadProvisioningAdvance(deps, thread.id);
  return getThreadSafe(deps, thread.id);
}

export async function createThreadFromRequest(
  deps: ThreadCreateDeps,
  requestInput: ThreadCreateServiceRequestInput,
) {
  requirePublicProjectForThreadCreate(deps, requestInput.projectId);
  const parentThread = requestInput.parentThreadId
    ? assertValidManagerParentThread(deps, {
        parentThreadId: requestInput.parentThreadId,
        projectId: requestInput.projectId,
      })
    : null;
  const { executionDefaults, providerId } =
    resolveProjectExecutionDefaultsForCreate(deps, {
      model: requestInput.model,
      projectId: requestInput.projectId,
      providerId: requestInput.providerId,
      threadType: requestInput.type,
    });
  const request: ThreadCreateServiceRequest = {
    ...requestInput,
    environment: resolveCreateThreadEnvironment({
      parentThread,
      projectId: requestInput.projectId,
      requestedEnvironment: requestInput.environment,
      threadType: requestInput.type,
    }),
    providerId,
  };
  const resolvedEnvironment = resolveStableThreadRequestEnvironment(deps, {
    environment: request.environment,
    projectId: request.projectId,
  });

  let environmentId: string | null = null;
  let environmentIntent: ThreadProvisionEnvironmentIntent;

  switch (resolvedEnvironment.type) {
    case "reuse": {
      const environment = resolvedEnvironment.environment;
      if (
        environment.status !== "ready" &&
        environment.status !== "provisioning"
      ) {
        throw new ApiError(409, "invalid_request", "Environment is not ready");
      }
      if (environment.status === "ready" && !environment.path) {
        throw new ApiError(409, "invalid_request", "Environment is not ready");
      }
      if (environment.status === "provisioning") {
        requireNonDestroyedHostWithStatus(deps.db, environment.hostId);
      }
      environmentId = environment.id;
      environmentIntent = {
        type: "reuse",
        environmentId: environment.id,
      };
      break;
    }
    case "host": {
      const hostId = resolvedEnvironment.hostId;
      const workspace = resolvedEnvironment.workspace;
      if (workspace.type === "unmanaged") {
        if (resolvedEnvironment.unmanagedPath === null) {
          throw new Error(
            "Validated unmanaged host request is missing a workspace path",
          );
        }
        const reuseIntent = reuseEnvironmentIntentByHostPath(deps, {
          hostId,
          path: resolvedEnvironment.unmanagedPath,
          request,
        });
        environmentIntent = reuseIntent ?? {
          type: "direct-unmanaged",
          hostId,
          path: resolvedEnvironment.unmanagedPath,
          ...(workspace.branch ? { branch: workspace.branch } : {}),
        };
        if (reuseIntent) {
          environmentId = reuseIntent.environmentId;
        }
        break;
      }

      const managedSource = resolvedEnvironment.localSource;
      if (!managedSource) {
        throw new Error(
          "Validated managed host request is missing a local source",
        );
      }
      environmentIntent = {
        type: "direct-managed",
        hostId,
        sourcePath: managedSource.path,
        baseBranch: workspace.baseBranch,
        workspaceProvisionType: workspace.type,
      };
      break;
    }
  }

  return createProvisioningThread(deps, {
    environmentId,
    environmentIntent,
    executionDefaults,
    request,
  });
}

export async function ensureProjectSourceEnvironment(
  deps: Pick<
    AppDeps,
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "lifecycleDedupers"
    | "logger"
    | "machineAuth"
  >,
  args: EnsureProjectSourceEnvironmentArgs,
): Promise<Environment> {
  const existing = findEnvironmentByHostPath(deps.db, args.hostId, args.path);
  if (existing && existing.status === "ready") {
    return existing;
  }

  const environment =
    existing ??
    createEnvironment(deps.db, deps.hub, {
      projectId: args.projectId,
      hostId: args.hostId,
      managed: false,
      workspaceProvisionType: "unmanaged",
      status: "provisioning",
    });

  await ensureHostSessionReadyForWork(deps, {
    hostId: args.hostId,
  });
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
    request: buildDirectEnvironmentProvisionRequest({
      command,
      provisioningId: createEnvironmentProvisioningId(),
    }),
  });
  const commandId = await advanceEnvironmentProvisioning(deps, {
    environmentId: environment.id,
  });
  if (!commandId) {
    throw new ApiError(
      500,
      "internal_error",
      "Failed to queue environment provisioning",
    );
  }
  const result = await waitForQueuedCommandResult(deps, {
    commandId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    type: "environment.provision",
  });

  const updated = applyProvisionedEnvironmentRecord(
    deps.db,
    deps.hub,
    environment.id,
    {
      path: result.path,
      status: "ready",
      isGitRepo: result.isGitRepo,
      isWorktree: result.isWorktree,
      branchName: result.branchName,
      defaultBranch: result.defaultBranch,
    },
  );
  if (!updated) {
    throw new ApiError(500, "internal_error", "Failed to update environment");
  }
  return updated;
}
