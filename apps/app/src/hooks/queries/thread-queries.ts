import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PendingInteraction,
  ResolvedThreadExecutionOptions,
} from "@bb/domain";
import type {
  PromptHistoryResponse,
  ThreadDraftListResponse,
  ThreadListResponse,
  ManagerTimelineView,
  ThreadPendingInteractionsResponse,
  ThreadResponse,
  ThreadTimelineResponse,
  TimelineTurnSummaryDetailsRequest,
  TimelineTurnSummaryDetailsResponse,
  WorkspaceFileListResponse,
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
  disabledThreadListQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadDraftsQueryKey,
  threadListQueryKey,
  threadPendingInteractionsQueryKey,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadStorageFilesQueryKey,
  threadStorageFilePreviewQueryKey,
  threadTimelineQueryKey,
} from "./query-keys";

interface QueryOptions {
  enabled?: boolean;
}

interface RefetchOnMountOptions extends QueryOptions {
  refetchOnMount?: boolean | "always";
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

export function useThread(id: string, options?: RefetchOnMountOptions) {
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
    refetchOnWindowFocus: false,
  });
}

export function useThreadDrafts(id: string, options?: QueryOptions) {
  return useQuery<ThreadDraftListResponse>({
    queryKey: threadDraftsQueryKey(id),
    queryFn: () => api.listThreadDrafts(requireThreadId(id, "useThreadDrafts")),
    enabled: (options?.enabled ?? true) && Boolean(id),
    refetchOnWindowFocus: false,
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
    staleTime: 10_000,
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
    refetchOnWindowFocus: false,
  });
}

export function useThreadStorageFiles(
  id: string,
  listOptions: ThreadStorageFileListOptions,
  options?: QueryOptions,
) {
  return useQuery<WorkspaceFileListResponse>({
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
