import { useQuery } from "@tanstack/react-query";
import type { ProjectResponse, WorkspaceFileListResponse } from "@bb/server-contract";
import * as api from "@/lib/api";
import { projectFilesQueryKey, projectsQueryKey } from "./query-keys";

export function useProjects() {
  return useQuery<ProjectResponse[]>({
    queryKey: projectsQueryKey(),
    queryFn: () => api.listProjects(),
    staleTime: 30_000,
  });
}

export function useProjectFileSuggestions(
  projectId: string | undefined,
  query: string | null,
  limit: number = 8,
) {
  const trimmedQuery = query?.trim() ?? "";

  return useQuery<WorkspaceFileListResponse>({
    queryKey: projectFilesQueryKey(projectId, trimmedQuery, limit),
    queryFn: () => api.searchProjectFiles(projectId ?? "", trimmedQuery, limit),
    enabled: Boolean(projectId) && trimmedQuery.length > 0,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
