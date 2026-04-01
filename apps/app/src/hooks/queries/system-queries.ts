import { useQuery } from "@tanstack/react-query";
import type { Host, AvailableModel } from "@bb/domain";
import type { SystemProviderInfo } from "@bb/server-contract";
import * as api from "@/lib/api";
import { availableModelsQueryKey, hostsQueryKey, systemProvidersQueryKey } from "./query-keys";

export function useHosts() {
  return useQuery<Host[]>({
    queryKey: hostsQueryKey(),
    queryFn: () => api.listHosts(),
    staleTime: 30_000,
  });
}

export function useAvailableModels(providerId?: string) {
  return useQuery<AvailableModel[]>({
    queryKey: availableModelsQueryKey(providerId ?? null),
    queryFn: () => api.getAvailableModels(providerId),
    staleTime: 60_000,
  });
}

export function useSystemProviders() {
  return useQuery<SystemProviderInfo[]>({
    queryKey: systemProvidersQueryKey(),
    queryFn: () => api.listSystemProviders(),
    staleTime: 60_000,
  });
}
