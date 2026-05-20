import { useQuery } from "@tanstack/react-query";
import type { Host } from "@bb/domain";
import type {
  SystemExecutionOptionsResponse,
  SystemProviderInfo,
  SystemVersionResponse,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import {
  type HostQueryId,
  hostQueryKey,
  hostsQueryKey,
  systemExecutionOptionsQueryKey,
  systemProvidersQueryKey,
  systemVersionQueryKey,
} from "./query-keys";

export interface UseSystemExecutionOptionsArgs {
  enabled?: boolean;
  environmentId?: string;
  providerId?: string;
}

interface QueryOptions {
  enabled?: boolean;
}

function requireQueryId(id: HostQueryId, hookName: string): string {
  if (!id) {
    throw new Error(`${hookName}: hostId is required when query is enabled`);
  }

  return id;
}

export function useHosts(options?: QueryOptions) {
  return useQuery<Host[]>({
    queryKey: hostsQueryKey(),
    queryFn: () => api.listHosts(),
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useHost(hostId: HostQueryId, options?: QueryOptions) {
  return useQuery<Host>({
    queryKey: hostQueryKey(hostId),
    queryFn: () => api.getHost(requireQueryId(hostId, "useHost")),
    enabled: (options?.enabled ?? true) && Boolean(hostId),
    staleTime: 30_000,
  });
}

export function useSystemExecutionOptions(
  args: UseSystemExecutionOptionsArgs = {},
) {
  const environmentId = args.environmentId ?? null;
  const providerId = args.providerId ?? null;

  return useQuery<SystemExecutionOptionsResponse>({
    queryKey: systemExecutionOptionsQueryKey({ environmentId, providerId }),
    queryFn: () =>
      api.getSystemExecutionOptions({
        environmentId: args.environmentId,
        providerId: args.providerId,
      }),
    enabled: args.enabled ?? true,
    staleTime: 60_000,
  });
}

export function useSystemProviders(options?: QueryOptions) {
  return useQuery<SystemProviderInfo[]>({
    queryKey: systemProvidersQueryKey(),
    queryFn: () => api.listSystemProviders(),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  });
}

const SYSTEM_VERSION_STALE_TIME_MS = 60 * 60 * 1000;

export function useSystemVersion(options?: QueryOptions) {
  return useQuery<SystemVersionResponse>({
    queryKey: systemVersionQueryKey(),
    queryFn: () => api.getSystemVersion(),
    enabled: options?.enabled ?? true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: SYSTEM_VERSION_STALE_TIME_MS,
  });
}
