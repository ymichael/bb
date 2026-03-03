import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type {
  Project,
  Thread,
  ThreadEvent,
  CreateProjectRequest,
  UpdateProjectRequest,
  SpawnThreadRequest,
  TellThreadRequest,
  EnqueueThreadMessageRequest,
  SendQueuedThreadMessageRequest,
  SendQueuedThreadMessageResponse,
  SystemStatus,
  SystemRestartPolicy,
  SystemRestartAcceptedResponse,
  SystemRestartRequest,
  SystemShutdownAcceptedResponse,
  SystemShutdownRequest,
  SystemEnvironmentInfo,
  SystemProviderInfo,
  AvailableModel,
  ProjectFileSuggestion,
  ThreadExecutionOptions,
  ThreadWorkStatus,
  UploadedPromptAttachment,
  ThreadOperationRequest,
  ThreadOperationResponse,
  PromoteThreadResponse,
  DemotePrimaryResponse,
  ThreadTimelineResponse,
  ThreadToolGroupMessagesResponse,
  ThreadGitDiffSelection,
  ThreadGitDiffResponse,
  ThreadQueuedMessage,
} from "@beanbag/agent-core";
import * as api from "../lib/api";

const DEFAULT_THREAD_EVENTS_LIMIT = 120;
const THREAD_WORK_STATUS_QUERY_KEY = "threadWorkStatus";
const THREAD_GIT_DIFF_QUERY_KEY = "threadGitDiff";
type ThreadScopedQueryKeyPrefix =
  | typeof THREAD_WORK_STATUS_QUERY_KEY
  | typeof THREAD_GIT_DIFF_QUERY_KEY;

function extractThreadIdFromThreadScopedQueryKey(
  queryKey: QueryKey | undefined,
  queryKeyPrefix: ThreadScopedQueryKeyPrefix,
): string | undefined {
  if (!queryKey || queryKey[0] !== queryKeyPrefix) {
    return undefined;
  }
  const threadId = queryKey[1];
  return typeof threadId === "string" ? threadId : undefined;
}

function resolveThreadScopedPlaceholder<TData>(
  previousData: TData | undefined,
  previousQueryKey: QueryKey | undefined,
  nextThreadId: string,
  queryKeyPrefix: ThreadScopedQueryKeyPrefix,
): TData | undefined {
  if (previousData === undefined) {
    return undefined;
  }
  return extractThreadIdFromThreadScopedQueryKey(previousQueryKey, queryKeyPrefix) ===
    nextThreadId
    ? previousData
    : undefined;
}

export function resolveThreadWorkStatusPlaceholder(
  previousData: ThreadWorkStatus | null | undefined,
  previousQueryKey: QueryKey | undefined,
  nextThreadId: string,
): ThreadWorkStatus | null | undefined {
  return resolveThreadScopedPlaceholder(
    previousData,
    previousQueryKey,
    nextThreadId,
    THREAD_WORK_STATUS_QUERY_KEY,
  );
}

export function resolveThreadGitDiffPlaceholder(
  previousData: ThreadGitDiffResponse | undefined,
  previousQueryKey: QueryKey | undefined,
  nextThreadId: string,
): ThreadGitDiffResponse | undefined {
  return resolveThreadScopedPlaceholder(
    previousData,
    previousQueryKey,
    nextThreadId,
    THREAD_GIT_DIFF_QUERY_KEY,
  );
}

interface ThreadListFilters {
  projectId?: string;
  parentThreadId?: string;
  includeArchived?: boolean;
  includeWorkStatus?: boolean;
}

function isThreadListFilters(value: unknown): value is ThreadListFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const maybeFilters = value as Record<string, unknown>;
  if (
    maybeFilters.projectId !== undefined &&
    typeof maybeFilters.projectId !== "string"
  ) {
    return false;
  }
  if (
    maybeFilters.parentThreadId !== undefined &&
    typeof maybeFilters.parentThreadId !== "string"
  ) {
    return false;
  }
  if (
    maybeFilters.includeArchived !== undefined &&
    typeof maybeFilters.includeArchived !== "boolean"
  ) {
    return false;
  }
  if (
    maybeFilters.includeWorkStatus !== undefined &&
    typeof maybeFilters.includeWorkStatus !== "boolean"
  ) {
    return false;
  }
  return true;
}

function readThreadListFiltersFromQueryKey(
  queryKey: readonly unknown[],
): ThreadListFilters | undefined | null {
  if (queryKey.length < 2) {
    return undefined;
  }
  const rawFilters = queryKey[1];
  if (rawFilters === undefined) {
    return undefined;
  }
  if (!isThreadListFilters(rawFilters)) {
    return null;
  }
  return rawFilters;
}

function threadMatchesListFilters(
  thread: Thread,
  filters: ThreadListFilters | undefined,
): boolean {
  if (thread.archivedAt !== undefined && !filters?.includeArchived) {
    return false;
  }
  if (filters?.projectId && thread.projectId !== filters.projectId) {
    return false;
  }
  if (
    filters?.parentThreadId !== undefined &&
    thread.parentThreadId !== filters.parentThreadId
  ) {
    return false;
  }
  return true;
}

function appendThreadIfMissing(
  list: Thread[],
  thread: Thread,
): Thread[] {
  if (list.some((candidate) => candidate.id === thread.id)) {
    return list;
  }
  return [...list, thread];
}

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

export function useThreads(
  filters?: ThreadListFilters,
  options?: { enabled?: boolean },
) {
  return useQuery<Thread[]>({
    queryKey: ["threads", filters],
    queryFn: ({ signal }) => api.listThreads(filters, signal),
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

export function useThreadWorkStatus(id: string, mergeBaseBranch?: string) {
  return useQuery<ThreadWorkStatus | null>({
    queryKey: [THREAD_WORK_STATUS_QUERY_KEY, id, mergeBaseBranch ?? null],
    queryFn: () => api.getThreadWorkStatus(id, mergeBaseBranch),
    enabled: !!id,
    placeholderData: (previousData, previousQuery) =>
      resolveThreadWorkStatusPlaceholder(previousData, previousQuery?.queryKey, id),
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

export function useThreadEvents(
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery<ThreadEvent[]>({
    queryKey: ["threadEvents", id],
    queryFn: () => api.getThreadEvents(id, undefined, DEFAULT_THREAD_EVENTS_LIMIT),
    enabled: (options?.enabled ?? true) && !!id,
    refetchOnWindowFocus: false,
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

export function useThreadGitDiff(
  id: string,
  options?: {
    enabled?: boolean;
    selection?: ThreadGitDiffSelection;
    mergeBaseBranch?: string;
  },
) {
  const selectionKey =
    options?.selection?.type === "commit"
      ? options.selection.sha
      : "combined";
  return useQuery<ThreadGitDiffResponse>({
    queryKey: [
      THREAD_GIT_DIFF_QUERY_KEY,
      id,
      options?.selection?.type ?? "combined",
      selectionKey,
      options?.mergeBaseBranch ?? null,
    ],
    queryFn: () => api.getThreadGitDiff(id, options?.selection, options?.mergeBaseBranch),
    enabled: (options?.enabled ?? true) && !!id,
    placeholderData: (previousData, previousQuery) =>
      resolveThreadGitDiffPlaceholder(previousData, previousQuery?.queryKey, id),
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
}

export function useSystemStatus() {
  return useQuery<SystemStatus>({
    queryKey: ["status"],
    queryFn: () => api.getSystemStatus(),
  });
}

export function useSystemRestartPolicy() {
  return useQuery<SystemRestartPolicy>({
    queryKey: ["systemRestartPolicy"],
    queryFn: () => api.getSystemRestartPolicy(),
    staleTime: 60_000,
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
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["threads"] });
    },
    onSuccess: (thread) => {
      queryClient.setQueryData<Thread>(["thread", thread.id], thread);

      const existingThreadLists = queryClient.getQueriesData<Thread[]>({
        queryKey: ["threads"],
      });
      for (const [queryKey, list] of existingThreadLists) {
        if (!list) {
          continue;
        }
        const filters = readThreadListFiltersFromQueryKey(queryKey);
        if (filters === null) {
          continue;
        }
        if (!threadMatchesListFilters(thread, filters)) {
          continue;
        }
        const nextList = appendThreadIfMissing(list, thread);
        if (nextList !== list) {
          queryClient.setQueryData<Thread[]>(queryKey, nextList);
        }
      }

      void queryClient.refetchQueries({
        queryKey: ["threads"],
        type: "active",
      });
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
      demotePrimaryIfNeeded,
    }: { id: string } & TellThreadRequest) =>
      api.tellThread(id, {
        input,
        model,
        reasoningLevel,
        sandboxMode,
        mode,
        demotePrimaryIfNeeded,
      }),
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

export function useEnqueueThreadMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
      model,
      reasoningLevel,
      sandboxMode,
    }: { id: string } & EnqueueThreadMessageRequest): Promise<ThreadQueuedMessage> =>
      api.enqueueThreadMessage(id, { input, model, reasoningLevel, sandboxMode }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    },
  });
}

export function useSendQueuedThreadMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      queuedMessageId,
      mode,
    }: {
      id: string;
      queuedMessageId: string;
    } & SendQueuedThreadMessageRequest): Promise<SendQueuedThreadMessageResponse> =>
      api.sendQueuedThreadMessage(id, queuedMessageId, { mode }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadEvents", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadTimeline", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useDeleteQueuedThreadMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      queuedMessageId,
    }: {
      id: string;
      queuedMessageId: string;
    }) => api.deleteQueuedThreadMessage(id, queuedMessageId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
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

export function useUpdateThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...req }: { id: string } & { title?: string }) =>
      api.updateThread(id, req),
    onSuccess: (thread) => {
      queryClient.setQueryData<Thread>(["thread", thread.id], thread);
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

export function useUnarchiveThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string }) => api.unarchiveThread(args.id),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: ["thread", args.id] });
      await queryClient.cancelQueries({ queryKey: ["threads"] });

      const previousThread = queryClient.getQueryData<Thread>(["thread", args.id]);
      const previousThreadLists = queryClient.getQueriesData<Thread[]>({
        queryKey: ["threads"],
      });

      queryClient.setQueryData<Thread>(["thread", args.id], (thread) => {
        if (!thread) return thread;
        return {
          ...thread,
          archivedAt: undefined,
        };
      });

      for (const [queryKey, list] of previousThreadLists) {
        if (!list) continue;
        queryClient.setQueryData<Thread[]>(
          queryKey,
          list.map((thread) =>
            thread.id === args.id
              ? {
                  ...thread,
                  archivedAt: undefined,
                }
              : thread,
          ),
        );
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

export function useMarkThreadUnread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.markThreadUnread(id),
    onSuccess: (thread) => {
      queryClient.setQueryData<Thread>(["thread", thread.id], thread);
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    },
  });
}

export function useRequestThreadOperation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...req
    }: {
      id: string;
    } & ThreadOperationRequest): Promise<ThreadOperationResponse> =>
      api.requestThreadOperation(id, req),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadEvents", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadTimeline", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadWorkStatus", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function usePromoteThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }): Promise<PromoteThreadResponse> =>
      api.promoteThread(id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["threadTimeline", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadEvents", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useDemotePrimaryCheckout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }): Promise<DemotePrimaryResponse> =>
      api.demotePrimaryCheckout(id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["threadTimeline", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadEvents", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useShutdownDaemon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req?: SystemShutdownRequest): Promise<SystemShutdownAcceptedResponse> =>
      api.shutdownDaemon(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useRestartDaemon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req?: SystemRestartRequest): Promise<SystemRestartAcceptedResponse> =>
      api.restartDaemon(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.invalidateQueries({ queryKey: ["systemRestartPolicy"] });
    },
  });
}
