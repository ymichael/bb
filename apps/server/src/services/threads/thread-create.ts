import {
  deleteThread,
  getEnvironment,
  getProjectSourceByHost,
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
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
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
import { resolveThreadEnvironmentPlacement } from "./thread-environment-placement.js";
import {
  buildProviderThreadExecutionDefaults,
  resolveCreateThreadEnvironment,
} from "./thread-default-policy.js";
import { assertValidParentThread } from "./thread-parent.js";
import {
  type ThreadCreateServiceRequestInput,
  type ThreadCreateServiceRequest,
} from "./thread-create-request.js";
import { deriveTitleFallback } from "./title-generation.js";
import type { ThreadProvisionEnvironmentIntent } from "./thread-provisioning-context.js";
import { resolveSystemProviderModels } from "../system/execution-options.js";
import { getEnvironmentProvider } from "../plugins/plugin-environment-provider-registry.js";

type ThreadCreateDeps = LoggedPendingInteractionWorkSessionDeps;

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
  hostId: string | null;
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
  if (args.hostId === null) {
    throw new ApiError(
      400,
      "model_required",
      "Pick a model: this environment provider has no machine yet to list a default from, and the project has no remembered one.",
    );
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
    childHostId: string | null;
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
  if (sourceEnvironment !== null && args.childHostId === null) {
    throw new ApiError(
      400,
      "invalid_request",
      `Fork environment must name the source thread's host (${sourceEnvironment.hostId})`,
    );
  }
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

function projectCheckoutPathOnHost(
  deps: Pick<AppDeps, "db">,
  projectId: string,
  hostId: string,
): string | undefined {
  const source = getProjectSourceByHost(deps.db, projectId, hostId);
  return source?.type === "local_path" ? source.path : undefined;
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
    if (
      request.environment.type !== "reuse" &&
      request.environment.type !== "provider" &&
      request.environment.type !== "project-default" &&
      !(
        request.environment.type === "host" &&
        request.environment.workspace.type === "unmanaged" &&
        request.environment.workspace.path === null
      ) &&
      !personalWorkspace
    ) {
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
  const requestInput = { ...rawRequestInput };
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
  const requestedEnvironment = await resolveCreateThreadEnvironment(deps, {
    parentThread:
      forkSourceEnvironmentId !== undefined
        ? null
        : (sourceThread ?? parentThread),
    projectId: requestInput.projectId,
    requestedEnvironment: requestInput.environment,
  });
  if (
    requestedEnvironment.type === "provider" &&
    getEnvironmentProvider(requestedEnvironment.environmentProviderId) ===
      undefined
  ) {
    throw new ApiError(400, "invalid_request", "unknown environment provider");
  }
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
    environment: requestedEnvironment,
    providerId,
    titleFallback: deriveTitleFallback(requestInput.input),
  };
  const resolvedEnvironment =
    requestedEnvironment.type === "provider"
      ? null
      : resolveStableThreadRequestEnvironment(deps, {
          allowUnmanagedPersonalProjectReuseEnvironmentId:
            forkSourceEnvironmentId,
          environment: requestedEnvironment,
          projectId: request.projectId,
        });
  const childHostId =
    resolvedEnvironment !== null
      ? childHostIdForResolvedEnvironment(resolvedEnvironment)
      : request.environment.type === "provider"
        ? request.environment.machine.type === "existing"
          ? request.environment.machine.hostId
          : null
        : null;
  assertForkSourceHost(deps, {
    childHostId,
    originKind: request.originKind ?? null,
    sourceThread,
  });
  if (childHostId !== null) {
    await ensureHostSessionReadyForWork(deps, { hostId: childHostId });
  }
  const modelCatalogCwd =
    resolvedEnvironment !== null
      ? modelCatalogCwdForResolvedEnvironment(resolvedEnvironment)
      : request.environment.type === "provider" &&
          request.environment.machine.type === "existing"
        ? projectCheckoutPathOnHost(
            deps,
            request.projectId,
            request.environment.machine.hostId,
          )
        : undefined;
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

  const { environmentId, environmentIntent } =
    await resolveThreadEnvironmentPlacement(deps, {
      ...(forkSourceEnvironmentId !== undefined
        ? {
            allowUnmanagedPersonalProjectReuseEnvironmentId:
              forkSourceEnvironmentId,
          }
        : {}),
      projectId: request.projectId,
      requestedEnvironment: request.environment,
    });

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
