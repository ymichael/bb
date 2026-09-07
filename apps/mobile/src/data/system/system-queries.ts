import type { ProviderInfo } from "@bb/domain";
import { BbHttpError } from "@bb/sdk/browser";
import type {
  SystemConfigResponse,
  SystemExecutionOptionsResponse,
  SystemVersionResponse,
} from "@bb/server-contract";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useProfileClient } from "@/app-shell/ProfilesProvider";
import {
  SYSTEM_EXECUTION_OPTIONS_QUERY_KEY,
  systemConfigQueryKey,
  systemExecutionOptionsQueryKey,
  systemProvidersQueryKey,
  systemVersionQueryKey,
} from "@/lib/query/query-keys";
import { isTransientReadError } from "@/lib/query/query-client";
import { SERVER_SESSION_QUERY_POLICY } from "../shared/query-policies";
import { useSystemRealtimeSubscription } from "../shared/use-realtime-subscription";

interface QueryOptions {
  enabled?: boolean;
}

export function useSystemConfig(options?: QueryOptions) {
  const { sdk } = useProfileClient();
  const enabled = options?.enabled ?? true;
  useSystemRealtimeSubscription({ enabled });
  return useQuery<SystemConfigResponse>({
    queryKey: systemConfigQueryKey(),
    queryFn: ({ signal }) => sdk.system.config({ signal }),
    enabled,
    staleTime: 60_000,
  });
}

export function useSystemVersion(options?: QueryOptions) {
  const { sdk } = useProfileClient();
  return useQuery<SystemVersionResponse>({
    queryKey: systemVersionQueryKey(),
    queryFn: ({ signal }) => sdk.system.version({ signal }),
    enabled: options?.enabled ?? true,
    ...SERVER_SESSION_QUERY_POLICY,
  });
}

export function useSystemProviders(options?: QueryOptions) {
  const { sdk } = useProfileClient();
  const enabled = options?.enabled ?? true;
  useSystemRealtimeSubscription({ enabled });
  return useQuery<ProviderInfo[]>({
    queryKey: systemProvidersQueryKey(),
    queryFn: ({ signal }) => sdk.providers.list({ signal }),
    enabled,
    staleTime: 60_000,
  });
}

export type ExecutionOptionsRouting =
  | { environmentId: string; hostId?: undefined }
  | { environmentId?: undefined; hostId: string }
  | { environmentId?: undefined; hostId?: undefined };

export type UseSystemExecutionOptionsArgs = ExecutionOptionsRouting & {
  enabled?: boolean;
  providerId?: string;
};

const EXECUTION_OPTIONS_RETRY_DELAY_MS = 250;

function shouldRetryExecutionOptions(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= 1) return false;
  if (error instanceof BbHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return isTransientReadError(error);
}

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

export function useSystemExecutionOptions(
  args: UseSystemExecutionOptionsArgs = {},
) {
  const { sdk } = useProfileClient();
  const environmentId = args.environmentId ?? null;
  const hostId = args.hostId ?? null;
  const providerId = args.providerId ?? null;
  const enabled = args.enabled ?? true;
  useSystemRealtimeSubscription({ enabled });

  return useQuery<SystemExecutionOptionsResponse>({
    queryKey: systemExecutionOptionsQueryKey({
      environmentId,
      hostId,
      providerId,
    }),
    queryFn: ({ signal }) =>
      sdk.system.executionOptions({
        environmentId: args.environmentId,
        hostId: args.hostId,
        providerId: args.providerId,
        signal,
      }),
    enabled,
    staleTime: 60_000,
    retry: shouldRetryExecutionOptions,
    retryDelay: EXECUTION_OPTIONS_RETRY_DELAY_MS,
    placeholderData: (previousData, previousQuery) => {
      if (
        previousData === undefined ||
        !isSameExecutionOptionsRoute(
          previousQuery?.queryKey,
          environmentId,
          hostId,
        )
      ) {
        return undefined;
      }
      return {
        providers: previousData.providers,
        models: [],
        selectedOnlyModels: [],
        permissionCeiling: previousData.permissionCeiling,
        modelLoadError: null,
      };
    },
  });
}
