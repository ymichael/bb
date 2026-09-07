import {
  getProjectExecutionDefaults,
  getThreadExecutionOverride,
  setThreadExecutionOverride,
  type ThreadExecutionOverride,
} from "@bb/db";
import {
  reconcileReasoningLevel,
  type AvailableModel,
  type CallerExecutionInputSource,
  type ReasoningLevel,
  type Thread,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { resolveSystemExecutionOptions } from "../system/execution-options.js";
import { getLastExecutionOptions } from "./thread-events.js";
import { getSupportedReasoningLevelsForProvider } from "./thread-reasoning-policy.js";

interface ThreadExecutionOverridePatch {
  model?: string | null;
  reasoningLevel?: ReasoningLevel | null;
}

interface ResolveThreadExecutionOverrideUpdateArgs {
  existing: ThreadExecutionOverride;
  patch: ThreadExecutionOverridePatch;
  models: readonly AvailableModel[];
  providerId: string;
  fallbackModel: string | null;
}

interface ApplyThreadExecutionOverrideArgs {
  thread: Thread;
  patch: ThreadExecutionOverridePatch;
}

interface RecoverThreadModelOverrideArgs {
  model: string | undefined;
  modelSource: CallerExecutionInputSource | undefined;
  thread: Thread;
}

export function resolveThreadExecutionOverrideUpdate(
  registry: ProviderRegistryService,
  args: ResolveThreadExecutionOverrideUpdateArgs,
): ThreadExecutionOverride {
  const { existing, patch, models, providerId, fallbackModel } = args;

  const modelChanged = "model" in patch;
  let nextModel = existing.modelOverride;
  if (modelChanged) {
    if (patch.model === null || patch.model === undefined) {
      nextModel = null;
    } else {
      const target = models.find(
        (candidate) => candidate.model === patch.model,
      );
      if (!target) {
        throw new ApiError(
          400,
          "invalid_request",
          `Model "${patch.model}" is not available in this thread's ${providerId} model catalog. Choose a model offered by ${providerId}; changing providers requires starting a new thread.`,
        );
      }
      nextModel = patch.model;
    }
  }

  const effectiveModel = nextModel ?? fallbackModel;
  const effectiveModelEntry = effectiveModel
    ? models.find((candidate) => candidate.model === effectiveModel)
    : undefined;
  const supportedReasoning: readonly ReasoningLevel[] = effectiveModelEntry
    ? effectiveModelEntry.supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      )
    : getSupportedReasoningLevelsForProvider(registry, providerId);

  let nextReasoning = existing.reasoningLevelOverride;
  if ("reasoningLevel" in patch) {
    if (patch.reasoningLevel === null || patch.reasoningLevel === undefined) {
      nextReasoning = null;
    } else {
      if (
        supportedReasoning.length > 0 &&
        !supportedReasoning.includes(patch.reasoningLevel)
      ) {
        throw new ApiError(
          400,
          "invalid_request",
          `Reasoning level "${patch.reasoningLevel}" is not supported by ${
            effectiveModel
              ? `model "${effectiveModel}"`
              : `provider ${providerId}`
          }. Supported reasoning levels: ${supportedReasoning.join(", ")}.`,
        );
      }
      nextReasoning = patch.reasoningLevel;
    }
  } else if (
    nextReasoning !== null &&
    supportedReasoning.length > 0 &&
    !supportedReasoning.includes(nextReasoning)
  ) {
    nextReasoning = reconcileReasoningLevel(nextReasoning, supportedReasoning);
  }

  return { modelOverride: nextModel, reasoningLevelOverride: nextReasoning };
}

export async function applyThreadExecutionOverride(
  deps: LoggedWorkSessionDeps,
  args: ApplyThreadExecutionOverrideArgs,
): Promise<void> {
  const { thread, patch } = args;

  const models = await loadThreadProviderModels(deps, thread);
  const existing = getThreadExecutionOverride(deps.db, thread.id) ?? {
    modelOverride: null,
    reasoningLevelOverride: null,
  };

  const next = resolveThreadExecutionOverrideUpdate(deps.providerRegistry, {
    existing,
    patch,
    models,
    providerId: thread.providerId,
    fallbackModel: resolveFallbackModel(deps, thread),
  });

  setThreadExecutionOverride(deps.db, {
    threadId: thread.id,
    modelOverride: next.modelOverride,
    reasoningLevelOverride: next.reasoningLevelOverride,
  });
}

export async function recoverThreadModelOverride(
  deps: LoggedWorkSessionDeps,
  args: RecoverThreadModelOverrideArgs,
): Promise<void> {
  const existing = getThreadExecutionOverride(deps.db, args.thread.id);
  if (
    args.model === undefined ||
    args.modelSource !== "explicit" ||
    existing?.modelOverride === null ||
    existing?.modelOverride === undefined ||
    existing.modelOverride === args.model
  ) {
    return;
  }

  await applyThreadExecutionOverride(deps, {
    thread: args.thread,
    patch: { model: args.model },
  });
}

async function loadThreadProviderModels(
  deps: LoggedWorkSessionDeps,
  thread: Thread,
): Promise<readonly AvailableModel[]> {
  const result = await resolveSystemExecutionOptions(deps, {
    providerId: thread.providerId,
    ...(thread.environmentId !== null
      ? { environmentId: thread.environmentId }
      : {}),
  });
  if (result.modelLoadError !== null) {
    throw new ApiError(
      503,
      "model_catalog_unavailable",
      `Unable to load ${thread.providerId} models to validate the change. Try again once the host is connected.`,
    );
  }
  return [...result.models, ...result.selectedOnlyModels];
}

function resolveFallbackModel(
  deps: LoggedWorkSessionDeps,
  thread: Thread,
): string | null {
  const lastExecution = getLastExecutionOptions(deps, thread.id);
  if (lastExecution?.model) {
    return lastExecution.model;
  }
  const projectDefaults = getProjectExecutionDefaults(deps.db, {
    projectId: thread.projectId,
  });
  return projectDefaults?.model ?? null;
}
