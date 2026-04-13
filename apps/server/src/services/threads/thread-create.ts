import {
  createEnvironment,
  createHostId,
  createThread,
  deleteEnvironment,
  deleteHost,
  deleteThread,
  findEnvironmentByHostPath,
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
  requireNonDestroyedHostWithStatus,
} from "../lib/entity-lookup.js";
import { requireReachablePublicServerUrl } from "../hosts/public-server-url.js";
import { assertSandboxProvisioningConfig } from "../hosts/sandbox-backends.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { appendClientTurnEvent, appendThreadProvisioningEvent, buildCwdBranchEntries } from "./thread-events.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  rememberProjectExecutionDefaultsForCreate,
  resolveProjectExecutionDefaultsForCreate,
} from "./project-execution-defaults.js";
import {
  applyGeneratedThreadTitle,
  generateThreadMetadataWithOutcome,
  generateThreadTitle,
  type ThreadMetadataGenerationOutcome,
} from "./title-generation.js";
import {
  buildManagedBranchName,
  buildEnvironmentProvisionCommand,
  createThreadRecord,
  getThreadSafe,
  requireProjectExists,
  SETUP_TIMEOUT_MS,
} from "./thread-create-helpers.js";
import { resolveManagedTargetPath } from "./worktree-paths.js";
import { SANDBOX_DATA_DIR } from "@bb/sandbox-host";
import {
  advanceEnvironmentProvisioning,
  requestEnvironmentProvision,
} from "../environments/environment-provisioning.js";
import {
  buildDirectEnvironmentProvisionRequest,
  buildSandboxHostEnvironmentProvisionRequest,
} from "../environments/environment-provision-request.js";
import { requestThreadStart } from "./thread-lifecycle.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import {
  resolveStableThreadRequestEnvironment,
} from "./thread-request-eligibility.js";
import {
  type ThreadCreateServiceRequestInput,
  type ThreadCreateServiceRequest,
} from "./thread-create-request.js";

type ThreadCreateDeps = Pick<
  AppDeps,
  | "cloudAuth"
  | "config"
  | "db"
  | "hostLifecycle"
  | "hub"
  | "logger"
  | "machineAuth"
  | "sandboxEnv"
  | "sandboxRegistry"
>;

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

interface ManagedThreadMetadataArgs {
  environmentId: string;
  request: ThreadCreateServiceRequest;
  threadId: string;
}

interface ManagedThreadMetadataResult {
  branchSlug: string | null;
  eventSequence: number;
}

interface MetadataCompletedTextArgs {
  outcome: ThreadMetadataGenerationOutcome;
  request: ThreadCreateServiceRequest;
}

interface ScheduleGeneratedThreadTitleArgs {
  request: ThreadCreateServiceRequest;
  threadId: string;
}

interface CreateSandboxHostThreadArgs {
  cloneSource: GitHubRepoProjectSource;
  projectDefaults: Parameters<typeof buildExecutionOptions>[2]["projectDefaults"];
  request: ThreadCreateServiceRequest;
  sandboxType: string;
}

type ManagedThreadMetadataDeps = Pick<ThreadCreateDeps, "config" | "db" | "hub" | "logger">;

const MANAGED_THREAD_METADATA_TIMEOUT_MS = 5_000;

function metadataStartedText(request: ThreadCreateServiceRequest): string {
  return request.title
    ? "Generating branch name"
    : "Generating title and branch name";
}

function metadataCompletedText(args: MetadataCompletedTextArgs): string {
  const hasTitle = !args.request.title && Boolean(args.outcome.metadata?.title);
  const hasBranchName = Boolean(args.outcome.metadata?.branchSlug);
  if (hasTitle && hasBranchName) {
    return "Generated title and branch name";
  }
  if (hasBranchName) {
    return "Generated branch name";
  }
  return "Using fallback branch name";
}

async function resolveManagedThreadMetadata(
  deps: ManagedThreadMetadataDeps,
  args: ManagedThreadMetadataArgs,
): Promise<ManagedThreadMetadataResult> {
  const startedAt = Date.now();
  appendThreadProvisioningEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    status: "active",
    entries: [
      {
        type: "step",
        key: "metadata-started",
        text: metadataStartedText(args.request),
        status: "started",
        startedAt,
      },
    ],
  });

  // Managed branch names must be known before provisioning is queued. Keep
  // inference bounded and let branch creation fall back to bb/<threadId>.
  const outcome = await generateThreadMetadataWithOutcome(deps, {
    input: args.request.input,
    threadId: args.threadId,
    timeoutMs: MANAGED_THREAD_METADATA_TIMEOUT_MS,
  });
  const metadata = outcome.metadata;

  const metadataCompletedSequence = appendThreadProvisioningEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    status: "active",
    entries: [
      {
        type: "step",
        key: "metadata-completed",
        text: metadataCompletedText({ outcome, request: args.request }),
        status: "completed",
        startedAt,
        metadata: {
          durationMs: outcome.durationMs,
          branchNameGenerated: Boolean(metadata?.branchSlug),
          titleGenerated: !args.request.title && Boolean(metadata?.title),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        },
      },
    ],
  });

  if (!args.request.title && metadata?.title) {
    try {
      applyGeneratedThreadTitle(deps, {
        threadId: args.threadId,
        title: metadata.title,
      });
    } catch (error) {
      deps.logger.warn(
        { err: error, threadId: args.threadId },
        "Failed to apply generated thread title",
      );
    }
  }

  return {
    branchSlug: metadata?.branchSlug ?? null,
    eventSequence: metadataCompletedSequence,
  };
}

function scheduleGeneratedThreadTitle(
  deps: ThreadCreateDeps,
  args: ScheduleGeneratedThreadTitleArgs,
): void {
  if (args.request.title) {
    return;
  }

  void generateThreadTitle(deps, {
    threadId: args.threadId,
    input: args.request.input,
  });
}

async function createThreadInEnvironment(
  deps: ThreadCreateDeps,
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
      appendThreadProvisioningEvent(deps, {
        threadId: thread.id,
        environmentId: args.environment.id,
        status: "active",
        entries: args.provisioningEntries ?? [
          {
            type: "step",
            key: "workspace-waiting",
            text: "Waiting for workspace",
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
        latestSequence = appendThreadProvisioningEvent(deps, {
          threadId: thread.id,
          environmentId: args.environment.id,
          status: "active",
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

  return getThreadSafe(deps, thread.id);
}

async function reuseEnvironmentByHostPath(
  deps: ThreadCreateDeps,
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
    const thread = await createThreadInEnvironment(deps, {
      environment: existing,
      projectDefaults: args.projectDefaults,
      request: args.request,
      threadStatus: "created",
    });
    scheduleGeneratedThreadTitle(deps, {
      request: args.request,
      threadId: thread.id,
    });
    return thread;
  }

  if (existing.status === "provisioning") {
    const thread = await createThreadInEnvironment(deps, {
      environment: existing,
      projectDefaults: args.projectDefaults,
      request: args.request,
      threadStatus: "provisioning",
    });
    scheduleGeneratedThreadTitle(deps, {
      request: args.request,
      threadId: thread.id,
    });
    return thread;
  }

  throw new ApiError(
    409,
    "invalid_request",
    `Workspace path is already attached to an environment in ${existing.status} state`,
  );
}

async function startQueuedThreadIfNeeded(
  deps: ThreadCreateDeps,
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
    permissionEscalation: resolvePermissionEscalation({
      thread: args.thread,
      initiator: args.request.type === "manager" ? "system" : "user",
    }),
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
  });
}

async function createSandboxHostThread(
  deps: ThreadCreateDeps,
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
          key: "sandbox-started",
          text: "Preparing sandbox",
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

  const managedMetadata = await resolveManagedThreadMetadata(deps, {
    environmentId: environment.id,
    request: args.request,
    threadId: thread.id,
  });

  const command = buildEnvironmentProvisionCommand({
    branchName: buildManagedBranchName({
      branchSlug: managedMetadata.branchSlug,
      threadId: thread.id,
    }),
    environmentId: environment.id,
    hostId,
    initiator: { threadId: thread.id, eventSequence: managedMetadata.eventSequence },
    sourcePath: args.cloneSource.repoUrl,
    targetPath: resolveManagedTargetPath({
      dataDir: SANDBOX_DATA_DIR,
      environmentId: environment.id,
      sourcePath: args.cloneSource.repoUrl,
    }),
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
  await advanceEnvironmentProvisioning(deps, {
    environmentId: environment.id,
  });

  return getThreadSafe(deps, thread.id);
}

export async function createThreadFromRequest(
  deps: ThreadCreateDeps,
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
      const thread = await createThreadInEnvironment(deps, {
        environment,
        projectDefaults: executionDefaults,
        request,
        threadStatus: "provisioning",
      });
      scheduleGeneratedThreadTitle(deps, {
        request,
        threadId: thread.id,
      });
      return thread;
    }

    if (environment.status === "ready") {
      if (!environment.path) {
        throw new ApiError(409, "invalid_request", "Environment is not ready");
      }
      const thread = await createThreadInEnvironment(deps, {
        environment,
        projectDefaults: executionDefaults,
        request,
        threadStatus: "created",
      });
      scheduleGeneratedThreadTitle(deps, {
        request,
        threadId: thread.id,
      });
      return thread;
    }
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  const hostId = resolvedEnvironment.hostId;
  const workspace = resolvedEnvironment.workspace;
  const managedSource: LocalPathProjectSource | null =
    workspace.type === "unmanaged" ? null : resolvedEnvironment.localSource;
  const unmanagedPath =
    workspace.type === "unmanaged" ? resolvedEnvironment.unmanagedPath : null;
  const hostSession = await ensureHostSessionReadyForWork(deps, {
    hostId,
  });

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

  const provisioningEntries: ProvisioningTranscriptEntry[] = workspace.type === "unmanaged"
    ? [
        {
          type: "step",
          key: "workspace-started",
          text: "Preparing workspace",
          status: "started",
        },
      ]
    : [];
  const provisionEventSequence = appendThreadProvisioningEvent(deps, {
    threadId: thread.id,
    environmentId: environment.id,
    status: "active",
    entries: provisioningEntries,
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
      const managedMetadata = await resolveManagedThreadMetadata(deps, {
        environmentId: environment.id,
        request,
        threadId: thread.id,
      });
      provisionCommand = buildEnvironmentProvisionCommand({
        environmentId: environment.id,
        hostId,
        initiator: { threadId: thread.id, eventSequence: managedMetadata.eventSequence },
        workspaceProvisionType: workspace.type,
        sourcePath: managedSource.path,
        targetPath: resolveManagedTargetPath({
          dataDir: hostSession.dataDir,
          environmentId: environment.id,
          sourcePath: managedSource.path,
        }),
        branchName: buildManagedBranchName({
          branchSlug: managedMetadata.branchSlug,
          threadId: thread.id,
        }),
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
  await advanceEnvironmentProvisioning(deps, {
    environmentId: environment.id,
  });
  rememberProjectExecutionDefaultsForCreate(deps, {
    execution,
    request,
  });

  if (workspace.type === "unmanaged") {
    scheduleGeneratedThreadTitle(deps, {
      request,
      threadId: thread.id,
    });
  }
  return getThreadSafe(deps, thread.id);
}

export async function ensureProjectSourceEnvironment(
  deps: Pick<
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "machineAuth"
    | "sandboxEnv"
    | "sandboxRegistry"
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
    request: buildDirectEnvironmentProvisionRequest(command),
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
