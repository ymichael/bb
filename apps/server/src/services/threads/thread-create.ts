import {
  deleteThread,
  findProjectEnvironmentByHostPath,
  getEnvironment,
  getThread,
} from "@bb/db";
import type {
  ProjectExecutionDefaults,
  Project,
  Thread,
  ThreadOriginKind,
  ThreadVisibility,
} from "@bb/domain";
import type {
  BaseBranchSpec,
  CreateThreadEnvironmentArgs,
  UnmanagedBranchSpec,
} from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import { unmanagedAttachRefusal } from "./workspace-path-claims.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { requireNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { throwEnvironmentNotReady } from "../lib/lifecycle-api-errors.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  copyForkSourceHistory,
  resolveThreadForkPoint,
  type ThreadForkPoint,
} from "./thread-fork-history.js";
import {
  rememberProjectExecutionDefaultsForCreate,
  resolveProjectExecutionDefaultsForCreate,
} from "./project-execution-defaults.js";
import { validatePromptAttachmentReferences } from "../projects/attachments.js";
import { resolvePluginMentionContextInputs } from "../plugins/plugin-mentions.js";
import {
  attemptDispatch,
  hostIdForEnvironmentIntent,
  type PendingThreadStartContext,
} from "./dispatch-attempt.js";
import { setThreadPendingStartContext } from "@bb/db";
import { emitPluginThreadDeleted } from "../plugins/plugin-thread-events.js";
import {
  createThreadRecord,
  getThreadSafe,
  requirePublicProjectForThreadCreate,
} from "./thread-create-helpers.js";
import {
  resolveStableThreadRequestEnvironment,
  type ResolvedStableThreadRequestEnvironment,
} from "./thread-request-eligibility.js";
import {
  buildProviderThreadExecutionDefaults,
  resolveCreateThreadEnvironment,
  resolveProjectDefaultThreadEnvironment,
} from "./thread-default-policy.js";
import { assertValidParentThread } from "./thread-parent.js";
import {
  type ThreadCreateServiceRequestInput,
  type ThreadCreateServiceRequest,
} from "./thread-create-request.js";
import { deriveTitleFallback } from "./title-generation.js";
import type { ThreadProvisionEnvironmentIntent } from "./thread-provisioning-context.js";
import { resolveManagedDefaultBaseBranchSpec } from "../projects/worktree-base-branch.js";
import { applyLoggedEnvironmentLifecycleEvent } from "../environments/lifecycle-outcome.js";
import { resolveSystemProviderModels } from "../system/execution-options.js";

type ThreadCreateDeps = LoggedPendingInteractionWorkSessionDeps;

interface ExistingUnmanagedEnvironmentIntentByHostPathArgs {
  branch: UnmanagedBranchSpec | undefined;
  hostId: string;
  path: string;
  request: ThreadCreateServiceRequest;
}

interface ExistingUnmanagedEnvironmentIntentResult {
  environmentId: string;
  intent:
    | Extract<ThreadProvisionEnvironmentIntent, { type: "reuse" }>
    | Extract<ThreadProvisionEnvironmentIntent, { type: "checkout-unmanaged" }>;
}

interface CreateProvisioningThreadArgs {
  environmentId: string | null;
  executionDefaults: Parameters<
    typeof buildExecutionOptions
  >[2]["projectDefaults"];
  fork: ThreadForkPoint | null;
  request: ThreadCreateServiceRequest;
  providerInput?: ThreadCreateServiceRequestInput["input"];
}

interface ResolveForkPointArgs {
  originKind: ThreadOriginKind | null;
  providerId: string;
  sourceSeqEnd: number | undefined;
  sourceThread: Thread | null;
}

interface ResolveCatalogExecutionDefaultsArgs {
  cwd?: string;
  executionDefaults: ProjectExecutionDefaults | null;
  hostId: string;
  providerId: string;
  requestedModel: string | null;
}

async function resolveCatalogExecutionDefaults(
  deps: ThreadCreateDeps,
  args: ResolveCatalogExecutionDefaultsArgs,
): Promise<ProjectExecutionDefaults | null> {
  if (args.executionDefaults !== null || args.requestedModel !== null) {
    return args.executionDefaults;
  }

  const catalog = await resolveSystemProviderModels(deps, {
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    hostId: args.hostId,
    providerId: args.providerId,
  });
  if (catalog.modelLoadError !== null) {
    throw new ApiError(
      503,
      "model_catalog_unavailable",
      `Unable to load ${args.providerId} models to resolve the default. Try again once the host is connected and the provider is ready.`,
      {
        details: catalog.modelLoadError,
        retryable: true,
      },
    );
  }
  const defaultModel =
    catalog.models.find((model) => model.isDefault) ?? catalog.models[0];
  if (defaultModel === undefined) {
    throw new ApiError(
      503,
      "model_catalog_unavailable",
      `The ${args.providerId} model catalog is empty, so no default model can be resolved.`,
      true,
    );
  }
  return buildProviderThreadExecutionDefaults(deps.providerRegistry, {
    providerId: args.providerId,
    model: defaultModel.model,
  });
}

function resolveForkPoint(
  deps: Pick<ThreadCreateDeps, "db" | "providerRegistry">,
  args: ResolveForkPointArgs,
): ThreadForkPoint | null {
  if (args.originKind === null || args.sourceThread === null) {
    return null;
  }
  if (!deps.providerRegistry.supportsFork(args.providerId)) {
    return null;
  }
  if (args.sourceThread.providerId !== args.providerId) {
    return null;
  }
  const sourceEnvironmentId = args.sourceThread.environmentId;
  if (sourceEnvironmentId === null) {
    return null;
  }
  const sourceEnvironment = getEnvironment(deps.db, sourceEnvironmentId);
  if (sourceEnvironment === null) {
    return null;
  }
  return resolveThreadForkPoint(deps, {
    sourceSeqEnd: args.sourceSeqEnd,
    sourceThread: args.sourceThread,
  });
}

function assertForkSourceHost(
  deps: Pick<ThreadCreateDeps, "db">,
  args: {
    childHostId: string;
    originKind: ThreadOriginKind | null;
    sourceThread: Thread | null;
  },
): void {
  if (args.originKind !== "fork" || args.sourceThread === null) {
    return;
  }
  const sourceEnvironment =
    args.sourceThread.environmentId === null
      ? null
      : getEnvironment(deps.db, args.sourceThread.environmentId);
  if (
    sourceEnvironment !== null &&
    sourceEnvironment.hostId !== args.childHostId
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `Fork environment must use the source thread's host (${sourceEnvironment.hostId}), not ${args.childHostId}`,
    );
  }
}

function childHostIdForResolvedEnvironment(
  resolvedEnvironment: ResolvedStableThreadRequestEnvironment,
): string {
  switch (resolvedEnvironment.type) {
    case "reuse":
      return resolvedEnvironment.environment.hostId;
    case "host":
      return resolvedEnvironment.hostId;
    case "personal":
      return resolvedEnvironment.hostId;
  }
}

function modelCatalogCwdForResolvedEnvironment(
  resolvedEnvironment: ResolvedStableThreadRequestEnvironment,
): string | undefined {
  switch (resolvedEnvironment.type) {
    case "reuse":
      return resolvedEnvironment.environment.path ?? undefined;
    case "host":
      return (
        resolvedEnvironment.unmanagedPath ??
        resolvedEnvironment.localSource?.path ??
        undefined
      );
    case "personal":
      return undefined;
  }
}

interface ResolveManagedBaseBranchForCreateArgs {
  baseBranch: BaseBranchSpec;
  hostId: string;
  sourcePath: string;
}

function requestUsesPersonalWorkspace(
  request: ThreadCreateServiceRequestInput,
): boolean {
  return (
    request.environment.type === "host" &&
    request.environment.workspace.type === "personal"
  );
}

function assertProjectWorkspaceCompatibility(
  project: Project,
  request: ThreadCreateServiceRequestInput,
): void {
  const personalWorkspace = requestUsesPersonalWorkspace(request);
  if (project.kind === "personal") {
    if (request.environment.type !== "reuse" && !personalWorkspace) {
      throw new ApiError(
        400,
        "invalid_request",
        "Personal project threads must use a personal workspace",
      );
    }
    return;
  }

  if (personalWorkspace) {
    throw new ApiError(
      400,
      "invalid_request",
      "Personal workspaces are only supported for the personal project",
    );
  }
}

function requireLiveSourceThread(
  deps: Pick<ThreadCreateDeps, "db">,
  args: {
    projectId: string;
    sourceThreadId: string;
  },
): Thread {
  const sourceThread = getThread(deps.db, args.sourceThreadId);
  if (sourceThread === null) {
    throw new ApiError(400, "invalid_request", "sourceThreadId not found");
  }
  if (sourceThread.projectId !== args.projectId) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceThreadId must belong to the same project",
    );
  }
  if (sourceThread.archivedAt !== null) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceThreadId must reference an unarchived thread",
    );
  }
  if (sourceThread.deletedAt !== null) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceThreadId must reference a non-deleted thread",
    );
  }
  return sourceThread;
}

async function resolveManagedBaseBranchForCreate(
  deps: ThreadCreateDeps,
  args: ResolveManagedBaseBranchForCreateArgs,
): Promise<BaseBranchSpec> {
  if (args.baseBranch.kind === "named") {
    return args.baseBranch;
  }

  try {
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.inspect_git_source",
        path: args.sourcePath,
        remoteRefresh: "background",
      },
    });
    return resolveManagedDefaultBaseBranchSpec(result);
  } catch (error) {
    deps.logger.warn(
      {
        hostId: args.hostId,
        sourcePath: args.sourcePath,
        ...runtimeErrorLogFields(deps.config, error),
      },
      "Failed to resolve smart worktree base branch; using requested base",
    );
    return args.baseBranch;
  }
}

interface AssertUnmanagedHostPathIsAttachableArgs {
  branch: UnmanagedBranchSpec | undefined;
  dataDir: string;
  hostId: string;
  path: string;
  projectId: string;
}

function assertUnmanagedHostPathIsAttachable(
  deps: ThreadCreateDeps,
  args: AssertUnmanagedHostPathIsAttachableArgs,
): void {
  const refusal = unmanagedAttachRefusal(deps.db, {
    checksOutBranch: args.branch !== undefined,
    dataDir: args.dataDir,
    hostId: args.hostId,
    path: args.path,
    projectId: args.projectId,
  });
  if (refusal) {
    throw new ApiError(409, "invalid_request", refusal.message);
  }
}

function existingUnmanagedEnvironmentIntentByHostPath(
  deps: ThreadCreateDeps,
  args: ExistingUnmanagedEnvironmentIntentByHostPathArgs,
): ExistingUnmanagedEnvironmentIntentResult | null {
  const existing = findProjectEnvironmentByHostPath(
    deps.db,
    args.request.projectId,
    args.hostId,
    args.path,
  );
  if (!existing) {
    return null;
  }

  if (!args.branch) {
    if (existing.status === "ready" || existing.status === "provisioning") {
      return {
        environmentId: existing.id,
        intent: {
          type: "reuse",
          environmentId: existing.id,
        },
      };
    }

    throw new ApiError(
      409,
      "invalid_request",
      `Workspace path is already attached to an environment in ${existing.status} state`,
    );
  }

  if (existing.status !== "ready" || !existing.path) {
    throw new ApiError(
      409,
      "invalid_request",
      `Cannot checkout branch while the workspace environment is in ${existing.status} state`,
    );
  }

  return {
    environmentId: existing.id,
    intent: {
      type: "checkout-unmanaged",
      environmentId: existing.id,
      hostId: args.hostId,
      path: args.path,
      branch: args.branch,
    },
  };
}

/**
 * Creates the thread row and hands its first message to the dispatch
 * checkpoint.
 *
 * This is the whole of thread creation's dispatch story now, and it replaced a
 * pair of near-identical functions — one that provisioned immediately and one
 * that queued the first turn — whose only real difference was
 * whether anything was allowed to run yet. That is a question the checkpoint
 * answers, so asking it here as well meant two code paths that had to be kept
 * in agreement about forks, execution defaults, telemetry and cleanup.
 *
 * The row inserts `pending`: created, with its provider resolved, and nothing
 * provisioned. Creation itself is unhooked — it is a cheap row — and admission
 * happens at the first message's attempt. A cleared attempt moves the thread
 * to `starting` and provisions with the message riding along; a queued one
 * leaves the thread exactly where it is, with the start context recorded so a
 * later drain (or a later server) can start it.
 */
async function createPendingThreadAndAttemptFirstDispatch(
  deps: ThreadCreateDeps,
  args: CreateProvisioningThreadArgs & {
    environmentIntent: ThreadProvisionEnvironmentIntent;
    sendAt: number | undefined;
  },
) {
  const thread = createThreadRecord(deps, {
    request: args.request,
    environmentId: args.environmentId,
  });
  let execution: Awaited<ReturnType<typeof buildExecutionOptions>>;
  try {
    if (
      args.fork !== null &&
      args.fork.historyEndSequence !== null &&
      args.request.visibility === "visible"
    ) {
      copyForkSourceHistory(deps, {
        fork: thread,
        historyEndSequence: args.fork.historyEndSequence,
        sourceThreadId: args.fork.sourceThreadId,
      });
    }
    const executionPlanArgs = {
      projectDefaults: args.executionDefaults,
      hostId: hostIdForEnvironmentIntent(deps, args.environmentIntent),
      threadId: thread.id,
    };
    execution = await buildExecutionOptions(
      deps,
      args.request,
      executionPlanArgs,
    );

    const startContext: PendingThreadStartContext = {
      environmentIntent: args.environmentIntent,
      fork: args.fork?.descriptor ?? null,
      ...(args.providerInput !== undefined
        ? { providerInput: args.providerInput }
        : {}),
      startedOnBehalfOf: args.request.startedOnBehalfOf,
      titleProvided: Boolean(args.request.title),
    };
    // Recorded BEFORE the attempt, not after it queues: the attempt drives
    // provisioning off this stack when it clears, and a context written
    // afterwards would race that. Writing it unconditionally and clearing it
    // when the thread leaves `pending` keeps one owner for the field.
    setThreadPendingStartContext(deps.db, {
      threadId: thread.id,
      pendingStartContext: JSON.stringify(startContext),
    });

    await attemptDispatch(deps, {
      thread,
      payload: {
        input: args.request.input,
        mode: "start",
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        serviceTier: execution.serviceTier,
        permissionMode: execution.permissionMode,
        ...(args.request.executionInputSources !== undefined
          ? { executionInputSources: args.request.executionInputSources }
          : {}),
        ...(args.sendAt !== undefined ? { sendAt: args.sendAt } : {}),
      },
      source: { kind: "inline" },
      queuePayload: { kind: "inline" },
      startContext,
      executionDefaults: executionPlanArgs,
      origin: args.request.origin,
      originPluginId: args.request.originPluginId ?? null,
      startedOnBehalfOf: args.request.startedOnBehalfOf,
      trigger: "user",
    });
  } catch (error) {
    emitPluginThreadDeleted({
      ...thread,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });
    deleteThread(deps.db, deps.hub, thread.id);
    throw error;
  }
  rememberProjectExecutionDefaultsForCreate(deps, {
    execution,
    request: args.request,
  });
  return getThreadSafe(deps, thread.id);
}

interface ResolveCreateThreadVisibilityArgs {
  parentThread: Pick<Thread, "visibility"> | null;
  requestedVisibility: ThreadVisibility | undefined;
}

function resolveCreateThreadVisibility(
  args: ResolveCreateThreadVisibilityArgs,
): ThreadVisibility {
  if (args.requestedVisibility !== undefined) {
    return args.requestedVisibility;
  }
  return args.parentThread?.visibility ?? "visible";
}

export async function createThreadFromRequest(
  deps: ThreadCreateDeps,
  rawRequestInput: ThreadCreateServiceRequestInput,
  options: {
    providerInput?: ThreadCreateServiceRequestInput["input"];
    forkSourceEnvironmentId?: string;
  } = {},
) {
  const project = requirePublicProjectForThreadCreate(
    deps,
    rawRequestInput.projectId,
  );
  if (rawRequestInput.origin === "plugin") {
    if (rawRequestInput.originPluginId === undefined) {
      throw new ApiError(
        400,
        "invalid_request",
        'originPluginId is required when origin is "plugin"',
      );
    }
  } else if (rawRequestInput.originPluginId !== undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      'originPluginId requires origin "plugin"',
    );
  }
  const requestInput = {
    ...rawRequestInput,
    environment:
      rawRequestInput.environment.type === "project-default"
        ? await resolveProjectDefaultThreadEnvironment(deps, {
            projectId: rawRequestInput.projectId,
          })
        : rawRequestInput.environment,
  };
  const pluginMentionContext = await resolvePluginMentionContextInputs(
    requestInput.input,
  );
  if (pluginMentionContext.length > 0) {
    requestInput.input = [...requestInput.input, ...pluginMentionContext];
  }
  assertProjectWorkspaceCompatibility(project, requestInput);
  const originKind = requestInput.originKind ?? null;
  const sourceThreadId =
    requestInput.sourceThreadId ??
    (originKind !== null ? requestInput.parentThreadId : undefined);
  const hierarchyParentThreadId =
    originKind === null ? requestInput.parentThreadId : undefined;
  const parentThread = hierarchyParentThreadId
    ? assertValidParentThread(deps, {
        parentThreadId: hierarchyParentThreadId,
      })
    : null;
  if (originKind === null && sourceThreadId !== undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceThreadId requires an originKind",
    );
  }
  if (originKind === null && requestInput.sourceSeqEnd !== undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceSeqEnd requires an originKind",
    );
  }
  const sourceThread = sourceThreadId
    ? requireLiveSourceThread(deps, {
        projectId: requestInput.projectId,
        sourceThreadId,
      })
    : null;
  if (originKind !== null && sourceThread !== null) {
    assertValidParentThread(deps, {
      parentThreadId: sourceThread.id,
    });
  }
  if (originKind !== null && sourceThread === null) {
    throw new ApiError(
      400,
      "invalid_request",
      "originKind requires a sourceThreadId",
    );
  }
  const forkSourceEnvironmentId =
    options.forkSourceEnvironmentId ??
    (originKind === "fork" &&
    sourceThread !== null &&
    sourceThread.environmentId !== null &&
    requestInput.environment.type === "reuse" &&
    requestInput.environment.environmentId === sourceThread.environmentId
      ? sourceThread.environmentId
      : undefined);
  if (requestInput.startedOnBehalfOf !== null) {
    const senderThread = sourceThread ?? parentThread;
    if (senderThread === null) {
      throw new ApiError(
        400,
        "invalid_request",
        "startedOnBehalfOf requires a sourceThreadId or parentThreadId",
      );
    }
    if (requestInput.startedOnBehalfOf.senderThreadId !== senderThread.id) {
      throw new ApiError(
        400,
        "invalid_request",
        sourceThread === null
          ? "startedOnBehalfOf.senderThreadId must match parentThreadId"
          : "startedOnBehalfOf.senderThreadId must match sourceThreadId",
      );
    }
    if (originKind === null) {
      throw new ApiError(
        400,
        "invalid_request",
        "startedOnBehalfOf requires an originKind",
      );
    }
  }
  await validatePromptAttachmentReferences({
    dataDir: deps.config.dataDir,
    input: requestInput.input,
    projectId: requestInput.projectId,
  });
  await deps.providerRegistry.whenRegistrationsSettled();
  let { executionDefaults, providerId, requestedModel } =
    resolveProjectExecutionDefaultsForCreate(deps, {
      executionInputSources: requestInput.executionInputSources,
      model: requestInput.model,
      projectId: requestInput.projectId,
      providerId: requestInput.providerId,
    });
  // No hook pass here. Creation is UNHOOKED — a thread row is cheap, costs no
  // worktree, no setup script and no host resources — and admission happens at
  // the first message's dispatch attempt, where a plugin sees the thread it is
  // deciding about and can amend its provider and environment while neither is
  // settled yet. That collapses what used to be a `thread.create` pass plus a
  // second re-evaluation pass when it was let through into one checkpoint that
  // runs the same way every time.
  const {
    originKind: _requestedOriginKind,
    parentThreadId: _requestedParentThreadId,
    sourceThreadId: _requestedSourceThreadId,
    ...requestRest
  } = requestInput;
  const request: ThreadCreateServiceRequest = {
    ...requestRest,
    ...(hierarchyParentThreadId
      ? { parentThreadId: hierarchyParentThreadId }
      : {}),
    ...(sourceThread ? { sourceThreadId: sourceThread.id } : {}),
    originKind,
    visibility: resolveCreateThreadVisibility({
      parentThread,
      requestedVisibility: requestInput.visibility,
    }),
    environment: resolveCreateThreadEnvironment({
      parentThread:
        forkSourceEnvironmentId !== undefined
          ? null
          : (sourceThread ?? parentThread),
      projectId: requestInput.projectId,
      requestedEnvironment: requestInput.environment,
    }),
    providerId,
    titleFallback: deriveTitleFallback(requestInput.input),
  };
  const resolvedEnvironment = resolveStableThreadRequestEnvironment(deps, {
    allowUnmanagedPersonalProjectReuseEnvironmentId: forkSourceEnvironmentId,
    environment: request.environment,
    projectId: request.projectId,
  });
  const childHostId = childHostIdForResolvedEnvironment(resolvedEnvironment);
  assertForkSourceHost(deps, {
    childHostId,
    originKind: request.originKind ?? null,
    sourceThread,
  });
  const hostDataDir = (
    await ensureHostSessionReadyForWork(deps, { hostId: childHostId })
  ).dataDir;
  const modelCatalogCwd =
    modelCatalogCwdForResolvedEnvironment(resolvedEnvironment);
  const resolvedExecutionDefaults = await resolveCatalogExecutionDefaults(
    deps,
    {
      ...(modelCatalogCwd !== undefined ? { cwd: modelCatalogCwd } : {}),
      executionDefaults,
      hostId: childHostId,
      providerId,
      requestedModel,
    },
  );

  /**
   * Resolves where a thread will run: the workspace-path claim checks, the
   * existing-unmanaged-environment reuse, and the managed base branch, in one
   * place so there is one policy.
   */
  async function resolveEnvironmentPlacement(
    requestedEnvironment: CreateThreadEnvironmentArgs,
  ): Promise<{
    environmentId: string | null;
    environmentIntent: ThreadProvisionEnvironmentIntent;
  }> {
    const resolvedEnvironment = resolveStableThreadRequestEnvironment(deps, {
      allowUnmanagedPersonalProjectReuseEnvironmentId: forkSourceEnvironmentId,
      environment:
        requestedEnvironment.type === "project-default"
          ? await resolveProjectDefaultThreadEnvironment(deps, {
              projectId: request.projectId,
            })
          : requestedEnvironment,
      projectId: request.projectId,
    });
    let environmentId: string | null = null;
    let environmentIntent: ThreadProvisionEnvironmentIntent;
    switch (resolvedEnvironment.type) {
      case "reuse": {
        let environment = resolvedEnvironment.environment;
        if (environment.status === "retiring") {
          applyLoggedEnvironmentLifecycleEvent(deps, {
            environmentId: environment.id,
            event: { type: "retire.cancelled" },
          });
          environment = getEnvironment(deps.db, environment.id) ?? environment;
        }
        if (
          environment.status !== "ready" &&
          environment.status !== "provisioning"
        ) {
          throwEnvironmentNotReady(environment);
        }
        if (environment.status === "ready" && !environment.path) {
          throwEnvironmentNotReady(environment);
        }
        if (environment.status === "provisioning") {
          requireNonDestroyedHostWithStatus(deps, environment.hostId);
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
          assertUnmanagedHostPathIsAttachable(deps, {
            branch: workspace.branch,
            dataDir: hostDataDir,
            hostId,
            path: resolvedEnvironment.unmanagedPath,
            projectId: request.projectId,
          });
          const existingIntent = existingUnmanagedEnvironmentIntentByHostPath(
            deps,
            {
              branch: workspace.branch,
              hostId,
              path: resolvedEnvironment.unmanagedPath,
              request,
            },
          );
          environmentIntent = existingIntent?.intent ?? {
            type: "direct-unmanaged",
            hostId,
            path: resolvedEnvironment.unmanagedPath,
            ...(workspace.branch ? { branch: workspace.branch } : {}),
          };
          if (existingIntent) {
            environmentId = existingIntent.environmentId;
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
          baseBranch: await resolveManagedBaseBranchForCreate(deps, {
            baseBranch: workspace.baseBranch,
            hostId,
            sourcePath: managedSource.path,
          }),
          workspaceProvisionType: workspace.type,
        };
        break;
      }
      case "personal": {
        environmentIntent = {
          type: "direct-personal",
          hostId: resolvedEnvironment.hostId,
          workspaceProvisionType: "personal",
        };
        break;
      }
    }
    return { environmentId, environmentIntent };
  }

  const { environmentId, environmentIntent } =
    await resolveEnvironmentPlacement(request.environment);

  const fork = resolveForkPoint(deps, {
    originKind: request.originKind ?? null,
    providerId: request.providerId,
    sourceSeqEnd: request.sourceSeqEnd,
    sourceThread,
  });

  if (request.originKind !== null && fork === null) {
    throw new ApiError(
      400,
      "fork_source_session_unavailable",
      "Cannot fork: source has no active session to clone",
    );
  }

  const createArgs = {
    environmentId,
    environmentIntent,
    executionDefaults: resolvedExecutionDefaults,
    fork,
    ...(options.providerInput !== undefined
      ? { providerInput: options.providerInput }
      : {}),
    request,
  };
  const thread = await createPendingThreadAndAttemptFirstDispatch(deps, {
    ...createArgs,
    sendAt: request.sendAt,
  });
  deps.telemetry.capture({
    name: "thread_created",
    properties: {
      is_child_thread: parentThread !== null,
      provider: request.providerId,
    },
  });
  if (
    (request.startedOnBehalfOf?.initiator ?? "user") === "user" &&
    request.input.length > 0
  ) {
    deps.telemetry.capture({
      name: "user_message_sent",
      properties: {
        is_child_thread: parentThread !== null,
        message_source: "thread_create",
        provider: request.providerId,
      },
    });
  }
  return thread;
}
