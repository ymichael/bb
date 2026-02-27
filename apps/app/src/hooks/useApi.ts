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
  ThreadWorkStatus,
  UploadedPromptAttachment,
  CommitThreadResponse,
  CommitThreadRequest,
  MergeThreadResponse,
  CommitProjectResponse,
  ThreadTimelineResponse,
  ThreadToolGroupMessagesResponse,
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

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
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

export function useProjectWorkspaceStatus(projectId: string | undefined) {
  return useQuery<ThreadWorkStatus>({
    queryKey: ["projectWorkspaceStatus", projectId],
    queryFn: () => api.getProjectWorkspaceStatus(projectId ?? ""),
    enabled: Boolean(projectId),
  });
}

export function useUploadPromptAttachment() {
  return useMutation({
    mutationFn: ({
      projectId,
      file,
    }: {
      projectId: string;
      file: File;
    }): Promise<UploadedPromptAttachment> =>
      api.uploadPromptAttachment(projectId, file),
    retry: false,
  });
}

// --- Query Hooks ---

export function useThreads(filters?: {
  projectId?: string;
  parentThreadId?: string;
  includeArchived?: boolean;
  includeWorkStatus?: boolean;
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

export function useThreadEvents(
  id: string,
  options?: { enabled?: boolean; limit?: number },
) {
  return useQuery<ThreadEvent[]>({
    queryKey: ["threadEvents", id, options?.limit ?? null],
    queryFn: () => api.getThreadEvents(id, undefined, options?.limit),
    enabled: (options?.enabled ?? true) && !!id,
  });
}

export function useThreadEventsBatch(threadIds: string[]) {
  const INITIAL_THREAD_EVENTS_LIMIT = 100;
  const uniqueThreadIds = Array.from(new Set(threadIds.filter(Boolean)));
  return useQueries({
    queries: uniqueThreadIds.map((threadId) => ({
      queryKey: ["threadEvents", threadId],
      queryFn: () => api.getThreadEvents(threadId, undefined, INITIAL_THREAD_EVENTS_LIMIT),
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

export function useThreadWorkStatus(id: string) {
  return useQuery<ThreadWorkStatus | null>({
    queryKey: ["threadWorkStatus", id],
    queryFn: () => api.getThreadWorkStatus(id),
    enabled: !!id,
    refetchOnWindowFocus: false,
  });
}

export function useThreadTimeline(
  id: string,
  options?: { enabled?: boolean; limit?: number },
) {
  return useQuery<ThreadTimelineResponse>({
    queryKey: ["threadTimeline", id, options?.limit ?? null],
    queryFn: () => api.getThreadTimeline(id, options?.limit, false),
    enabled: (options?.enabled ?? true) && !!id,
  });
}

export function useThreadToolGroupMessages() {
  return useMutation({
    mutationFn: ({
      id,
      turnId,
      sourceSeqStart,
      sourceSeqEnd,
    }: {
      id: string;
      turnId: string;
      sourceSeqStart: number;
      sourceSeqEnd: number;
    }): Promise<ThreadToolGroupMessagesResponse> =>
      api.getThreadToolGroupMessages(id, turnId, sourceSeqStart, sourceSeqEnd),
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
      queryClient.invalidateQueries({ queryKey: ["threadTimeline", variables.id] });
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

export function useCommitThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...req
    }: {
      id: string;
    } & CommitThreadRequest): Promise<CommitThreadResponse> =>
      api.commitThread(id, req),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadWorkStatus", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useMergeThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }): Promise<MergeThreadResponse> =>
      api.mergeThread(id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadWorkStatus", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useCommitProjectWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      ...req
    }: {
      projectId: string;
    } & CommitThreadRequest): Promise<CommitProjectResponse> =>
      api.commitProjectWorkspace(projectId, req),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["projectWorkspaceStatus", variables.projectId] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["thread"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}
