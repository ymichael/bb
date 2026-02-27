import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  Project,
  Thread,
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
  SquashMergeThreadRequest,
  SquashMergeThreadResponse,
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
    staleTime: 30_000,
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
    staleTime: 10_000,
  });
}

export function useThread(id: string) {
  const queryClient = useQueryClient();
  return useQuery<Thread>({
    queryKey: ["thread", id],
    queryFn: () => api.getThread(id),
    enabled: !!id,
    staleTime: 5_000,
    initialData: () => {
      if (!id) return undefined;
      const threadLists = queryClient.getQueriesData<Thread[]>({
        queryKey: ["threads"],
      });
      for (const [, threads] of threadLists) {
        const match = threads?.find((thread) => thread.id === id);
        if (match) return match;
      }
      return undefined;
    },
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

export function useThreadWorkStatusLookup() {
  return useMutation({
    mutationFn: (id: string) => api.getThreadWorkStatus(id),
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
    mutationFn: (args: { id: string; force?: boolean }) =>
      api.archiveThread(args.id, { force: args.force }),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: ["thread", args.id] });
      await queryClient.cancelQueries({ queryKey: ["threads"] });

      const previousThread = queryClient.getQueryData<Thread>(["thread", args.id]);
      const previousThreadLists = queryClient.getQueriesData<Thread[]>({
        queryKey: ["threads"],
      });
      const archivedAt = Date.now();

      queryClient.setQueryData<Thread>(["thread", args.id], (thread) => {
        if (!thread) return thread;
        return {
          ...thread,
          archivedAt,
        };
      });

      for (const [queryKey, list] of previousThreadLists) {
        if (!list) continue;
        queryClient.setQueryData<Thread[]>(queryKey, list.filter((thread) => thread.id !== args.id));
      }

      return { previousThread, previousThreadLists };
    },
    onError: (_error, args, context) => {
      if (!context) return;

      queryClient.setQueryData(["thread", args.id], context.previousThread);
      for (const [queryKey, data] of context.previousThreadLists) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    onSettled: (_data, _error, args) => {
      queryClient.invalidateQueries({ queryKey: ["thread", args.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useMarkThreadRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.markThreadRead(id),
    onSuccess: (thread) => {
      queryClient.setQueryData<Thread>(["thread", thread.id], thread);
      queryClient.invalidateQueries({ queryKey: ["threads"] });
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

export function useSquashMergeThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...req
    }: {
      id: string;
    } & SquashMergeThreadRequest): Promise<SquashMergeThreadResponse> =>
      api.squashMergeThread(id, req),
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
