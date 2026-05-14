import {
  keepPreviousData,
  useQuery,
} from "@tanstack/react-query";
import type { Host, SandboxBackendInfo } from "@bb/domain";
import type {
  CloudAuthAttemptResponse,
  CloudAuthSettingsResponse,
  GithubRepoInfo,
  SandboxEnvVarsResponse,
  SystemExecutionOptionsResponse,
  SystemProviderInfo,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import {
  cloudAuthAttemptQueryKey,
  cloudAuthSettingsQueryKey,
  type HostQueryId,
  hostQueryKey,
  hostsQueryKey,
  githubReposQueryKey,
  sandboxBackendsQueryKey,
  sandboxEnvVarsQueryKey,
  systemExecutionOptionsQueryKey,
  systemProvidersQueryKey,
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
    queryFn: () =>
      api.getCloudAuthAttempt(requireQueryId(attemptId, "useCloudAuthAttempt")),
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
