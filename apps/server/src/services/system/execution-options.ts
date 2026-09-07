import type {
  SystemExecutionOptionsModelLoadErrorCode,
  SystemExecutionOptionsModelLoadError,
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
  SystemProvidersQuery,
} from "@bb/server-contract";
import { type CustomProviderModel } from "@bb/config/bb-app-managed-config";
import {
  providerModelCatalogDependsOnWorkspace,
  reasoningEffortsForLevels,
  type AvailableModel,
  type ProviderInfo,
} from "@bb/domain";
import { getAppSettings } from "@bb/db";
import { type HostDaemonRetryableOnlineRpcCommand } from "@bb/host-daemon-contract";
import type { ProviderModelListMemoValue } from "../../lifecycle-dedupers.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { getHostPermissionCeiling } from "../hosts/permission-ceiling.js";
import { requireEnvironment } from "../lib/entity-lookup.js";
import { createProviderListingBudget } from "../providers/native-roots.js";
import type {
  ProviderHealthCacheKey,
  ProviderRegistryService,
} from "../providers/provider-registry.js";
import { getSupportedReasoningLevelsForProvider } from "../threads/thread-reasoning-policy.js";
import { resolveSystemLookupHostId } from "./host-lookup.js";
import {
  requireBridgeLaunchForProviderId,
  resolveBridgeLaunchForProviderId,
} from "./provider-bridge-launch.js";
import { mapProviderMaintenanceRequests } from "./provider-maintenance-concurrency.js";

type SystemExecutionOptionsRequest = SystemExecutionOptionsQuery;

interface BuildModelLoadErrorArgs {
  error: ApiError;
  provider: ProviderInfo;
}

interface ResolveSystemProviderModelsArgs {
  cwd?: string;
  hostId: string;
  providerId: string;
}

interface ExpectedFallbackErrorLogFields {
  errorCode: string;
  errorDetails?: unknown;
  errorMessage: string;
  errorRetryable?: boolean;
  errorStatus: number;
}

type ModelListResult = Pick<
  SystemExecutionOptionsResponse,
  "modelLoadError" | "models" | "selectedOnlyModels"
>;

function unavailableProviderModelResult(providerId: string): ModelListResult {
  return {
    models: [],
    selectedOnlyModels: [],
    modelLoadError: { providerId, code: "provider_unavailable" },
  };
}

interface AppendCustomModelsArgs {
  customModels: CustomProviderModel[];
  models: AvailableModel[];
  providerId: string;
  selectedOnlyModels: AvailableModel[];
}

type AppendCustomModelsResult = Pick<
  SystemExecutionOptionsResponse,
  "models" | "selectedOnlyModels"
>;

type ProviderCapabilityFilter =
  | NonNullable<SystemProvidersQuery["capability"]>
  | "installation";
type ListSystemProviderInfosRequest = Omit<
  SystemProvidersQuery,
  "capability"
> & {
  capability?: ProviderCapabilityFilter;
};

interface ResolveSystemProviderInfosPlanResult {
  hostId: string | null;
  hostLookupError: ApiError | null;
  providersPromise: Promise<ProviderInfo[]>;
}

function providerMatchesCapability(
  provider: ProviderInfo,
  capability: ProviderCapabilityFilter | undefined,
): boolean {
  switch (capability) {
    case "installation":
      return provider.maintenance.installation;
    case "usage":
      return provider.maintenance.usage;
    case undefined:
      return true;
  }
}

function listConfiguredSystemProviderInfos(
  deps: Pick<LoggedWorkSessionDeps, "providerRegistry">,
  capability?: ProviderCapabilityFilter,
): ProviderInfo[] {
  return deps.providerRegistry
    .list()
    .filter(
      (entry) =>
        entry.visibility === "always" &&
        providerMatchesCapability(entry.info, capability),
    )
    .map((entry) => entry.info);
}

function includeRequestedRegisteredProvider(
  deps: Pick<LoggedWorkSessionDeps, "providerRegistry">,
  providers: ProviderInfo[],
  providerId: string | undefined,
): ProviderInfo[] {
  if (
    providerId === undefined ||
    providers.some((provider) => provider.id === providerId)
  ) {
    return providers;
  }
  const registration = deps.providerRegistry.get(providerId);
  return registration === null ? providers : [...providers, registration.info];
}

function canOmitProviderDiscoveryForError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && (error.status === 502 || error.status === 504)
  );
}

function expectedFallbackErrorLogFields(
  error: ApiError,
): ExpectedFallbackErrorLogFields {
  const fields: ExpectedFallbackErrorLogFields = {
    errorCode: error.body.code,
    errorMessage: error.body.message,
    errorStatus: error.status,
  };
  if (error.body.details !== undefined) {
    fields.errorDetails = error.body.details;
  }
  if (error.body.retryable !== undefined) {
    fields.errorRetryable = error.body.retryable;
  }
  return fields;
}

async function listInstalledPluginProviderInfos(
  deps: LoggedWorkSessionDeps,
  hostId: string,
  capability?: ProviderCapabilityFilter,
): Promise<ProviderInfo[]> {
  const registrations = deps.providerRegistry
    .list()
    .filter(
      (registration) =>
        registration.visibility === "installed" &&
        providerMatchesCapability(registration.info, capability),
    );
  const budget = createProviderListingBudget();
  const results = await mapProviderMaintenanceRequests(
    registrations,
    async (registration) => {
      const bridgeLaunch = resolveBridgeLaunchForProviderId(
        deps,
        registration.info.id,
      );
      if (bridgeLaunch === null) return null;
      const cacheKey: ProviderHealthCacheKey = {
        hostId,
        providerId: registration.info.id,
      };
      const cached = deps.providerRegistry.lookupInstalled(cacheKey);
      try {
        const installed =
          cached ??
          (async () => {
            const result = await callHostRetryableOnlineRpc(deps, {
              hostId,
              timeoutMs: budget.remainingMs(),
              command: {
                type: "provider.health",
                providerId: registration.info.id,
                bridgeLaunch,
              },
            });
            return (
              result.supported && result.health.status !== "not_installed"
            );
          })();
        if (cached === undefined) {
          deps.providerRegistry.rememberInstalled(cacheKey, installed);
        }
        return (await installed) ? registration.info : null;
      } catch (error) {
        deps.providerRegistry.forgetInstalledKey(cacheKey);
        if (!canOmitProviderDiscoveryForError(error)) {
          throw error;
        }
        deps.logger.warn(
          {
            ...expectedFallbackErrorLogFields(error),
            hostId,
            providerId: registration.info.id,
          },
          "Failed to resolve installed-only provider status",
        );
        return null;
      }
    },
  );
  return results.filter(
    (provider): provider is ProviderInfo => provider !== null,
  );
}

async function listSystemProviderInfosForHost(
  deps: LoggedWorkSessionDeps,
  hostId: string,
  capability?: ProviderCapabilityFilter,
): Promise<ProviderInfo[]> {
  return listConfiguredSystemProviderInfos(deps, capability).concat(
    await listInstalledPluginProviderInfos(deps, hostId, capability),
  );
}

function resolveSystemProviderInfosPlan(
  deps: LoggedWorkSessionDeps,
  query: ListSystemProviderInfosRequest = {},
): ResolveSystemProviderInfosPlanResult {
  try {
    const hostId = resolveSystemLookupHostId(deps, query);
    return {
      hostId,
      hostLookupError: null,
      providersPromise: listSystemProviderInfosForHost(
        deps,
        hostId,
        query.capability,
      ),
    };
  } catch (error) {
    if (!canOmitProviderDiscoveryForError(error)) {
      throw error;
    }
    deps.logger.warn(
      expectedFallbackErrorLogFields(error),
      "Failed to resolve host for provider discovery",
    );
    return {
      hostId: null,
      hostLookupError: error,
      providersPromise: Promise.resolve(
        listConfiguredSystemProviderInfos(deps, query.capability),
      ),
    };
  }
}

export async function listSystemProviderInfos(
  deps: LoggedWorkSessionDeps,
  query: ListSystemProviderInfosRequest = {},
): Promise<ProviderInfo[]> {
  await deps.providerRegistry.whenRegistrationsSettled();
  return await resolveSystemProviderInfosPlan(deps, query).providersPromise;
}

export async function resolveSystemProviderModels(
  deps: LoggedWorkSessionDeps,
  args: ResolveSystemProviderModelsArgs,
): Promise<ModelListResult> {
  await deps.providerRegistry.whenProviderRegistered(args.providerId);
  const provider = includeRequestedRegisteredProvider(
    deps,
    listConfiguredSystemProviderInfos(deps),
    args.providerId,
  ).find((entry) => entry.id === args.providerId);
  if (provider === undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      `Unsupported provider ${args.providerId}`,
    );
  }

  const result = await loadSystemProviderModels(deps, {
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    hostId: args.hostId,
    provider,
  });
  const { models, selectedOnlyModels } = appendCustomModels(
    deps.providerRegistry,
    {
      customModels: deps.config.customModels,
      models: result.models,
      providerId: provider.id,
      selectedOnlyModels: result.selectedOnlyModels,
    },
  );
  return {
    models,
    selectedOnlyModels,
    modelLoadError: result.modelLoadError,
  };
}

function listVisibleCustomModels(
  deps: Pick<LoggedWorkSessionDeps, "config" | "db">,
): CustomProviderModel[] {
  if (deps.config.customModels.length === 0) {
    return deps.config.customModels;
  }
  return getAppSettings(deps.db).streamerMode ? [] : deps.config.customModels;
}

function buildCustomModel(
  registry: ProviderRegistryService,
  customModel: CustomProviderModel,
): AvailableModel {
  return {
    id: customModel.model,
    model: customModel.model,
    displayName: customModel.displayName ?? customModel.model,
    description: "Custom model from config.json",
    supportedReasoningEfforts: reasoningEffortsForLevels(
      getSupportedReasoningLevelsForProvider(registry, customModel.providerId),
    ),
    defaultReasoningEffort: "medium",
    isDefault: false,
  };
}

export function appendCustomModels(
  registry: ProviderRegistryService,
  {
    customModels,
    models,
    providerId,
    selectedOnlyModels,
  }: AppendCustomModelsArgs,
): AppendCustomModelsResult {
  const providerCustomModels = customModels.filter(
    (customModel) => customModel.providerId === providerId,
  );
  if (providerCustomModels.length === 0) {
    return { models, selectedOnlyModels };
  }

  const seenModelIds = new Set(models.map((model) => model.model));
  const promotedModelIds = new Set<string>();
  const appendedModels: AvailableModel[] = [];

  for (const customModel of providerCustomModels) {
    if (seenModelIds.has(customModel.model)) {
      continue;
    }
    seenModelIds.add(customModel.model);
    const selectedOnlyMatch = selectedOnlyModels.find(
      (model) => model.model === customModel.model,
    );
    if (selectedOnlyMatch !== undefined) {
      promotedModelIds.add(selectedOnlyMatch.model);
      appendedModels.push(selectedOnlyMatch);
      continue;
    }
    appendedModels.push(buildCustomModel(registry, customModel));
  }

  return {
    models: [...models, ...appendedModels],
    selectedOnlyModels:
      promotedModelIds.size === 0
        ? selectedOnlyModels
        : selectedOnlyModels.filter(
            (model) => !promotedModelIds.has(model.model),
          ),
  };
}

export async function resolveSystemExecutionOptions(
  deps: LoggedWorkSessionDeps,
  query: SystemExecutionOptionsRequest,
): Promise<SystemExecutionOptionsResponse> {
  if (query.providerId === undefined) {
    await deps.providerRegistry.whenRegistrationsSettled();
  } else {
    await deps.providerRegistry.whenProviderRegistered(query.providerId);
  }
  const cwd =
    query.environmentId === undefined
      ? undefined
      : (requireEnvironment(deps.db, query.environmentId).path ?? undefined);
  const { hostId, hostLookupError, providersPromise } =
    resolveSystemProviderInfosPlan(deps, query);
  const configuredRequestedProvider = query.providerId
    ? includeRequestedRegisteredProvider(
        deps,
        listConfiguredSystemProviderInfos(deps),
        query.providerId,
      ).find((provider) => provider.id === query.providerId)
    : undefined;
  const earlyModelResultPromise =
    hostId !== null && configuredRequestedProvider
      ? loadSystemProviderModels(deps, {
          ...(cwd !== undefined ? { cwd } : {}),
          hostId,
          provider: configuredRequestedProvider,
        })
      : null;
  let providers: ProviderInfo[];
  try {
    providers = await providersPromise;
  } catch (error) {
    await earlyModelResultPromise?.catch(() => undefined);
    throw error;
  }
  providers = includeRequestedRegisteredProvider(
    deps,
    providers,
    query.providerId,
  );
  const requestedProvider = query.providerId
    ? providers.find((provider) => provider.id === query.providerId)
    : undefined;
  const modelsProvider =
    earlyModelResultPromise !== null
      ? configuredRequestedProvider
      : (requestedProvider ?? providers[0]);

  const permissionCeiling = getHostPermissionCeiling(deps, hostId);

  if (!modelsProvider) {
    return {
      providers,
      permissionCeiling,
      models: [],
      selectedOnlyModels: [],
      modelLoadError: null,
    };
  }

  if (!modelsProvider.available) {
    return {
      providers,
      permissionCeiling,
      ...unavailableProviderModelResult(modelsProvider.id),
    };
  }

  if (hostId === null) {
    const { models, selectedOnlyModels } = appendCustomModels(
      deps.providerRegistry,
      {
        customModels: listVisibleCustomModels(deps),
        models: [],
        providerId: modelsProvider.id,
        selectedOnlyModels: [],
      },
    );
    return {
      providers,
      permissionCeiling,
      models,
      selectedOnlyModels,
      modelLoadError:
        hostLookupError === null
          ? null
          : buildModelLoadError({
              error: hostLookupError,
              provider: modelsProvider,
            }),
    };
  }

  const modelResult =
    earlyModelResultPromise !== null
      ? await earlyModelResultPromise
      : await loadSystemProviderModels(deps, {
          ...(cwd !== undefined ? { cwd } : {}),
          hostId,
          provider: modelsProvider,
        });

  const { models, selectedOnlyModels } = appendCustomModels(
    deps.providerRegistry,
    {
      customModels: listVisibleCustomModels(deps),
      models: modelResult.models,
      providerId: modelsProvider.id,
      selectedOnlyModels: modelResult.selectedOnlyModels,
    },
  );

  return {
    providers,
    permissionCeiling,
    models,
    selectedOnlyModels,
    modelLoadError: modelResult.modelLoadError,
  };
}

async function loadSystemProviderModels(
  deps: LoggedWorkSessionDeps,
  {
    cwd,
    hostId,
    provider,
  }: {
    cwd?: string;
    hostId: string;
    provider: ProviderInfo;
  },
): Promise<ModelListResult> {
  if (!provider.available) {
    return unavailableProviderModelResult(provider.id);
  }
  const bridgeLaunch = requireBridgeLaunchForProviderId(deps, provider.id);
  const command: ProviderListModelsCommand = {
    type: "provider.list_models",
    providerId: provider.id,
    ...(cwd !== undefined &&
    providerModelCatalogDependsOnWorkspace(
      provider.capabilities.modelCatalogScope,
    )
      ? { cwd }
      : {}),
    bridgeLaunch,
  };
  try {
    const { models, selectedOnlyModels } = await listProviderModelsMemoized(
      deps,
      { command, hostId },
    );
    return {
      models,
      selectedOnlyModels,
      modelLoadError: null,
    };
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      (error.status !== 502 && error.status !== 504)
    ) {
      throw error;
    }
    deps.logger.warn(
      {
        ...expectedFallbackErrorLogFields(error),
        hostId,
        providerId: provider.id,
      },
      "Failed to resolve provider models",
    );
    const modelLoadError = buildModelLoadError({
      error,
      provider,
    });
    return {
      models: listFallbackModelsForLoadError(deps, {
        code: modelLoadError.code,
        providerId: provider.id,
      }),
      selectedOnlyModels: [],
      modelLoadError,
    };
  }
}

type ProviderListModelsCommand = Extract<
  HostDaemonRetryableOnlineRpcCommand,
  { type: "provider.list_models" }
>;

async function listProviderModelsMemoized(
  deps: LoggedWorkSessionDeps,
  { command, hostId }: { command: ProviderListModelsCommand; hostId: string },
): Promise<ProviderModelListMemoValue> {
  const probe = (): Promise<ProviderModelListMemoValue> =>
    callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command,
    });
  const daemonSessionId = deps.hub.getDaemonSessionIdForHost(hostId);
  if (daemonSessionId === null) {
    return probe();
  }
  const memoKey = JSON.stringify([
    hostId,
    daemonSessionId,
    deps.providerRegistry.getRegistrationRevision(),
    command,
  ]);
  return deps.lifecycleDedupers.providerModelList.run(memoKey, probe);
}

function listFallbackModelsForLoadError(
  deps: Pick<LoggedWorkSessionDeps, "providerRegistry">,
  {
    code,
    providerId,
  }: {
    code: SystemExecutionOptionsModelLoadErrorCode;
    providerId: string;
  },
): AvailableModel[] {
  if (code !== "timeout" && code !== "failed") {
    return [];
  }
  const fallback = deps.providerRegistry.get(providerId)?.fallbackModels ?? [];
  return fallback.map((model) => ({
    ...model,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map(
      (effort) => ({ ...effort }),
    ),
  }));
}

function buildModelLoadError({
  error,
  provider,
}: BuildModelLoadErrorArgs): SystemExecutionOptionsModelLoadError {
  return {
    providerId: provider.id,
    code: toModelLoadErrorCode(error),
  };
}

function toModelLoadErrorCode(
  error: ApiError,
): SystemExecutionOptionsModelLoadErrorCode {
  if (error.body.code === "command_timeout") {
    return "timeout";
  }

  if (error.body.code === "missing_executable") {
    return "missing_executable";
  }

  if (error.body.code === "auth_required") {
    return "auth_required";
  }

  return "failed";
}
