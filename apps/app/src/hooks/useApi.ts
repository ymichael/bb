import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type {
  Environment,
  Host,
  PromptInput,
  Project,
  ReasoningLevel,
  Thread,
  TimelineRow,
  AvailableModel,
  ThreadExecutionOptions,
  ThreadGitDiffResponse,
  ThreadGitDiffSelection,
  WorkspaceStatus,
  ThreadQueuedMessage,
  ThreadType,
} from "@bb/domain";
import type {
  CreateProjectRequest,
  CreateDraftRequest,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  ProjectFileSuggestion,
  ProjectResponse,
  SendDraftRequest,
  SendDraftResponse,
  CreateThreadRequest,
  SystemProviderInfo,
  SendMessageRequest,
  ThreadTimelineResponse,
  TimelineToolDetailsResponse,
  UpdateProjectRequest,
  UploadedPromptAttachment,
} from "@bb/server-contract";
import * as api from "../lib/api";
import { wsManager } from "../lib/ws";

const ENVIRONMENT_QUERY_KEY = "environment";
const ENVIRONMENT_WORK_STATUS_QUERY_KEY = "environmentWorkStatus";
const WORKSPACE_STATUS_QUERY_KEY = "workspaceStatus";
const ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY = "environmentMergeBaseBranches";
const ENVIRONMENT_GIT_DIFF_QUERY_KEY = "environmentGitDiff";
const THREAD_TIMELINE_QUERY_KEY = "threadTimeline";
const THREAD_QUERY_KEY = "thread";
type ThreadScopedQueryKeyPrefix =
  | typeof THREAD_QUERY_KEY
  | typeof WORKSPACE_STATUS_QUERY_KEY
  | typeof ENVIRONMENT_GIT_DIFF_QUERY_KEY
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

export function resolveWorkspaceStatusPlaceholder(
  previousData: WorkspaceStatus | null | undefined,
  previousQueryKey: QueryKey | undefined,
  nextThreadId: string,
): WorkspaceStatus | null | undefined {
  return resolveThreadScopedPlaceholder(
    previousData,
    previousQueryKey,
    nextThreadId,
    WORKSPACE_STATUS_QUERY_KEY,
  );
}

export function resolveEnvironmentGitDiffPlaceholder(
  previousData: ThreadGitDiffResponse | undefined,
  previousQueryKey: QueryKey | undefined,
  nextEnvironmentId: string,
): ThreadGitDiffResponse | undefined {
  return resolveThreadScopedPlaceholder(
    previousData,
    previousQueryKey,
    nextEnvironmentId,
    ENVIRONMENT_GIT_DIFF_QUERY_KEY,
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

interface EnvironmentActionInvalidationParams {
  environmentId: string;
}

export function getEnvironmentActionInvalidationQueryKeys({
  environmentId,
}: EnvironmentActionInvalidationParams): QueryKey[] {
  return [
    [ENVIRONMENT_QUERY_KEY, environmentId],
    ["threads"],
    [ENVIRONMENT_WORK_STATUS_QUERY_KEY, environmentId],
    [ENVIRONMENT_GIT_DIFF_QUERY_KEY, environmentId],
    [ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY, environmentId],
    ["status"],
  ];
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
): TimelineRow {
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

interface ThreadListFilters {
  projectId?: string;
  type?: ThreadType;
  parentThreadId?: string;
  archived?: boolean;
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
    maybeFilters.archived !== undefined &&
    typeof maybeFilters.archived !== "boolean"
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
  if (filters?.archived === true && thread.archivedAt == null) {
    return false;
  }
  if (filters?.archived !== true && thread.archivedAt != null) {
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

// --- Hosts ---

export function useHosts() {
  return useQuery<Host[]>({
    queryKey: ["hosts"],
    queryFn: () => api.listHosts(),
    staleTime: 30_000,
  });
}

// --- Projects ---

export function useProjects() {
  return useQuery<ProjectResponse[]>({
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


export function useEnvironment(environmentId: string | null | undefined) {
  return useQuery<Environment>({
    queryKey: [ENVIRONMENT_QUERY_KEY, environmentId],
    queryFn: () => api.getEnvironment(environmentId!),
    enabled: !!environmentId,
  });
}

export function useEnvironmentWorkStatus(
  environmentId: string | null | undefined,
  mergeBaseBranch?: string,
  options?: { enabled?: boolean },
) {
  return useQuery<WorkspaceStatus | null>({
    queryKey: [ENVIRONMENT_WORK_STATUS_QUERY_KEY, environmentId, mergeBaseBranch ?? null],
    queryFn: () => api.getEnvironmentWorkStatus(environmentId!, mergeBaseBranch!),
    enabled: (options?.enabled ?? true) && !!environmentId && !!mergeBaseBranch,
    refetchOnWindowFocus: false,
  });
}

export function useEnvironmentMergeBaseBranches(
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery<string[]>({
    queryKey: [ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY, id],
    queryFn: () => api.getEnvironmentDiffBranches(id),
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
    includeManagerWorkspaceViewer?: boolean;
  },
) {
  return useQuery<ThreadTimelineResponse>({
    queryKey: [
      "threadTimeline",
      id,
      options?.limit ?? null,
      options?.includeManagerWorkspaceViewer ?? false,
    ],
    queryFn: () =>
      api.getThreadTimeline(
        id,
        options?.limit,
        false,
        options?.includeManagerWorkspaceViewer ?? false,
      ),
    enabled: (options?.enabled ?? true) && !!id,
    refetchOnMount: options?.refetchOnMount ?? true,
    placeholderData: (previousData, previousQuery) =>
      resolveThreadTimelinePlaceholder(previousData, previousQuery?.queryKey, id),
  });
}

export function useThreadTimelineToolDetails() {
  return useMutation({
    mutationFn: ({
      id,
      turnId,
      sourceSeqStart,
      sourceSeqEnd,
      includeManagerWorkspaceViewer,
    }: {
      id: string;
      turnId: string;
      sourceSeqStart: number;
      sourceSeqEnd: number;
      includeManagerWorkspaceViewer?: boolean;
    }): Promise<TimelineToolDetailsResponse> =>
      api.getThreadTimelineToolDetails(
        id,
        turnId,
        sourceSeqStart,
        sourceSeqEnd,
        includeManagerWorkspaceViewer ?? false,
      ),
  });
}

export function useEnvironmentGitDiff(
  id: string,
  options: {
    enabled?: boolean;
    selection: ThreadGitDiffSelection;
    mergeBaseBranch?: string;
  },
) {
  const selectionKey =
    options.selection.type === "commit"
      ? options.selection.sha
      : "combined";
  return useQuery<ThreadGitDiffResponse>({
    queryKey: [
      ENVIRONMENT_GIT_DIFF_QUERY_KEY,
      id,
      options.selection.type,
      selectionKey,
      options.mergeBaseBranch ?? null,
    ],
    queryFn: () => api.getEnvironmentDiff(id, options.selection, options.mergeBaseBranch!),
    enabled: (options?.enabled ?? true) && !!id && !!options.mergeBaseBranch,
    placeholderData: (previousData, previousQuery) =>
      resolveEnvironmentGitDiffPlaceholder(previousData, previousQuery?.queryKey, id),
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
}

export function useAvailableModels(providerId?: string) {
  return useQuery<AvailableModel[]>({
    queryKey: ["availableModels", providerId ?? null],
    queryFn: () => api.getAvailableModels(providerId),
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

// --- Mutation Hooks ---

export function useCreateThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateThreadRequest) => api.createThread(req),
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

export function useSendThreadMessage() {
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
    }: { id: string } & SendMessageRequest) =>
      api.sendThreadMessage(id, {
        input,
        model,
        serviceTier,
        reasoningLevel,
        sandboxMode,
        mode,
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

export function useCreateThreadDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
      model,
      serviceTier,
      reasoningLevel,
      sandboxMode,
    }: { id: string } & CreateDraftRequest): Promise<ThreadQueuedMessage> =>
      api.createThreadDraft(id, {
        input,
        model,
        serviceTier,
        reasoningLevel,
        sandboxMode,
      }),
    onSuccess: (_queuedMessage, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
    },
  });
}

export function useSendThreadDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      queuedMessageId,
      mode,
    }: {
      id: string;
      queuedMessageId: string;
    } & SendDraftRequest): Promise<SendDraftResponse> =>
      api.sendThreadDraft(id, queuedMessageId, { mode }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadTimeline", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useDeleteThreadDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      queuedMessageId,
    }: {
      id: string;
      queuedMessageId: string;
    }) => api.deleteThreadDraft(id, queuedMessageId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
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
    mutationFn: (args: { id: string; force: boolean }) =>
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
          archivedAt: null,
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
                  archivedAt: null,
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
      queryClient.removeQueries({ queryKey: [WORKSPACE_STATUS_QUERY_KEY, args.id] });
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
      queryClient.removeQueries({ queryKey: [WORKSPACE_STATUS_QUERY_KEY, args.id] });
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

export function useRequestEnvironmentAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...req
    }: { id: string } & EnvironmentActionRequest): Promise<EnvironmentActionResponse> =>
      api.requestEnvironmentAction(id, req),
    onSuccess: (_response, variables) => {
      for (const queryKey of getEnvironmentActionInvalidationQueryKeys({
        environmentId: variables.id,
      })) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
