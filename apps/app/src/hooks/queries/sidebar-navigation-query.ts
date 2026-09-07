import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { apiClient } from "@/lib/api-server";
import { request, requestOptions } from "@/lib/api";
import {
  useEnvironmentListRealtimeSubscription,
  useHostListRealtimeSubscription,
  useProjectListRealtimeSubscription,
  useThreadListRealtimeSubscription,
} from "@/hooks/useRealtimeSubscription";
import type { QueryOptions } from "./query-helpers";
import { sidebarNavigationQueryKey } from "./query-keys";
import { REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY } from "./query-policies";
import {
  readCachedSidebarBootstrap,
  writeCachedSidebarBootstrap,
} from "@/lib/sidebar-bootstrap-cache";

function fetchSidebarNavigation(
  signal?: AbortSignal,
): Promise<SidebarBootstrapResponse> {
  return request<SidebarBootstrapResponse>(
    apiClient["sidebar-bootstrap"].$get(undefined, requestOptions(signal)),
  );
}

export function useSidebarNavigation(options?: QueryOptions) {
  const enabled = options?.enabled ?? true;
  useEnvironmentListRealtimeSubscription({ enabled });
  useHostListRealtimeSubscription({ enabled });
  useProjectListRealtimeSubscription({ enabled });
  useThreadListRealtimeSubscription({ enabled });

  return useQuery<SidebarBootstrapResponse>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: async ({ signal }) => {
      const response = await fetchSidebarNavigation(signal);
      writeCachedSidebarBootstrap(response);
      return response;
    },
    enabled,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
    placeholderData: () => readCachedSidebarBootstrap() ?? undefined,
  });
}

export function useProjectDisplayName(
  projectId: string | undefined,
): string | undefined {
  const { data } = useQuery<SidebarBootstrapResponse>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: ({ signal }) => fetchSidebarNavigation(signal),
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
    enabled: Boolean(projectId),
  });
  if (!data || !projectId) {
    return undefined;
  }
  if (projectId === PERSONAL_PROJECT_ID) {
    return data.personalProject.name;
  }
  return data.projects.find((project) => project.id === projectId)?.name;
}

interface SidebarNavigationThreadSelection<T> {
  data: T | undefined;
  isBootstrapPending: boolean;
}

export function useSidebarNavigationThreadSelection<T>(
  select: (threads: ThreadListEntry[]) => T,
): SidebarNavigationThreadSelection<T> {
  const selectFromNavigation = useCallback(
    (navigation: SidebarBootstrapResponse) =>
      select(listSidebarNavigationThreads(navigation)),
    [select],
  );
  const result = useQuery<SidebarBootstrapResponse, Error, T>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: ({ signal }) => fetchSidebarNavigation(signal),
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
    enabled: false,
    select: selectFromNavigation,
  });
  const data = result.data;
  return {
    data,
    isBootstrapPending: data === undefined && result.isFetching,
  };
}
