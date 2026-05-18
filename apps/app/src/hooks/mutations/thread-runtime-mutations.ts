import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import {
  type PromptHistoryEntry,
  type ThreadWithRuntime,
  type ThreadQueuedMessage,
} from "@bb/domain";
import type {
  PromptHistoryResponse,
  CreateQueuedMessageRequest,
  SendQueuedMessageMode,
  SendQueuedMessageResponse,
  TimelineConversationAttachments,
  TimelineRow,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import type { AppCreateThreadRequest } from "@/lib/api";
import { prependPromptHistoryEntry } from "@/lib/prompt-history";
import { wsManager } from "@/lib/ws";
import { collectPromptAttachments } from "@/lib/prompt-attachments";
import type { SendThreadMessageMutationRequest } from "./mutation-request-types";
import {
  insertOptimisticTimelineRow,
  optimisticallyInsertThread,
  removeOptimisticTimelineRow,
  updateCachedThread,
} from "../queries/query-cache";
import {
  applyToCachedThreadLists,
  getCachedThreadLists,
  type ThreadListCacheData,
} from "../queries/thread-list-cache-data";
import {
  projectPromptHistoryQueryKey,
  threadQueryKey,
  threadPromptHistoryQueryKey,
  threadsQueryKey,
  threadTimelineQueryKeyPrefix,
} from "../queries/query-keys";
import {
  invalidateProjectPromptHistoryQueries,
  refetchThreadListsAfterComposerThreadCreate,
  invalidateThreadQueuedMessageSendQueries,
  invalidateThreadAcceptedMessageQueries,
  invalidateThreadAcceptedMessageQueriesWithoutRealtime,
  invalidateThreadQueueQueries,
  invalidateThreadStopQueries,
} from "../cache-effects";

interface CreateThreadQueuedMessageMutationRequest extends CreateQueuedMessageRequest {
  id: string;
}

interface SendThreadQueuedMessageMutationRequest {
  id: string;
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
}

interface DeleteThreadQueuedMessageMutationRequest {
  id: string;
  queuedMessageId: string;
}

interface ThreadListSnapshotEntry {
  queryKey: QueryKey;
  data: ThreadListCacheData;
}

type ThreadListSnapshot = ThreadListSnapshotEntry[];

interface StopThreadMutationContext {
  previousThread: ThreadWithRuntime | undefined;
  previousThreadLists: ThreadListSnapshot;
}

interface ApplyOptimisticStopRequestArgs {
  queryClient: QueryClient;
  requestedAt: number;
  threadId: string;
}

function buildAcceptedPromptHistoryEntry(args: {
  createdAt: number;
  input: PromptHistoryEntry["input"];
}): PromptHistoryEntry {
  return {
    id: `optimistic-prompt-history:${nanoid()}`,
    createdAt: args.createdAt,
    input: args.input,
  };
}

function buildQueuedPromptHistoryEntry(
  queuedMessage: ThreadQueuedMessage,
): PromptHistoryEntry {
  return {
    id: `queued-message:${queuedMessage.id}`,
    createdAt: queuedMessage.createdAt,
    input: queuedMessage.content,
  };
}

function prependProjectPromptHistory(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  entry: PromptHistoryEntry,
): void {
  queryClient.setQueryData<PromptHistoryResponse>(
    projectPromptHistoryQueryKey(projectId),
    (currentEntries) => prependPromptHistoryEntry(currentEntries, entry),
  );
}

function prependThreadPromptHistory(
  queryClient: ReturnType<typeof useQueryClient>,
  threadId: string,
  entry: PromptHistoryEntry,
): void {
  queryClient.setQueryData<PromptHistoryResponse>(
    threadPromptHistoryQueryKey(threadId),
    (currentEntries) => prependPromptHistoryEntry(currentEntries, entry),
  );
}

function snapshotThreadLists(queryClient: QueryClient): ThreadListSnapshot {
  return getCachedThreadLists(queryClient, { queryKey: threadsQueryKey() });
}

function restoreThreadLists(
  queryClient: QueryClient,
  threadLists: ThreadListSnapshot,
): void {
  for (const { queryKey, data } of threadLists) {
    queryClient.setQueryData(queryKey, data);
  }
}

function applyOptimisticStopRequest({
  queryClient,
  requestedAt,
  threadId,
}: ApplyOptimisticStopRequestArgs): void {
  updateCachedThread(queryClient, threadId, (thread) => ({
    ...thread,
    stopRequestedAt: thread.stopRequestedAt ?? requestedAt,
    updatedAt: Math.max(thread.updatedAt, requestedAt),
  }));

  applyToCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
    mapper: (list) =>
      list.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              stopRequestedAt: thread.stopRequestedAt ?? requestedAt,
              updatedAt: Math.max(thread.updatedAt, requestedAt),
            }
          : thread,
      ),
  });
}

export function useCreateThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to create thread.",
    },
    mutationFn: (request: AppCreateThreadRequest) => api.createThread(request),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: threadsQueryKey() });
    },
    onSuccess: (thread, variables) => {
      queryClient.setQueryData<ThreadWithRuntime>(
        threadQueryKey(thread.id),
        thread,
      );
      optimisticallyInsertThread(queryClient, thread);
      prependProjectPromptHistory(
        queryClient,
        variables.projectId,
        buildAcceptedPromptHistoryEntry({
          createdAt: thread.createdAt,
          input: variables.input,
        }),
      );
      invalidateProjectPromptHistoryQueries({
        queryClient,
        projectId: variables.projectId,
      });
      refetchThreadListsAfterComposerThreadCreate({ queryClient });
    },
  });
}

interface BuildOptimisticUserMessageRowParams {
  createdAt: number;
  input: SendThreadMessageMutationRequest["input"];
  mode: SendThreadMessageMutationRequest["mode"];
  threadId: string;
  threadStatus: ThreadWithRuntime["status"] | null;
}

type OptimisticUserRequestKind = "message" | "steer";
type OptimisticUserRequestKindArgs = Pick<
  BuildOptimisticUserMessageRowParams,
  "mode" | "threadStatus"
>;

function optimisticUserRequestKind({
  mode,
  threadStatus,
}: OptimisticUserRequestKindArgs): OptimisticUserRequestKind {
  if (mode === "steer") {
    return "steer";
  }
  if (mode === "auto" && threadStatus === "active") {
    return "steer";
  }
  return "message";
}

function buildOptimisticUserMessageRow({
  createdAt,
  input,
  mode,
  threadId,
  threadStatus,
}: BuildOptimisticUserMessageRowParams): TimelineRow {
  const id = `optimistic-user-${nanoid()}`;
  const text = input
    .filter(
      (entry): entry is Extract<typeof entry, { type: "text" }> =>
        entry.type === "text",
    )
    .map((entry) => entry.text)
    .join("\n\n");
  const attachments = collectPromptAttachments(input);
  const timelineAttachments: TimelineConversationAttachments | null =
    attachments
      ? {
          webImages: attachments.webImages,
          localImages: attachments.localImages,
          localFiles: attachments.localFiles,
          imageUrls: attachments.imageUrls ?? [],
          localImagePaths: attachments.localImagePaths ?? [],
          localFilePaths: attachments.localFilePaths ?? [],
        }
      : null;
  return {
    id,
    kind: "conversation",
    role: "user",
    threadId,
    turnId: null,
    sourceSeqStart: 0,
    sourceSeqEnd: 0,
    startedAt: createdAt,
    createdAt,
    text,
    attachments: timelineAttachments,
    userRequest: {
      kind: optimisticUserRequestKind({ mode, threadStatus }),
      status: "pending",
    },
  };
}

export function useSendThreadMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to send message.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      input,
      model,
      serviceTier,
      reasoningLevel,
      permissionMode,
      mode,
    }: SendThreadMessageMutationRequest) =>
      api.sendThreadMessage(id, {
        input,
        model,
        serviceTier,
        reasoningLevel,
        permissionMode,
        mode,
      }),
    onMutate: async (variables) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: threadQueryKey(variables.id) }),
        queryClient.cancelQueries({
          queryKey: threadTimelineQueryKeyPrefix(variables.id),
        }),
      ]);

      const previousThread = queryClient.getQueryData<ThreadWithRuntime>(
        threadQueryKey(variables.id),
      );
      const optimisticCreatedAt = Date.now();

      updateCachedThread(queryClient, variables.id, (thread) => ({
        ...thread,
        status: "active",
        updatedAt: Math.max(thread.updatedAt, optimisticCreatedAt),
        runtime: {
          ...thread.runtime,
          // Flip displayStatus so the working indicator mounts in the same
          // render as the optimistic user-message row. Without this, the
          // indicator waits for the server's runtime update and animates in
          // separately, looking like a two-step reveal. Preserve
          // host-reconnecting / waiting-for-host because they signal a known
          // host blocker — promoting them to "active" would lie about the
          // host's readiness to do work.
          displayStatus:
            thread.runtime.displayStatus === "host-reconnecting" ||
            thread.runtime.displayStatus === "waiting-for-host"
              ? thread.runtime.displayStatus
              : "active",
        },
      }));

      const optimisticRow = buildOptimisticUserMessageRow({
        createdAt: optimisticCreatedAt,
        input: variables.input,
        mode: variables.mode,
        threadId: variables.id,
        threadStatus: previousThread?.status ?? null,
      });
      insertOptimisticTimelineRow(queryClient, variables.id, optimisticRow);

      return {
        previousThread,
        optimisticCreatedAt,
        optimisticRowId: optimisticRow.id,
      };
    },
    onError: (_error, variables, context) => {
      if (context?.optimisticRowId) {
        removeOptimisticTimelineRow(
          queryClient,
          variables.id,
          context.optimisticRowId,
        );
      }
      if (!context?.previousThread) {
        return;
      }

      queryClient.setQueryData<ThreadWithRuntime>(
        threadQueryKey(variables.id),
        context.previousThread,
      );
    },
    onSuccess: (_data, variables, context) => {
      prependThreadPromptHistory(
        queryClient,
        variables.id,
        buildAcceptedPromptHistoryEntry({
          createdAt: context?.optimisticCreatedAt ?? Date.now(),
          input: variables.input,
        }),
      );
      const invalidateAcceptedMessageQueries =
        wsManager.getConnectionState() === "connected"
          ? invalidateThreadAcceptedMessageQueries
          : invalidateThreadAcceptedMessageQueriesWithoutRealtime;

      invalidateAcceptedMessageQueries({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useCreateThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to queue message.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      input,
      model,
      serviceTier,
      reasoningLevel,
      permissionMode,
    }: CreateThreadQueuedMessageMutationRequest): Promise<ThreadQueuedMessage> =>
      api.createThreadQueuedMessage(id, {
        input,
        model,
        serviceTier,
        reasoningLevel,
        permissionMode,
      }),
    onSuccess: (queuedMessage, variables) => {
      prependThreadPromptHistory(
        queryClient,
        variables.id,
        buildQueuedPromptHistoryEntry(queuedMessage),
      );
      invalidateThreadQueueQueries({ queryClient, threadId: variables.id });
    },
  });
}

export function useSendThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to send queued message.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      mode,
      queuedMessageId,
    }: SendThreadQueuedMessageMutationRequest): Promise<SendQueuedMessageResponse> =>
      api.sendThreadQueuedMessage(id, queuedMessageId, { mode }),
    onSuccess: (_data, variables) => {
      invalidateThreadQueuedMessageSendQueries({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useDeleteThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to delete queued message.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      queuedMessageId,
    }: DeleteThreadQueuedMessageMutationRequest) =>
      api.deleteThreadQueuedMessage(id, queuedMessageId),
    onSuccess: (_data, variables) => {
      invalidateThreadQueueQueries({ queryClient, threadId: variables.id });
    },
  });
}

export function useStopThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to stop thread.",
    },
    mutationFn: (threadId: string) => api.stopThread(threadId),
    onMutate: async (threadId) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) }),
        queryClient.cancelQueries({ queryKey: threadsQueryKey() }),
      ]);

      const previousThread = queryClient.getQueryData<ThreadWithRuntime>(
        threadQueryKey(threadId),
      );
      const previousThreadLists = snapshotThreadLists(queryClient);

      applyOptimisticStopRequest({
        queryClient,
        requestedAt: Date.now(),
        threadId,
      });

      return {
        previousThread,
        previousThreadLists,
      };
    },
    onError: (_error, threadId, context?: StopThreadMutationContext) => {
      if (!context) {
        return;
      }

      queryClient.setQueryData(
        threadQueryKey(threadId),
        context.previousThread,
      );
      restoreThreadLists(queryClient, context.previousThreadLists);
    },
    onSettled: (_data, _error, threadId) => {
      invalidateThreadStopQueries({ queryClient, threadId });
    },
  });
}
