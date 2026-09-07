import { getProjectExecutionDefaults, getThread } from "@bb/db";
import type {
  CallerExecutionInputSource,
  PermissionMode,
  ProjectExecutionDefaults,
  ReasoningLevel,
  ResolvedThreadExecutionOptions,
  ServiceTier,
  ThreadExecutionSource,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import {
  clampPermissionModeToHost,
  isHostPermissionCeilingConflictError,
  resolveEnvironmentHostId,
} from "../hosts/permission-ceiling.js";
import {
  DEFAULT_REASONING_LEVEL,
  DEFAULT_SERVICE_TIER,
  resolveThreadExecutionPermissionMode,
} from "./thread-default-policy.js";
import { getLastExecutionOptions } from "./thread-events.js";
import { getSupportedReasoningLevelsForProvider } from "./thread-reasoning-policy.js";

interface ExecutionPlanFieldInput<TValue> {
  source: CallerExecutionInputSource;
  value: TValue;
}

interface ExistingThreadExecutionInput {
  model?: ExecutionPlanFieldInput<string>;
  permissionMode?: ExecutionPlanFieldInput<PermissionMode>;
  reasoningLevel?: ExecutionPlanFieldInput<ReasoningLevel>;
  serviceTier?: ExecutionPlanFieldInput<ServiceTier>;
}

export interface ExistingThreadExecutionInputRequest {
  model?: string;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  executionInputSources?: ExistingThreadExecutionInputRequestSources;
}

interface ExistingThreadExecutionInputRequestSources {
  model?: CallerExecutionInputSource;
  permissionMode?: CallerExecutionInputSource;
  reasoningLevel?: CallerExecutionInputSource;
  serviceTier?: CallerExecutionInputSource;
}

interface ResolveExistingThreadExecutionPlanArgs {
  executionSource: ThreadExecutionSource;
  hostId?: string | null;
  input: ExistingThreadExecutionInput;
  projectDefaults?: ProjectExecutionDefaults | null;
  threadId: string;
}

interface ExistingThreadExecutionPlan {
  resolvedExecution: ResolvedThreadExecutionOptions;
}

export function resolveExistingThreadPermissionMode(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  threadId: string,
): PermissionMode {
  const thread = getThread(deps.db, threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  const projectDefaults = getProjectExecutionDefaults(deps.db, {
    projectId: thread.projectId,
  });
  const projectExecution =
    projectDefaults?.providerId === thread.providerId ? projectDefaults : null;
  const parentThread =
    thread.parentThreadId !== null
      ? getThread(deps.db, thread.parentThreadId)
      : null;
  const lastExecutionPermissionMode = getLastExecutionOptions(
    deps,
    thread.id,
  )?.permissionMode;
  const permissionMode = clampPermissionModeToHost(deps, {
    hostId: resolveEnvironmentHostId(deps, thread.environmentId),
    permissionMode: resolveThreadExecutionPermissionMode(
      deps.providerRegistry,
      {
        lastExecutionPermissionMode,
        parentThread,
        parentThreadExecutionPermissionMode:
          parentThread !== null
            ? getLastExecutionOptions(deps, parentThread.id)?.permissionMode
            : undefined,
        projectExecutionPermissionMode: projectExecution?.permissionMode,
        thread,
      },
    ),
    providerId: thread.providerId,
  });
  validateProviderPermissionMode(
    deps.providerRegistry,
    thread.providerId,
    permissionMode,
  );
  return permissionMode;
}

function createMissingThreadExecutionModelError(threadId: string): ApiError {
  return new ApiError(
    500,
    "internal_error",
    `Thread ${threadId} has no stored execution model`,
  );
}

class ProviderCapabilityValidationError extends ApiError {}

function isMissingThreadExecutionModelError(
  error: unknown,
  threadId: string,
): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === "internal_error" &&
    error.body.message === `Thread ${threadId} has no stored execution model`
  );
}

function isProviderCapabilityValidationError(
  error: unknown,
): error is ProviderCapabilityValidationError {
  return error instanceof ProviderCapabilityValidationError;
}

function hasExecutionInput(input: ExistingThreadExecutionInput): boolean {
  return (
    input.model !== undefined ||
    input.permissionMode !== undefined ||
    input.reasoningLevel !== undefined ||
    input.serviceTier !== undefined
  );
}

function toRequestInputField<TValue>(
  value: TValue | undefined,
  source: CallerExecutionInputSource | undefined,
): ExecutionPlanFieldInput<TValue> | undefined {
  if (value === undefined || source === undefined) {
    return undefined;
  }
  return { source, value };
}

function resolveRequestInputSource(
  sources: ExistingThreadExecutionInputRequestSources | undefined,
  field: keyof ExistingThreadExecutionInputRequestSources,
): CallerExecutionInputSource | undefined {
  if (sources === undefined) {
    return "explicit";
  }
  return sources[field];
}

export function buildExistingThreadExecutionInput(
  request: ExistingThreadExecutionInputRequest,
): ExistingThreadExecutionInput {
  const sources = request.executionInputSources;
  const model = toRequestInputField(
    request.model,
    resolveRequestInputSource(sources, "model"),
  );
  const serviceTier = toRequestInputField(
    request.serviceTier,
    resolveRequestInputSource(sources, "serviceTier"),
  );
  const reasoningLevel = toRequestInputField(
    request.reasoningLevel,
    resolveRequestInputSource(sources, "reasoningLevel"),
  );
  const permissionMode = toRequestInputField(
    request.permissionMode,
    resolveRequestInputSource(sources, "permissionMode"),
  );
  return {
    ...(model ? { model } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
}

function validateProviderPermissionMode(
  registry: ProviderRegistryService,
  providerId: string,
  permissionMode: PermissionMode,
): void {
  const supported = registry.getSupportedPermissionModes(providerId);
  if (!supported || supported.includes(permissionMode)) {
    return;
  }

  throw new ProviderCapabilityValidationError(
    400,
    "invalid_request",
    `Provider ${providerId} only supports ${supported.join(", ")} permission mode.`,
  );
}

function validateProviderReasoningLevel(
  registry: ProviderRegistryService,
  providerId: string,
  reasoningLevel: ReasoningLevel,
): void {
  const supportedLevels = getSupportedReasoningLevelsForProvider(
    registry,
    providerId,
  );
  if (
    supportedLevels.length === 0 ||
    supportedLevels.includes(reasoningLevel)
  ) {
    return;
  }

  throw new ProviderCapabilityValidationError(
    400,
    "invalid_request",
    `Provider ${providerId} does not support ${reasoningLevel} reasoning level. Supported reasoning levels: ${supportedLevels.join(", ")}.`,
  );
}

function resolveRequiredField<TValue>(
  candidates: readonly (TValue | undefined)[],
): TValue | null {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return null;
}

function resolveFieldWithDefault<TValue>(
  candidates: readonly (TValue | undefined)[],
  defaultValue: TValue,
): TValue {
  return resolveRequiredField(candidates) ?? defaultValue;
}

export async function resolveExistingThreadExecutionPlan(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: ResolveExistingThreadExecutionPlanArgs,
): Promise<ExistingThreadExecutionPlan> {
  const lastExecution = getLastExecutionOptions(deps, args.threadId);
  const thread = getThread(deps.db, args.threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  const rawProjectExecution =
    args.projectDefaults === undefined
      ? getProjectExecutionDefaults(deps.db, {
          projectId: thread.projectId,
        })
      : args.projectDefaults;
  const projectExecution =
    rawProjectExecution?.providerId === thread.providerId
      ? rawProjectExecution
      : null;
  const parentThread =
    thread.parentThreadId !== null
      ? getThread(deps.db, thread.parentThreadId)
      : null;
  const parentExecution =
    parentThread !== null
      ? getLastExecutionOptions(deps, parentThread.id)
      : null;
  const model = resolveRequiredField<string>([
    args.input.model?.value,
    thread.modelOverride ?? undefined,
    lastExecution?.model,
    projectExecution?.model,
  ]);
  if (!model) {
    throw createMissingThreadExecutionModelError(args.threadId);
  }

  const permissionMode = clampPermissionModeToHost(deps, {
    hostId:
      args.hostId === undefined
        ? resolveEnvironmentHostId(deps, thread.environmentId)
        : args.hostId,
    permissionMode: resolveThreadExecutionPermissionMode(
      deps.providerRegistry,
      {
        requestedPermissionMode: args.input.permissionMode?.value,
        lastExecutionPermissionMode: lastExecution?.permissionMode,
        parentThread,
        parentThreadExecutionPermissionMode: parentExecution?.permissionMode,
        projectExecutionPermissionMode: projectExecution?.permissionMode,
        thread,
      },
    ),
    providerId: thread.providerId,
  });
  validateProviderPermissionMode(
    deps.providerRegistry,
    thread.providerId,
    permissionMode,
  );

  const reasoningLevel = resolveFieldWithDefault<ReasoningLevel>(
    [
      args.input.reasoningLevel?.value,
      thread.reasoningLevelOverride ?? undefined,
      lastExecution?.reasoningLevel,
      projectExecution?.reasoningLevel,
    ],
    DEFAULT_REASONING_LEVEL,
  );
  validateProviderReasoningLevel(
    deps.providerRegistry,
    thread.providerId,
    reasoningLevel,
  );

  const serviceTier = resolveFieldWithDefault<ServiceTier>(
    [
      args.input.serviceTier?.value,
      lastExecution?.serviceTier,
      projectExecution?.serviceTier,
    ],
    DEFAULT_SERVICE_TIER,
  );

  const resolvedExecution = {
    model,
    permissionMode,
    reasoningLevel,
    serviceTier,
    source: args.executionSource,
  };
  return {
    resolvedExecution,
  };
}

export async function tryResolveExistingThreadExecutionPlan(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: ResolveExistingThreadExecutionPlanArgs,
): Promise<ExistingThreadExecutionPlan | null> {
  try {
    return await resolveExistingThreadExecutionPlan(deps, args);
  } catch (error) {
    if (isMissingThreadExecutionModelError(error, args.threadId)) {
      return null;
    }
    if (
      !hasExecutionInput(args.input) &&
      (isProviderCapabilityValidationError(error) ||
        isHostPermissionCeilingConflictError(error))
    ) {
      return null;
    }
    throw error;
  }
}
