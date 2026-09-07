import {
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type {
  PermissionMode,
  ProviderInfo,
  ProviderModelCatalogScope,
} from "@bb/domain";
import { SYSTEM_EXECUTION_OPTIONS_QUERY_KEY } from "@/hooks/queries/query-keys";
import { permissionModeValues } from "@bb/domain";
import { toRecord } from "@bb/core-ui";
import type {
  SystemCliSkillsStatusResponse,
  SystemExecutionOptionsResponse,
  SystemProvidersQuery,
  SystemProviderStatesResponse,
  SystemVersionResponse,
} from "@bb/server-contract";
import type {
  ProviderCliStatusResponse,
  ProviderUsage,
  ProviderUsageResponse,
} from "@bb/host-daemon-contract";
import { BbHttpError, sdk } from "@/lib/sdk";
import {
  modelCatalogCacheKey,
  readCachedModelCatalog,
  writeCachedModelCatalog,
} from "@/lib/model-catalog-cache";
import {
  providerListCacheKey,
  readCachedProviderList,
  writeCachedProviderList,
} from "@/lib/provider-list-cache";
import { useSystemRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import {
  allSystemExecutionOptionsQueryKeyPrefix,
  allSystemProvidersQueryKeyPrefix,
  hostProviderCliStatusQueryKey,
  systemCliSkillsQueryKey,
  systemConfigQueryKey,
  systemExecutionOptionsQueryKey,
  systemProvidersQueryKey,
  systemProviderStatesQueryKey,
  systemUsageLimitsQueryKey,
  systemVersionQueryKey,
} from "./query-keys";
import { requireEnabledQueryArg, type QueryOptions } from "./query-helpers";
import {
  FOCUS_OWNED_LIVE_QUERY_POLICY,
  SERVER_SESSION_QUERY_POLICY,
  SESSION_STATIC_QUERY_POLICY,
} from "./query-policies";

interface UseSystemExecutionOptionsArgs {
  enabled?: boolean;
  environmentId?: string;
  hostId?: string;
  providerId?: string;
}

interface UseSystemProviderStatesOptions extends QueryOptions {
  environmentId?: string;
  hostId?: string;
  poll?: boolean;
}

type SystemProviderRoutingArgs =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

type UseSystemProvidersArgs = QueryOptions &
  SystemProviderRoutingArgs &
  Pick<SystemProvidersQuery, "capability">;

type UseSystemProviderInfoArgs = UseSystemProvidersArgs & {
  providerId?: string;
};

const SYSTEM_EXECUTION_OPTIONS_RETRY_DELAY_MS = 250;
const SYSTEM_EXECUTION_OPTIONS_RETRY_COUNT = 1;
const PLACEHOLDER_PERMISSION_CEILING: PermissionMode = permissionModeValues[0];

function isSameExecutionOptionsRoute(
  previousQueryKey: QueryKey | undefined,
  environmentId: string | null,
  hostId: string | null,
): boolean {
  return (
    previousQueryKey?.[0] === SYSTEM_EXECUTION_OPTIONS_QUERY_KEY &&
    previousQueryKey[1] === environmentId &&
    previousQueryKey[2] === hostId
  );
}

function resolveExecutionOptionsPlaceholder({
  previousData,
  previousQueryKey,
  environmentId,
  hostId,
  providerId,
  catalogCacheKey,
  providersCacheKey,
}: {
  previousData: SystemExecutionOptionsResponse | undefined;
  previousQueryKey: QueryKey | undefined;
  environmentId: string | null;
  hostId: string | null;
  providerId: string | null;
  catalogCacheKey: string;
  providersCacheKey: string;
}): SystemExecutionOptionsResponse | undefined {
  const previousProviders = isSameExecutionOptionsRoute(
    previousQueryKey,
    environmentId,
    hostId,
  )
    ? previousData?.providers
    : undefined;
  const cached = readCachedModelCatalog(catalogCacheKey);
  const remembered = readCachedProviderList(providersCacheKey);
  const providers =
    previousProviders ??
    (remembered !== null && remembered.length > 0 ? remembered : null);
  if (
    providers === null ||
    (providerId !== null &&
      !providers.some((provider) => provider.id === providerId))
  ) {
    return undefined;
  }
  return {
    providers,
    models: cached?.models ?? [],
    selectedOnlyModels: cached?.selectedOnlyModels ?? [],
    permissionCeiling: PLACEHOLDER_PERMISSION_CEILING,
    modelLoadError: null,
  };
}

export function findCachedProviderInfo(
  queryClient: import("@tanstack/react-query").QueryClient,
  providerId: string,
): ProviderInfo | null {
  const entries = queryClient.getQueriesData<SystemExecutionOptionsResponse>({
    queryKey: [SYSTEM_EXECUTION_OPTIONS_QUERY_KEY],
  });
  for (const [, data] of entries) {
    const match = data?.providers.find((info) => info.id === providerId);
    if (match !== undefined) {
      return match;
    }
  }
  return null;
}

function isAbortLikeError(error: unknown): boolean {
  return toRecord(error)?.name === "AbortError";
}

function shouldRetrySystemExecutionOptions(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= SYSTEM_EXECUTION_OPTIONS_RETRY_COUNT) {
    return false;
  }

  if (isAbortLikeError(error)) {
    return false;
  }

  if (error instanceof BbHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  return true;
}

export function useKnownProviderModelCatalogScope(
  providerId: string,
): ProviderModelCatalogScope | undefined {
  const queryClient = useQueryClient();
  if (providerId.length === 0) {
    return undefined;
  }
  const scopeIn = (
    providers: readonly ProviderInfo[] | undefined,
  ): ProviderModelCatalogScope | undefined =>
    providers?.find((provider) => provider.id === providerId)?.capabilities
      .modelCatalogScope;
  for (const [, options] of queryClient.getQueriesData<{
    providers: ProviderInfo[];
  }>({ queryKey: allSystemExecutionOptionsQueryKeyPrefix() })) {
    const scope = scopeIn(options?.providers);
    if (scope !== undefined) {
      return scope;
    }
  }
  for (const [, providers] of queryClient.getQueriesData<ProviderInfo[]>({
    queryKey: allSystemProvidersQueryKeyPrefix(),
  })) {
    const scope = scopeIn(providers);
    if (scope !== undefined) {
      return scope;
    }
  }
  return undefined;
}

export function useSystemProviders(args: UseSystemProvidersArgs = {}) {
  const capability = args.capability ?? null;
  const environmentId = args.environmentId ?? null;
  const hostId = args.hostId ?? null;
  const enabled = args.enabled ?? true;
  useSystemRealtimeSubscription({ enabled });
  const providersCacheKey = providerListCacheKey({ environmentId, hostId });
  return useQuery<ProviderInfo[]>({
    queryKey: systemProvidersQueryKey({ capability, environmentId, hostId }),
    queryFn: async ({ signal }) => {
      const capabilityFilter =
        args.capability === undefined ? {} : { capability: args.capability };
      const providers = await (args.environmentId !== undefined
        ? sdk.providers.list({
            ...capabilityFilter,
            environmentId: args.environmentId,
            signal,
          })
        : args.hostId !== undefined
          ? sdk.providers.list({
              ...capabilityFilter,
              hostId: args.hostId,
              signal,
            })
          : sdk.providers.list({ ...capabilityFilter, signal }));
      if (capability === null) {
        writeCachedProviderList(providersCacheKey, providers);
      }
      return providers;
    },
    enabled,
    staleTime: 60_000,
    placeholderData: () => {
      const remembered = readCachedProviderList(providersCacheKey);
      if (remembered === null) return undefined;
      const eligible =
        capability === null
          ? remembered
          : remembered.filter(
              (provider) => provider.maintenance[capability],
            );
      return eligible.length > 0 ? eligible : undefined;
    },
  });
}

export function useSystemProviderInfo({
  providerId,
  ...args
}: UseSystemProviderInfoArgs): ProviderInfo | null {
  const queryClient = useQueryClient();
  const providersQuery = useSystemProviders({
    ...args,
    enabled: (args.enabled ?? true) && providerId !== undefined,
  });
  return (
    providersQuery.data?.find((provider) => provider.id === providerId) ??
    (providerId === undefined
      ? null
      : findCachedProviderInfo(queryClient, providerId))
  );
}

export function useSystemExecutionOptions(
  args: UseSystemExecutionOptionsArgs = {},
) {
  const environmentId = args.environmentId ?? null;
  const hostId = args.hostId ?? null;
  const providerId = args.providerId ?? null;
  const enabled = args.enabled ?? true;
  useSystemRealtimeSubscription({ enabled });
  const providersCacheKey = providerListCacheKey({ environmentId, hostId });
  const catalogCacheKey = modelCatalogCacheKey({
    environmentId,
    hostId,
    providerId,
  });
  return useQuery<SystemExecutionOptionsResponse>({
    queryKey: systemExecutionOptionsQueryKey({
      environmentId,
      hostId,
      providerId,
    }),
    queryFn: async ({ signal }) => {
      const response = await sdk.system.executionOptions({
        environmentId: args.environmentId,
        hostId: args.hostId,
        providerId: args.providerId,
        signal,
      });
      writeCachedProviderList(providersCacheKey, response.providers);
      if (response.modelLoadError === null) {
        const catalog = {
          models: response.models,
          selectedOnlyModels: response.selectedOnlyModels,
        };
        writeCachedModelCatalog(catalogCacheKey, catalog);
      }
      return response;
    },
    enabled,
    staleTime: 60_000,
    retry: shouldRetrySystemExecutionOptions,
    retryDelay: SYSTEM_EXECUTION_OPTIONS_RETRY_DELAY_MS,
    placeholderData: (previousData, previousQuery) =>
      resolveExecutionOptionsPlaceholder({
        previousData,
        previousQueryKey: previousQuery?.queryKey,
        environmentId,
        hostId,
        providerId,
        catalogCacheKey,
        providersCacheKey,
      }),
  });
}

export function systemConfigQueryOptions() {
  return queryOptions({
    queryKey: systemConfigQueryKey(),
    queryFn: ({ signal }) => sdk.system.config({ signal }),
    staleTime: 60_000,
  });
}

export function useSystemConfig(options?: QueryOptions) {
  const enabled = options?.enabled ?? true;
  useSystemRealtimeSubscription({ enabled });

  return useQuery({
    ...systemConfigQueryOptions(),
    enabled,
  });
}

export function useCliSkillsStatus(options?: QueryOptions) {
  return useQuery<SystemCliSkillsStatusResponse>({
    queryKey: systemCliSkillsQueryKey(),
    queryFn: ({ signal }) => sdk.system.cliSkillsStatus({ signal }),
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useSystemVersion(options?: QueryOptions) {
  return useQuery<SystemVersionResponse>({
    queryKey: systemVersionQueryKey(),
    queryFn: ({ signal }) => sdk.system.version({ signal }),
    enabled: options?.enabled ?? true,
    ...SERVER_SESSION_QUERY_POLICY,
  });
}

interface UseHostProviderCliStatusArgs {
  hostId: string | null;
  enabled?: boolean;
}

export function useHostProviderCliStatus({
  hostId,
  enabled,
}: UseHostProviderCliStatusArgs) {
  return useQuery<ProviderCliStatusResponse>({
    queryKey: hostProviderCliStatusQueryKey(hostId),
    queryFn: ({ signal }) =>
      sdk.hosts.providerCliStatus({
        hostId: requireEnabledQueryArg({
          value: hostId,
          hookName: "useHostProviderCliStatus",
          argName: "hostId",
        }),
        signal,
      }),
    enabled: (enabled ?? true) && hostId !== null,
    ...SESSION_STATIC_QUERY_POLICY,
  });
}

export function useSystemProviderStates(
  options: UseSystemProviderStatesOptions = {},
) {
  const environmentId = options.environmentId ?? null;
  const hostId = options.hostId ?? null;
  return useQuery<SystemProviderStatesResponse>({
    queryKey: systemProviderStatesQueryKey({ environmentId, hostId }),
    queryFn: ({ signal }) =>
      sdk.system.providerStates({
        environmentId: options.environmentId,
        hostId: options.hostId,
        signal,
      }),
    enabled: options.enabled ?? true,
    ...(options.poll === false
      ? { staleTime: 60_000 }
      : { refetchInterval: 15_000 }),
  });
}

export interface ProviderUsageQueryState {
  isError: boolean;
  isLoading: boolean;
}

interface UseSystemProviderUsageLimitsArgs extends QueryOptions {
  hostId?: string;
  providerIds: readonly string[];
}

export function useSystemProviderUsageLimits(
  args: UseSystemProviderUsageLimitsArgs,
) {
  const hostId = args.hostId ?? null;
  const enabled = args.enabled ?? true;
  const queries = useQueries({
    queries: args.providerIds.map((providerId) => ({
      queryKey: systemUsageLimitsQueryKey(hostId, providerId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        sdk.system.usageLimits({
          ...(args.hostId === undefined ? {} : { hostId: args.hostId }),
          providerId,
          signal,
        }),
      enabled,
      ...FOCUS_OWNED_LIVE_QUERY_POLICY,
    })),
  });
  const usage: ProviderUsageResponse = {};
  const providerStates: Record<string, ProviderUsageQueryState> = {};

  args.providerIds.forEach((providerId, index) => {
    const query = queries[index];
    if (query === undefined) return;
    const providerUsage: ProviderUsage | undefined = query.data?.[providerId];
    if (providerUsage !== undefined) {
      usage[providerId] = providerUsage;
    }
    providerStates[providerId] = {
      isError: query.isError,
      isLoading: query.isLoading,
    };
  });

  return {
    isError: queries.some((query) => query.isError),
    isFetching: queries.some((query) => query.isFetching),
    isLoading: queries.some((query) => query.isLoading),
    providerStates,
    refetch: async () => {
      await Promise.all(queries.map((query) => query.refetch()));
    },
    usage,
  };
}
