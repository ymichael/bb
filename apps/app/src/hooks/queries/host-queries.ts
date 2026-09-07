import { useMemo } from "react";
import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import type { Host } from "@bb/domain";
import type { HostDirectoryListing } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { useHostListRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  hostCloneDefaultPathQueryKey,
  hostDirectoryQueryKey,
  hostsQueryKey,
} from "./query-keys";
import type { QueryOptions } from "./query-helpers";

export function useHosts(options?: QueryOptions) {
  const enabled = options?.enabled ?? true;
  useHostListRealtimeSubscription({ enabled });

  return useQuery<Host[]>({
    queryKey: hostsQueryKey(),
    queryFn: ({ signal }) => sdk.hosts.list({ signal }),
    enabled,
    staleTime: 60_000,
  });
}

export function selectPrimaryHost(
  hosts: readonly Host[] | undefined,
  primaryHostId: string | null,
): Host | null {
  if (!hosts || hosts.length === 0) return null;
  if (primaryHostId !== null) {
    return hosts.find((host) => host.id === primaryHostId) ?? null;
  }
  return hosts.find((host) => host.status === "connected") ?? hosts[0] ?? null;
}

export function usePrimaryHost(options?: QueryOptions): Host | null {
  const { data: hosts } = useHosts(options);
  const primaryHostId = useSystemConfig(options).data?.primaryHostId ?? null;
  return useMemo(
    () => selectPrimaryHost(hosts, primaryHostId),
    [hosts, primaryHostId],
  );
}

export function useHostCloneDefaultPath(
  hostId: string | null,
  projectId: string | null,
  options?: QueryOptions,
) {
  const enabled = options?.enabled ?? true;
  return useQuery<string>({
    queryKey: hostCloneDefaultPathQueryKey(hostId, projectId),
    queryFn:
      enabled && hostId !== null && projectId !== null
        ? async ({ signal }) =>
            (await sdk.hosts.cloneDefaultPath({ hostId, projectId, signal }))
              .path
        : skipToken,
    staleTime: 60_000,
  });
}

export function useHostDirectory(hostId: string | null, path: string | null) {
  return useQuery<HostDirectoryListing>({
    queryKey: hostDirectoryQueryKey(hostId, path),
    queryFn: ({ signal }) =>
      sdk.hosts.directory({
        hostId: hostId as string,
        ...(path ? { path } : {}),
        signal,
      }),
    enabled: hostId != null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
