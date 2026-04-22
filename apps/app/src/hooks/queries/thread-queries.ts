import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PendingInteraction,
  ResolvedThreadExecutionOptions,
  Thread,
} from "@bb/domain";
import type {
  ThreadDraftListResponse,
  ThreadListResponse,
  ThreadPendingInteractionsResponse,
  ThreadTimelineResponse,
  TimelineTurnSummaryDetailsResponse,
  WorkspaceFileListResponse,
} from "@bb/server-contract";
import type { ThreadListFilters, FilePreview } from "@/lib/api";
import * as api from "@/lib/api";
import { getCachedThreadListPlaceholder } from "./query-cache";
import {
  resolveThreadPlaceholder,
  resolveThreadTimelinePlaceholder,
} from "./query-placeholders";
import {
  threadDefaultExecutionOptionsQueryKey,
  threadDraftsQueryKey,
  threadListQueryKey,
  threadPendingInteractionsQueryKey,
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
  "projectId"
> {
  projectId?: string;
}

interface ThreadTimelineTurnSummaryDetailsRequest {
  id: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  includeAllEvents?: boolean;
}

function requireThreadId(id: string, hookName: string): string {
  if (!id) {
    throw new Error(`${hookName}: thread id is required when query is enabled`);
  }

  return id;
}

export function useThreads(filters: UseThreadsFilters, options?: QueryOptions) {
  const { projectId, ...rest } = filters;

  return useQuery<ThreadListResponse>({
    queryKey: threadListQueryKey(projectId ? { ...rest, projectId } : rest),
    queryFn: ({ signal }) =>
      api.listThreads(
        {
          ...rest,
          projectId: requireThreadId(projectId ?? "", "useThreads"),
        },
        signal,
      ),
    enabled: (options?.enabled ?? true) && Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useThread(id: string, options?: RefetchOnMountOptions) {
  const queryClient = useQueryClient();

  return useQuery<Thread>({
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

export function useThreadStorageFiles(id: string, options?: QueryOptions) {
  return useQuery<WorkspaceFileListResponse>({
    queryKey: threadStorageFilesQueryKey(id),
    queryFn: () =>
      api.listThreadStorageFiles(requireThreadId(id, "useThreadStorageFiles")),
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
    includeAllEvents?: boolean;
  },
) {
  const includeAllEvents = options?.includeAllEvents ?? false;

  return useQuery<ThreadTimelineResponse>({
    queryKey: threadTimelineQueryKey(id, includeAllEvents),
    queryFn: () =>
      api.getThreadTimeline(
        requireThreadId(id, "useThreadTimeline"),
        false,
        includeAllEvents,
      ),
    enabled: (options?.enabled ?? true) && Boolean(id),
    refetchOnMount: options?.refetchOnMount ?? true,
    placeholderData: (previousData, previousQuery) =>
      resolveThreadTimelinePlaceholder(
        previousData,
        previousQuery?.queryKey,
        id,
      ),
  });
}

export function useThreadTimelineTurnSummaryDetails() {
  return useMutation({
    meta: {
      errorMessage: "Failed to load turn summary details.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      sourceSeqStart,
      sourceSeqEnd,
      includeAllEvents,
    }: ThreadTimelineTurnSummaryDetailsRequest): Promise<TimelineTurnSummaryDetailsResponse> =>
      api.getThreadTimelineTurnSummaryDetails(
        id,
        sourceSeqStart,
        sourceSeqEnd,
        includeAllEvents ?? false,
      ),
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
