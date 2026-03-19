import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type {
  CommitOperationOptions,
  EnvironmentRecord,
  PromptInput,
  Project,
  ReasoningLevel,
  Thread,
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
  EnvironmentOperationResponse,
  ThreadTimelineResponse,
  ThreadToolGroupMessagesResponse,
  ThreadGitDiffSelection,
  ThreadGitDiffResponse,
  ThreadQueuedMessage,
  ThreadDetailRow,
  ThreadType,
  SquashMergeOperationOptions,
} from "@bb/core";
import * as api from "../lib/api";
import { wsManager } from "../lib/ws";

const THREAD_WORK_STATUS_QUERY_KEY = "threadWorkStatus";
const THREAD_MERGE_BASE_BRANCHES_QUERY_KEY = "threadMergeBaseBranches";
const THREAD_GIT_DIFF_QUERY_KEY = "threadGitDiff";
const THREAD_TIMELINE_QUERY_KEY = "threadTimeline";
const THREAD_QUERY_KEY = "thread";
type ThreadScopedQueryKeyPrefix =
  | typeof THREAD_QUERY_KEY
  | typeof THREAD_WORK_STATUS_QUERY_KEY
  | typeof THREAD_GIT_DIFF_QUERY_KEY
  | typeof THREAD_TIMELINE_QUERY_KEY;

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

export function resolveThreadPlaceholder(
  previousData: Thread | undefined,
  previousQueryKey: QueryKey | undefined,
  nextThreadId: string,
): Thread | undefined {
  return resolveThreadScopedPlaceholder(
    previousData,
    previousQueryKey,
    nextThreadId,
    THREAD_QUERY_KEY,
  );
}

export function resolveThreadTimelinePlaceholder(
  previousData: ThreadTimelineResponse | undefined,
  previousQueryKey: QueryKey | undefined,
  nextThreadId: string,
): ThreadTimelineResponse | undefined {
  return resolveThreadScopedPlaceholder(
    previousData,
    previousQueryKey,
    nextThreadId,
    THREAD_TIMELINE_QUERY_KEY,
  );
}

function getCachedThreadListPlaceholder(
  queryClient: QueryClient,
  id: string,
): Thread | undefined {
  if (!id) {
    return undefined;
  }
  const threadLists = queryClient.getQueriesData<Thread[]>({
    queryKey: ["threads"],
  });
  let fallbackMatch: Thread | undefined;
  for (const [queryKey, threads] of threadLists) {
    const filters = Array.isArray(queryKey)
      ? readThreadListFiltersFromQueryKey(queryKey)
      : null;
    if (filters === null) {
      continue;
    }
    const match = threads?.find((thread) => thread.id === id);
    if (match) {
      if (filters?.includeWorkStatus) {
        return match;
      }
      fallbackMatch ??= match;
    }
  }
  return fallbackMatch;
}

function updateCachedThread(
  queryClient: QueryClient,
  threadId: string,
  updater: (thread: Thread) => Thread,
): void {
  queryClient.setQueryData<Thread>(["thread", threadId], (thread) => {
    if (!thread) return thread;
    return updater(thread);
  });
}

function buildOptimisticUserMessageText(input: PromptInput[]): string {
  return input
    .filter((entry): entry is Extract<PromptInput, { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text.trim())
    .filter((entry) => entry.length > 0)
    .join("\n\n");
}

function buildOptimisticUserAttachments(input: PromptInput[]) {
  let webImages = 0;
  let localImages = 0;
  let localFiles = 0;
  const imageUrls: string[] = [];
  const localImagePaths: string[] = [];
  const localFilePaths: string[] = [];

  for (const entry of input) {
    switch (entry.type) {
      case "text":
        break;
      case "image":
        webImages += 1;
        imageUrls.push(entry.url);
        break;
      case "localImage":
        localImages += 1;
        localImagePaths.push(entry.path);
        break;
      case "localFile":
        localFiles += 1;
        localFilePaths.push(entry.path);
        break;
    }
  }

  if (webImages === 0 && localImages === 0 && localFiles === 0) {
    return undefined;
  }

  return {
    webImages,
    localImages,
    localFiles,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    ...(localImagePaths.length > 0 ? { localImagePaths } : {}),
    ...(localFilePaths.length > 0 ? { localFilePaths } : {}),
  };
}

export function buildOptimisticUserThreadRow(
  threadId: string,
  input: PromptInput[],
  createdAt: number,
): ThreadDetailRow {
  const id = `optimistic-user-${createdAt}`;
  return {
    kind: "message",
    id,
    message: {
      id,
      kind: "user",
      threadId,
      text: buildOptimisticUserMessageText(input),
      attachments: buildOptimisticUserAttachments(input),
      sourceSeqStart: Number.MAX_SAFE_INTEGER,
      sourceSeqEnd: Number.MAX_SAFE_INTEGER,
      createdAt,
    },
  };
}

export function appendOptimisticUserRowToTimeline(
  timeline: ThreadTimelineResponse | undefined,
  threadId: string,
  input: PromptInput[],
  createdAt: number,
): ThreadTimelineResponse | undefined {
  if (!timeline) {
    return timeline;
  }

  return {
    ...timeline,
    rows: [...timeline.rows, buildOptimisticUserThreadRow(threadId, input, createdAt)],
  };
}

function appendQueuedThreadMessage(
  thread: Thread,
  queuedMessage: ThreadQueuedMessage,
): Thread {
  const existingQueue = thread.queuedMessages ?? [];
  if (existingQueue.some((entry) => entry.id === queuedMessage.id)) {
    return thread;
  }
  return {
    ...thread,
    queuedMessages: [...existingQueue, queuedMessage],
  };
}

function removeQueuedThreadMessage(
  thread: Thread,
  queuedMessageId: string,
): Thread {
  const existingQueue = thread.queuedMessages ?? [];
  if (!existingQueue.some((entry) => entry.id === queuedMessageId)) {
    return thread;
  }
  return {
    ...thread,
    queuedMessages: existingQueue.filter((entry) => entry.id !== queuedMessageId),
  };
}

interface ThreadListFilters {
  projectId?: string;
  type?: ThreadType;
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
    maybeFilters.type !== undefined &&
    maybeFilters.type !== "standard" &&
    maybeFilters.type !== "manager"
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
  if (filters?.type && thread.type !== filters.type) {
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

export function useHireProjectManager() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      title,
      providerId,
      model,
      reasoningLevel,
    }: {
      projectId: string;
      title?: string;
      providerId?: string;
      model?: string;
      reasoningLevel?: ReasoningLevel;
    }) => api.hireProjectManager(projectId, { title, providerId, model, reasoningLevel }),
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

      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
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

export function useThread(
  id: string,
  options?: {
    enabled?: boolean;
    refetchOnMount?: boolean | "always";
  },
) {
  const queryClient = useQueryClient();
  return useQuery<Thread>({
    queryKey: ["thread", id],
    queryFn: () => api.getThread(id),
    enabled: (options?.enabled ?? true) && !!id,
    staleTime: 5_000,
    refetchOnMount: options?.refetchOnMount ?? true,
    placeholderData: (previousData, previousQuery) =>
      resolveThreadPlaceholder(previousData, previousQuery?.queryKey, id) ??
      getCachedThreadListPlaceholder(queryClient, id),
  });
}

export function useThreadDefaultExecutionOptions(
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery<ThreadExecutionOptions | null>({
    queryKey: ["threadDefaultExecutionOptions", id],
    queryFn: () => api.getThreadDefaultExecutionOptions(id),
    enabled: (options?.enabled ?? true) && !!id,
    refetchOnWindowFocus: false,
  });
}

export function useThreadManagerWorkspaceFiles(
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery<{ files: api.ManagerWorkspaceFileEntry[] }>({
    queryKey: ["threadManagerWorkspaceFiles", id],
    queryFn: () => api.listThreadManagerWorkspaceFiles(id),
    enabled: (options?.enabled ?? true) && !!id,
    refetchOnWindowFocus: false,
  });
}

export function useThreadManagerWorkspaceFile(
  id: string,
  path: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery<{ path: string; content: string }>({
    queryKey: ["threadManagerWorkspaceFile", id, path],
    queryFn: () => api.getThreadManagerWorkspaceFile(id, path ?? ""),
    enabled: (options?.enabled ?? true) && !!id && !!path,
    refetchOnWindowFocus: false,
  });
}

export function useThreadWorkStatus(
  id: string,
  mergeBaseBranch?: string,
  options?: { enabled?: boolean },
) {
  return useQuery<ThreadWorkStatus | null>({
    queryKey: [THREAD_WORK_STATUS_QUERY_KEY, id, mergeBaseBranch ?? null],
    queryFn: () => api.getThreadWorkStatus(id, mergeBaseBranch),
    enabled: (options?.enabled ?? true) && !!id,
    placeholderData: (previousData, previousQuery) =>
      resolveThreadWorkStatusPlaceholder(previousData, previousQuery?.queryKey, id),
    refetchOnWindowFocus: false,
  });
}

export function useThreadMergeBaseBranches(
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery<string[]>({
    queryKey: [THREAD_MERGE_BASE_BRANCHES_QUERY_KEY, id],
    queryFn: () => api.getThreadMergeBaseBranches(id),
    enabled: (options?.enabled ?? true) && !!id,
    refetchOnWindowFocus: false,
  });
}

export function useThreadTimeline(
  id: string,
  options?: {
    enabled?: boolean;
    limit?: number;
    refetchOnMount?: boolean | "always";
    includeManagerDebugView?: boolean;
  },
) {
  return useQuery<ThreadTimelineResponse>({
    queryKey: [
      "threadTimeline",
      id,
      options?.limit ?? null,
      options?.includeManagerDebugView ?? false,
    ],
    queryFn: () =>
      api.getThreadTimeline(
        id,
        options?.limit,
        false,
        options?.includeManagerDebugView ?? false,
      ),
    enabled: (options?.enabled ?? true) && !!id,
    refetchOnMount: options?.refetchOnMount ?? true,
    placeholderData: (previousData, previousQuery) =>
      resolveThreadTimelinePlaceholder(previousData, previousQuery?.queryKey, id),
  });
}

export function useThreadToolGroupMessages() {
  return useMutation({
    mutationFn: ({
      id,
      turnId,
      sourceSeqStart,
      sourceSeqEnd,
      includeManagerDebugView,
    }: {
      id: string;
      turnId: string;
      sourceSeqStart: number;
      sourceSeqEnd: number;
      includeManagerDebugView?: boolean;
    }): Promise<ThreadToolGroupMessagesResponse> =>
      api.getThreadToolGroupMessages(
        id,
        turnId,
        sourceSeqStart,
        sourceSeqEnd,
        includeManagerDebugView ?? false,
      ),
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

export function useAvailableModels(providerId?: string) {
  return useQuery<AvailableModel[]>({
    queryKey: ["availableModels", providerId ?? null],
    queryFn: () => api.getAvailableModels(providerId),
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

export function useSystemEnvironments() {
  return useQuery<SystemEnvironmentInfo[]>({
    queryKey: ["systemEnvironments"],
    queryFn: () => api.listSystemEnvironments(),
    staleTime: 60_000,
  });
}

export function useEnvironments(projectId?: string) {
  return useQuery<EnvironmentRecord[]>({
    queryKey: ["environments", projectId ?? ""],
    queryFn: () => api.listEnvironments(projectId),
    staleTime: 30_000,
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
      serviceTier,
      reasoningLevel,
      sandboxMode,
      mode,
      demotePrimaryIfNeeded,
    }: { id: string } & TellThreadRequest) =>
      api.tellThread(id, {
        input,
        model,
        serviceTier,
        reasoningLevel,
        sandboxMode,
        mode,
        demotePrimaryIfNeeded,
      }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["thread", variables.id] });

      const previousThread = queryClient.getQueryData<Thread>(["thread", variables.id]);
      const optimisticCreatedAt = Date.now();

      updateCachedThread(queryClient, variables.id, (thread) => ({
        ...thread,
        status: "active",
        updatedAt: Math.max(thread.updatedAt, optimisticCreatedAt),
      }));

      return {
        previousThread,
      };
    },
    onError: (_error, variables, context) => {
      if (context?.previousThread) {
        queryClient.setQueryData<Thread>(["thread", variables.id], context.previousThread);
      }
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["threadDefaultExecutionOptions", variables.id],
      });
      if (wsManager.getConnectionState() !== "connected") {
        queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
        queryClient.invalidateQueries({ queryKey: ["threadTimeline", variables.id] });
        queryClient.invalidateQueries({ queryKey: ["threads"] });
        queryClient.invalidateQueries({ queryKey: ["status"] });
      }
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
      serviceTier,
      reasoningLevel,
      sandboxMode,
    }: { id: string } & EnqueueThreadMessageRequest): Promise<ThreadQueuedMessage> =>
      api.enqueueThreadMessage(id, {
        input,
        model,
        serviceTier,
        reasoningLevel,
        sandboxMode,
      }),
    onSuccess: (queuedMessage, variables) => {
      updateCachedThread(queryClient, variables.id, (thread) =>
        appendQueuedThreadMessage(thread, queuedMessage),
      );
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
      updateCachedThread(queryClient, variables.id, (thread) =>
        removeQueuedThreadMessage(thread, variables.queuedMessageId),
      );
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
    mutationFn: (
      {
        id,
        ...req
      }: {
        id: string;
        title?: string;
        mergeBaseBranch?: string | null;
        parentThreadId?: string | null;
      },
    ) =>
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

export function useDeleteThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string }) => api.deleteThread(args.id),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: ["thread", args.id] });
      await queryClient.cancelQueries({ queryKey: ["threads"] });
      await queryClient.cancelQueries({ queryKey: ["projects"] });

      const previousThread = queryClient.getQueryData<Thread>(["thread", args.id]);
      const previousThreadLists = queryClient.getQueriesData<Thread[]>({
        queryKey: ["threads"],
      });
      const previousProjects = queryClient.getQueryData<Project[]>(["projects"]);

      queryClient.removeQueries({ queryKey: ["thread", args.id] });
      queryClient.removeQueries({ queryKey: ["threadTimeline", args.id] });
      queryClient.removeQueries({ queryKey: ["threadWorkStatus", args.id] });
      queryClient.removeQueries({ queryKey: ["threadGitDiff", args.id] });
      queryClient.removeQueries({ queryKey: ["threadMergeBaseBranches", args.id] });

      for (const [queryKey, list] of previousThreadLists) {
        if (!list) continue;
        queryClient.setQueryData<Thread[]>(
          queryKey,
          list.filter((thread) => thread.id !== args.id),
        );
      }

      return { previousThread, previousThreadLists, previousProjects };
    },
    onError: (_error, args, context) => {
      if (!context) return;

      queryClient.setQueryData(["thread", args.id], context.previousThread);
      for (const [queryKey, data] of context.previousThreadLists) {
        queryClient.setQueryData(queryKey, data);
      }
      queryClient.setQueryData(["projects"], context.previousProjects);
    },
    onSettled: (_data, _error, args) => {
      queryClient.removeQueries({ queryKey: ["thread", args.id] });
      queryClient.removeQueries({ queryKey: ["threadTimeline", args.id] });
      queryClient.removeQueries({ queryKey: ["threadWorkStatus", args.id] });
      queryClient.removeQueries({ queryKey: ["threadGitDiff", args.id] });
      queryClient.removeQueries({ queryKey: ["threadMergeBaseBranches", args.id] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
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

export function useRequestEnvironmentOperation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...req
    }: {
      id: string;
    } & (
      | { operation: "promote_primary"; initiatingThreadId: string }
      | { operation: "demote_primary"; initiatingThreadId: string }
      | { operation: "commit"; initiatingThreadId: string; options?: CommitOperationOptions }
      | { operation: "squash_merge"; initiatingThreadId: string; options?: SquashMergeOperationOptions }
    )): Promise<EnvironmentOperationResponse> =>
      api.requestEnvironmentOperation(id, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["thread"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["threadTimeline"] });
      queryClient.invalidateQueries({ queryKey: ["threadWorkStatus"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useShutdownServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req?: SystemShutdownRequest): Promise<SystemShutdownAcceptedResponse> =>
      api.shutdownServer(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useRestartServer() {
  return useMutation({
    mutationFn: (req?: SystemRestartRequest): Promise<SystemRestartAcceptedResponse> =>
      api.restartServer(req),
    // Avoid immediately refetching system endpoints here: a successful restart
    // request intentionally drops the server for a moment, which can produce
    // noisy transient 5xx proxy errors in the browser console. The websocket
    // reconnect path already invalidates queries once the server is back.
  });
}
