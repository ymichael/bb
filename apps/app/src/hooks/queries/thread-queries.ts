import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  Host,
  PendingInteraction,
  ResolvedThreadExecutionOptions,
} from "@bb/domain";
import type {
  PromptHistoryResponse,
  ThreadComposerBootstrapResponse,
  ThreadDraftListResponse,
  ThreadListResponse,
  ManagerTimelineView,
  ThreadPendingInteractionsResponse,
  ThreadResponse,
  ThreadWithIncludesResponse,
  ThreadStorageFileListResponse,
  ThreadTimelineResponse,
  TimelineTurnSummaryDetailsRequest,
  TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import type { ThreadListFilters, FilePreview } from "@/lib/api";
import type { ThreadStorageFileListOptions } from "@/lib/thread-storage-files";
import * as api from "@/lib/api";
import { getCachedThreadListPlaceholder } from "./query-cache";
import {
  resolveThreadPlaceholder,
  resolveThreadTimelinePlaceholder,
} from "./query-placeholders";
import {
  archivedThreadsListQueryKey,
  disabledThreadListQueryKey,
  environmentQueryKey,
  hostQueryKey,
  hostsQueryKey,
  systemExecutionOptionsQueryKey,
  threadComposerBootstrapQueryKey,
  threadDetailBootstrapQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadDraftsQueryKey,
  threadListQueryKey,
  threadPendingInteractionsQueryKey,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadStorageFilesQueryKey,
  threadStorageFilePreviewQueryKey,
  threadHostFilePreviewQueryKey,
  threadTimelineQueryKey,
  type ArchivedThreadsKindFilter,
} from "./query-keys";
import { ARCHIVED_THREADS_PAGE_SIZE } from "./archived-threads-page-size";

interface QueryOptions {
  enabled?: boolean;
  refetchOnMount?: boolean | "always";
  staleTime?: number;
}

interface ThreadComposerBootstrapQueryOptions extends QueryOptions {
  environmentId?: string;
}

type HostList = Host[];
type HostListQueryData = HostList | undefined;

interface UpsertHostListArgs {
  host: Host;
  hosts: HostListQueryData;
}

export interface UseThreadsFilters extends Omit<
  ThreadListFilters,
  "archived" | "projectId"
> {
  archived: boolean;
  projectId?: string;
}

interface ThreadTimelineTurnSummaryDetailsMutationRequest extends TimelineTurnSummaryDetailsRequest {
  id: string;
}

function requireThreadId(id: string, hookName: string): string {
  if (!id) {
    throw new Error(`${hookName}: thread id is required when query is enabled`);
  }

  return id;
}

export interface UseArchivedThreadsFilters {
  projectId: string | undefined;
  kind: ArchivedThreadsKindFilter;
}

interface ArchivedThreadsApiFilters {
  managed?: boolean;
  type?: ThreadListFilters["type"];
}

function archivedThreadsKindToApiFilters(
  kind: ArchivedThreadsKindFilter,
): ArchivedThreadsApiFilters {
  if (kind === "manager") return { type: "manager" };
  if (kind === "managed") return { managed: true, type: "standard" };
  if (kind === "unmanaged") return { managed: false, type: "standard" };
  return {};
}

export function useArchivedThreads(
  filters: UseArchivedThreadsFilters,
  options?: QueryOptions,
) {
  const { projectId, kind } = filters;
  const enabled = (options?.enabled ?? true) && Boolean(projectId);
  const apiFilters = archivedThreadsKindToApiFilters(kind);

  return useInfiniteQuery<
    ThreadListResponse,
    Error,
    { pageParams: number[]; pages: ThreadListResponse[] },
    ReturnType<typeof archivedThreadsListQueryKey>,
    number
  >({
    queryKey: archivedThreadsListQueryKey({
      projectId: projectId ?? "",
      kind,
    }),
    queryFn: ({ pageParam, signal }) =>
      api.listThreads(
        {
          projectId: requireThreadId(projectId ?? "", "useArchivedThreads"),
          archived: true,
          ...apiFilters,
          limit: ARCHIVED_THREADS_PAGE_SIZE,
          offset: pageParam,
        },
        signal,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < ARCHIVED_THREADS_PAGE_SIZE) {
        return undefined;
      }
      return allPages.reduce((sum, page) => sum + page.length, 0);
    },
    enabled,
    staleTime: 10_000,
  });
}

export function useThreads(filters: UseThreadsFilters, options?: QueryOptions) {
  const { projectId, ...rest } = filters;
  const enabled = (options?.enabled ?? true) && Boolean(projectId);
  const queryKey =
    enabled && projectId
      ? threadListQueryKey({ ...rest, projectId })
      : disabledThreadListQueryKey(projectId ? { ...rest, projectId } : rest);

  return useQuery<ThreadListResponse>({
    queryKey,
    queryFn: ({ signal }) =>
      api.listThreads(
        {
          ...rest,
          projectId: requireThreadId(projectId ?? "", "useThreads"),
        },
        signal,
      ),
    enabled,
    staleTime: 10_000,
  });
}

export function useThread(id: string, options?: QueryOptions) {
  const queryClient = useQueryClient();

  return useQuery<ThreadResponse>({
    queryKey: threadQueryKey(id),
    queryFn: () => api.getThread(requireThreadId(id, "useThread")),
    enabled: (options?.enabled ?? true) && Boolean(id),
    staleTime: 5_000,
    refetchOnMount: options?.refetchOnMount ?? true,
    placeholderData: (previousData, previousQuery) =>
      resolveThreadPlaceholder(previousData, previousQuery?.queryKey, id) ??
      getCachedThreadListPlaceholder(queryClient, id),
  });
}

function stripThreadIncludes(
  thread: ThreadWithIncludesResponse,
): ThreadResponse {
  const { environment, host, ...threadResponse } = thread;
  return threadResponse;
}

function upsertHostList({ host, hosts }: UpsertHostListArgs): HostList {
  if (!hosts) {
    return [host];
  }

  let found = false;
  const nextHosts = hosts.map((candidate) => {
    if (candidate.id !== host.id) {
      return candidate;
    }
    found = true;
    return host;
  });

  return found ? nextHosts : [...hosts, host];
}

export function useThreadDetailBootstrap(id: string, options?: QueryOptions) {
  const queryClient = useQueryClient();

  return useQuery<ThreadWithIncludesResponse>({
    queryKey: threadDetailBootstrapQueryKey(id),
    queryFn: async () => {
      const thread = await api.getThreadWithEnvironmentHost(
        requireThreadId(id, "useThreadDetailBootstrap"),
      );
      queryClient.setQueryData(
        threadQueryKey(thread.id),
        stripThreadIncludes(thread),
      );
      if (thread.environment) {
        queryClient.setQueryData(
          environmentQueryKey(thread.environment.id),
          thread.environment,
        );
      }
      if (thread.host) {
        const host = thread.host;
        queryClient.setQueryData(hostQueryKey(host.id), host);
        queryClient.setQueryData<HostList>(hostsQueryKey(), (hosts) =>
          upsertHostList({ host, hosts }),
        );
      }
      return thread;
    },
    enabled: (options?.enabled ?? true) && Boolean(id),
    staleTime: Infinity,
  });
}

export function useThreadComposerBootstrap(
  id: string,
  options?: ThreadComposerBootstrapQueryOptions,
) {
  const queryClient = useQueryClient();
  const environmentId = options?.environmentId ?? null;

  return useQuery<ThreadComposerBootstrapResponse>({
    queryKey: threadComposerBootstrapQueryKey(id, environmentId),
    queryFn: async () => {
      const bootstrap = await api.getThreadComposerBootstrap(
        requireThreadId(id, "useThreadComposerBootstrap"),
      );
      queryClient.setQueryData(
        threadDefaultExecutionOptionsQueryKey(id),
        bootstrap.defaultExecutionOptions,
      );
      queryClient.setQueryData(threadDraftsQueryKey(id), bootstrap.drafts);
      queryClient.setQueryData(
        threadPromptHistoryQueryKey(id),
        bootstrap.promptHistory,
      );
      queryClient.setQueryData(
        threadPendingInteractionsQueryKey(id),
        bootstrap.pendingInteractions,
      );
      const providerId = bootstrap.executionOptions.providers[0]?.id;
      if (providerId) {
        queryClient.setQueryData(
          systemExecutionOptionsQueryKey({ environmentId, providerId }),
          bootstrap.executionOptions,
        );
      }
      return bootstrap;
    },
    enabled: (options?.enabled ?? true) && Boolean(id),
    refetchOnMount: options?.refetchOnMount ?? true,
    refetchOnWindowFocus: false,
    staleTime: options?.staleTime,
  });
}

export function useThreadDefaultExecutionOptions(
  id: string,
  options?: QueryOptions,
) {
  return useQuery<ResolvedThreadExecutionOptions | null>({
    queryKey: threadDefaultExecutionOptionsQueryKey(id),
    queryFn: () =>
      api.getThreadDefaultExecutionOptions(
        requireThreadId(id, "useThreadDefaultExecutionOptions"),
      ),
    enabled: (options?.enabled ?? true) && Boolean(id),
    refetchOnMount: options?.refetchOnMount ?? true,
    refetchOnWindowFocus: false,
    staleTime: options?.staleTime,
  });
}

export function useThreadDrafts(id: string, options?: QueryOptions) {
  return useQuery<ThreadDraftListResponse>({
    queryKey: threadDraftsQueryKey(id),
    queryFn: () => api.listThreadDrafts(requireThreadId(id, "useThreadDrafts")),
    enabled: (options?.enabled ?? true) && Boolean(id),
    refetchOnMount: options?.refetchOnMount ?? true,
    refetchOnWindowFocus: false,
    staleTime: options?.staleTime,
  });
}

export function useThreadPromptHistory(id: string, options?: QueryOptions) {
  return useQuery<PromptHistoryResponse>({
    queryKey: threadPromptHistoryQueryKey(id),
    queryFn: ({ signal }) =>
      api.listThreadPromptHistory(
        requireThreadId(id, "useThreadPromptHistory"),
        signal,
      ),
    enabled: (options?.enabled ?? true) && Boolean(id),
    refetchOnMount: options?.refetchOnMount ?? true,
    staleTime: options?.staleTime ?? 10_000,
  });
}

export function useThreadPendingInteractions(
  id: string,
  options?: QueryOptions,
) {
  return useQuery<ThreadPendingInteractionsResponse>({
    queryKey: threadPendingInteractionsQueryKey(id),
    queryFn: ({ signal }) =>
      api.listThreadPendingInteractions(
        requireThreadId(id, "useThreadPendingInteractions"),
        signal,
      ),
    enabled: (options?.enabled ?? true) && Boolean(id),
    refetchOnMount: options?.refetchOnMount ?? true,
    refetchOnWindowFocus: false,
    staleTime: options?.staleTime,
  });
}

export function useThreadStorageFiles(
  id: string,
  listOptions: ThreadStorageFileListOptions,
  options?: QueryOptions,
) {
  return useQuery<ThreadStorageFileListResponse>({
    queryKey: threadStorageFilesQueryKey(id, listOptions),
    queryFn: ({ signal }) =>
      api.listThreadStorageFiles({
        id: requireThreadId(id, "useThreadStorageFiles"),
        options: listOptions,
        signal,
      }),
    enabled: (options?.enabled ?? true) && Boolean(id),
    refetchOnWindowFocus: false,
  });
}

export function useThreadStorageFilePreview(
  id: string,
  path: string | null,
  options?: QueryOptions,
) {
  return useQuery<FilePreview>({
    queryKey: threadStorageFilePreviewQueryKey(id, path),
    queryFn: ({ signal }) =>
      api.getThreadStorageFilePreview(
        requireThreadId(id, "useThreadStorageFilePreview"),
        path ?? "",
        signal,
      ),
    enabled: (options?.enabled ?? true) && Boolean(id) && Boolean(path),
    refetchOnWindowFocus: false,
  });
}

export function useThreadHostFilePreview(
  id: string,
  environmentId: string | null | undefined,
  path: string | null,
  options?: QueryOptions,
) {
  return useQuery<FilePreview>({
    queryKey: threadHostFilePreviewQueryKey(id, environmentId, path),
    queryFn: ({ signal }) =>
      api.getThreadHostFilePreview(
        requireThreadId(id, "useThreadHostFilePreview"),
        path ?? "",
        signal,
      ),
    enabled:
      (options?.enabled ?? true) &&
      Boolean(id) &&
      Boolean(environmentId) &&
      Boolean(path),
    refetchOnWindowFocus: false,
  });
}

export function useThreadTimeline(
  id: string,
  options?: {
    enabled?: boolean;
    refetchOnMount?: boolean | "always";
    managerTimelineView?: ManagerTimelineView;
  },
) {
  const managerTimelineView = options?.managerTimelineView;

  return useQuery<ThreadTimelineResponse>({
    queryKey: threadTimelineQueryKey(id, managerTimelineView),
    queryFn: () =>
      api.getThreadTimeline({
        id: requireThreadId(id, "useThreadTimeline"),
        managerTimelineView,
      }),
    enabled: (options?.enabled ?? true) && Boolean(id),
    refetchOnMount: options?.refetchOnMount ?? true,
    placeholderData: (previousData, previousQuery) =>
      resolveThreadTimelinePlaceholder(
        previousData,
        previousQuery?.queryKey,
        id,
        managerTimelineView,
      ),
  });
}

export function useThreadTimelineTurnSummaryDetails() {
  return useMutation({
    meta: {
      errorMessage: "Failed to load turn summary details.",
      showErrorToast: false,
    },
    mutationFn: (
      request: ThreadTimelineTurnSummaryDetailsMutationRequest,
    ): Promise<TimelineTurnSummaryDetailsResponse> =>
      api.getThreadTimelineTurnSummaryDetails(request),
  });
}

export function getLatestPendingInteraction(
  interactions: readonly PendingInteraction[] | undefined,
): PendingInteraction | null {
  if (!interactions || interactions.length === 0) {
    return null;
  }

  const [firstInteraction, ...restInteractions] = interactions;
  return restInteractions.reduce<PendingInteraction>(
    (latest, interaction) =>
      interaction.createdAt > latest.createdAt ? interaction : latest,
    firstInteraction,
  );
}
