import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AvailableModel, Host, SandboxBackendInfo } from "@bb/domain";
import type {
  CloudAuthAttemptResponse,
  CloudAuthSettingsResponse,
  GithubRepoInfo,
  SandboxEnvVarsResponse,
  SystemProviderInfo,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import {
  availableModelsQueryKey,
  cloudAuthAttemptQueryKey,
  cloudAuthSettingsQueryKey,
  type HostQueryId,
  hostQueryKey,
  hostsQueryKey,
  githubReposQueryKey,
  sandboxBackendsQueryKey,
  sandboxEnvVarsQueryKey,
  systemProvidersQueryKey,
} from "./query-keys";

function requireQueryId(
  id: HostQueryId,
  hookName: string,
): string {
  if (!id) {
    throw new Error(`${hookName}: hostId is required when query is enabled`);
  }

  return id;
}

export function useHosts() {
  return useQuery<Host[]>({
    queryKey: hostsQueryKey(),
    queryFn: () => api.listHosts(),
    staleTime: 30_000,
  });
}

export function useHost(hostId: HostQueryId) {
  return useQuery<Host>({
    queryKey: hostQueryKey(hostId),
    queryFn: () => api.getHost(requireQueryId(hostId, "useHost")),
    enabled: Boolean(hostId),
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

export function useSandboxBackends(enabled: boolean) {
  return useQuery<SandboxBackendInfo[]>({
    queryKey: sandboxBackendsQueryKey(),
    queryFn: () => api.listSandboxBackends(),
    enabled,
    staleTime: 60_000,
  });
}

export function useCloudAuthSettings(enabled: boolean) {
  return useQuery<CloudAuthSettingsResponse>({
    queryKey: cloudAuthSettingsQueryKey(),
    queryFn: () => api.getCloudAuthSettings(),
    enabled,
    staleTime: 5_000,
  });
}

export function useCloudAuthAttempt(
  attemptId: string | null,
  enabled: boolean,
) {
  return useQuery<CloudAuthAttemptResponse>({
    queryKey: cloudAuthAttemptQueryKey(attemptId),
    queryFn: () => api.getCloudAuthAttempt(requireQueryId(attemptId, "useCloudAuthAttempt")),
    enabled: enabled && Boolean(attemptId),
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? 1_000 : false,
    staleTime: 0,
  });
}

export function useSandboxEnvVars(enabled: boolean) {
  return useQuery<SandboxEnvVarsResponse>({
    queryKey: sandboxEnvVarsQueryKey(),
    queryFn: () => api.listSandboxEnvVars(),
    enabled,
    staleTime: 5_000,
  });
}

export function useGithubRepos(enabled: boolean, q: string) {
  return useQuery<GithubRepoInfo[]>({
    queryKey: githubReposQueryKey(q),
    queryFn: () => api.listGithubRepos(q || undefined),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
