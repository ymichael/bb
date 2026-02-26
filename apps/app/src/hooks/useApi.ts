import {
  useQuery,
  useMutation,
  useQueryClient,
  useQueries,
} from "@tanstack/react-query";
import type {
  Project,
  Thread,
  ThreadEvent,
  CreateProjectRequest,
  UpdateProjectRequest,
  SpawnThreadRequest,
  TellThreadRequest,
  SystemStatus,
  SystemEnvironmentInfo,
  SystemProviderInfo,
  AvailableModel,
  ProjectFileSuggestion,
  ThreadExecutionOptions,
} from "@beanbag/agent-core";
import * as api from "../lib/api";

// --- Projects ---

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateProjectRequest) => api.createProject(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...req }: { id: string } & UpdateProjectRequest) =>
      api.updateProject(id, req),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["projectFiles", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    },
  });
}

export function useProjectFileSuggestions(
  projectId: string | undefined,
  query: string | null,
  limit: number = 8,
) {
  const trimmedQuery = query?.trim() ?? "";
  return useQuery<ProjectFileSuggestion[]>({
    queryKey: ["projectFiles", projectId, trimmedQuery, limit],
    queryFn: () => api.searchProjectFiles(projectId ?? "", trimmedQuery, limit),
    enabled: Boolean(projectId) && trimmedQuery.length > 0,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

// --- Query Hooks ---

export function useThreads(filters?: {
  projectId?: string;
  parentThreadId?: string;
  includeArchived?: boolean;
}, options?: { enabled?: boolean }) {
  return useQuery<Thread[]>({
    queryKey: ["threads", filters],
    queryFn: () => api.listThreads(filters),
    enabled: options?.enabled ?? true,
  });
}

export function useThread(id: string) {
  return useQuery<Thread>({
    queryKey: ["thread", id],
    queryFn: () => api.getThread(id),
    enabled: !!id,
  });
}

export function useThreadEvents(id: string) {
  return useQuery<ThreadEvent[]>({
    queryKey: ["threadEvents", id],
    queryFn: () => api.getThreadEvents(id),
    enabled: !!id,
  });
}

export function useThreadEventsBatch(threadIds: string[]) {
  const uniqueThreadIds = Array.from(new Set(threadIds.filter(Boolean)));
  return useQueries({
    queries: uniqueThreadIds.map((threadId) => ({
      queryKey: ["threadEvents", threadId],
      queryFn: () => api.getThreadEvents(threadId),
      enabled: threadId.length > 0,
    })),
  });
}

export function useThreadDefaultExecutionOptions(id: string) {
  return useQuery<ThreadExecutionOptions | null>({
    queryKey: ["threadDefaultExecutionOptions", id],
    queryFn: () => api.getThreadDefaultExecutionOptions(id),
    enabled: !!id,
    refetchOnWindowFocus: false,
  });
}

export function useSystemStatus() {
  return useQuery<SystemStatus>({
    queryKey: ["status"],
    queryFn: () => api.getSystemStatus(),
  });
}

export function useAvailableModels() {
  return useQuery<AvailableModel[]>({
    queryKey: ["availableModels"],
    queryFn: () => api.getAvailableModels(),
    staleTime: 60_000,
  });
}

export function useSystemProvider() {
  return useQuery<SystemProviderInfo>({
    queryKey: ["systemProvider"],
    queryFn: () => api.getSystemProvider(),
    staleTime: 60_000,
  });
}

export function useSystemProviders() {
  return useQuery<SystemProviderInfo[]>({
    queryKey: ["systemProviders"],
    queryFn: () => api.listSystemProviders(),
    staleTime: 60_000,
  });
}

export function useSystemEnvironment() {
  return useQuery<SystemEnvironmentInfo>({
    queryKey: ["systemEnvironment"],
    queryFn: () => api.getSystemEnvironment(),
    staleTime: 60_000,
  });
}

export function useSystemEnvironments() {
  return useQuery<SystemEnvironmentInfo[]>({
    queryKey: ["systemEnvironments"],
    queryFn: () => api.listSystemEnvironments(),
    staleTime: 60_000,
  });
}

// --- Mutation Hooks ---

export function useSpawnThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: SpawnThreadRequest) => api.spawnThread(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useTellThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
      model,
      reasoningLevel,
      sandboxMode,
      mode,
    }: { id: string } & TellThreadRequest) =>
      api.tellThread(id, { input, model, reasoningLevel, sandboxMode, mode }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadEvents", variables.id] });
      queryClient.invalidateQueries({
        queryKey: ["threadDefaultExecutionOptions", variables.id],
      });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useStopThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.stopThread(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["thread", id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useArchiveThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveThread(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["thread", id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}
