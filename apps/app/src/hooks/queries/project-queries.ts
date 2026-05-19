import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProjectBranchesResponse,
  ProjectResponse,
  ProjectWithThreadsResponse,
  PromptHistoryResponse,
  WorkspaceFileListResponse,
  WorkspacePathListResponse,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import {
  projectFilesQueryKey,
  projectPathsQueryKey,
  projectPromptHistoryQueryKey,
  projectSourceBranchesQueryKey,
  projectsQueryKey,
  sidebarBootstrapQueryKey,
  threadListQueryKey,
} from "./query-keys";

interface QueryOptions {
  enabled?: boolean;
}

interface UseProjectPathSuggestionsArgs {
  projectId: string | undefined;
  query: string | null;
  limit?: number;
  environmentId: string | null;
  includeFiles: boolean;
  includeDirectories: boolean;
}

function requireProjectId(
  projectId: string | undefined,
  hookName: string,
): string {
  if (!projectId) {
    throw new Error(`${hookName}: projectId is required when query is enabled`);
  }

  return projectId;
}

export function useProjects(options?: QueryOptions) {
  return useQuery<ProjectResponse[]>({
    queryKey: projectsQueryKey(),
    queryFn: () => api.listProjects(),
    enabled: options?.enabled ?? true,
    refetchOnMount: false,
    staleTime: 30_000,
  });
}

function stripProjectThreads(
  project: ProjectWithThreadsResponse,
): ProjectResponse {
  const { threads, ...projectResponse } = project;
  return projectResponse;
}

export function useSidebarBootstrap() {
  const queryClient = useQueryClient();

  return useQuery<ProjectWithThreadsResponse[]>({
    queryKey: sidebarBootstrapQueryKey(),
    queryFn: async () => {
      const projects = await api.listProjectsWithThreads();
      queryClient.setQueryData(
        projectsQueryKey(),
        projects.map(stripProjectThreads),
      );
      for (const project of projects) {
        queryClient.setQueryData(
          threadListQueryKey({ projectId: project.id, archived: false }),
          project.threads,
        );
      }
      return projects;
    },
    staleTime: Infinity,
  });
}

export function useProjectSourceBranches(
  projectId: string | undefined,
  hostId: string | null,
  options?: QueryOptions,
) {
  const enabled =
    (options?.enabled ?? true) && Boolean(projectId) && Boolean(hostId);
  return useQuery<ProjectBranchesResponse>({
    queryKey: projectSourceBranchesQueryKey(projectId ?? "", hostId ?? ""),
    queryFn: () =>
      api.getProjectSourceBranches(
        requireProjectId(projectId, "useProjectSourceBranches"),
        hostId ?? "",
      ),
    enabled,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
}

export function useProjectPromptHistory(
  projectId: string | undefined,
  options?: QueryOptions,
) {
  return useQuery<PromptHistoryResponse>({
    queryKey: projectPromptHistoryQueryKey(projectId),
    queryFn: ({ signal }) =>
      api.listProjectPromptHistory(
        requireProjectId(projectId, "useProjectPromptHistory"),
        signal,
      ),
    enabled: (options?.enabled ?? true) && Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useProjectFileSuggestions(args: {
  projectId: string | undefined;
  query: string | null;
  limit?: number;
  environmentId: string | null;
}) {
  const { projectId, query, limit = 8, environmentId } = args;
  const trimmedQuery = query?.trim() ?? "";

  return useQuery<WorkspaceFileListResponse>({
    queryKey: projectFilesQueryKey(
      projectId,
      trimmedQuery,
      limit,
      environmentId,
    ),
    queryFn: () =>
      api.searchProjectFiles({
        projectId: projectId ?? "",
        query: trimmedQuery,
        limit,
        environmentId,
      }),
    enabled: Boolean(projectId) && trimmedQuery.length > 0,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
    // Hold the previous query's results while a new query is fetching so the
    // mention menu doesn't flicker through "loading" between every keystroke.
    placeholderData: (previousData) => previousData,
  });
}

export function useProjectPathSuggestions(args: UseProjectPathSuggestionsArgs) {
  const {
    projectId,
    query,
    limit = 8,
    environmentId,
    includeFiles,
    includeDirectories,
  } = args;
  const trimmedQuery = query?.trim() ?? "";

  return useQuery<WorkspacePathListResponse>({
    queryKey: projectPathsQueryKey(
      projectId,
      trimmedQuery,
      limit,
      environmentId,
      includeFiles,
      includeDirectories,
    ),
    queryFn: () =>
      api.searchProjectPaths({
        projectId: projectId ?? "",
        query: trimmedQuery,
        limit,
        environmentId,
        includeFiles,
        includeDirectories,
      }),
    enabled: Boolean(projectId) && trimmedQuery.length > 0,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
}
