import { useMutation } from "@tanstack/react-query";
import type { Thread, ThreadQueuedMessage } from "@bb/domain";
import type {
  CreateDraftRequest,
  CreateThreadRequest,
  SendDraftResponse,
  SendMessageRequest,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import { wsManager } from "@/lib/ws";
import {
  optimisticallyInsertThread,
  updateCachedThread,
} from "../queries/query-cache";
import {
  statusQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadDraftsQueryKey,
  threadQueryKey,
  threadTimelineQueryKeyPrefix,
  threadsQueryKey,
} from "../queries/query-keys";
import { useApiClient } from "../queries/query-client";

interface SendThreadMessageMutationRequest extends SendMessageRequest {
  id: string;
}

interface CreateThreadDraftMutationRequest extends CreateDraftRequest {
  id: string;
}

interface SendThreadDraftMutationRequest {
  id: string;
  queuedMessageId: string;
}

interface DeleteThreadDraftMutationRequest {
  id: string;
  queuedMessageId: string;
}

export function useCreateThread() {
  const queryClient = useApiClient();

  return useMutation({
    mutationFn: (request: CreateThreadRequest) => api.createThread(request),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: threadsQueryKey() });
    },
    onSuccess: (thread) => {
      queryClient.setQueryData<Thread>(threadQueryKey(thread.id), thread);
      optimisticallyInsertThread(queryClient, thread);

      void queryClient.refetchQueries({
        queryKey: threadsQueryKey(),
        type: "active",
      });
      queryClient.invalidateQueries({ queryKey: statusQueryKey() });
    },
  });
}

export function useSendThreadMessage() {
  const queryClient = useApiClient();

  return useMutation({
    mutationFn: ({
      id,
      input,
      model,
      serviceTier,
      reasoningLevel,
      sandboxMode,
      mode,
    }: SendThreadMessageMutationRequest) =>
      api.sendThreadMessage(id, {
        input,
        model,
        serviceTier,
        reasoningLevel,
        sandboxMode,
        mode,
      }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: threadQueryKey(variables.id) });

      const previousThread = queryClient.getQueryData<Thread>(threadQueryKey(variables.id));
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
      if (!context?.previousThread) {
        return;
      }

      queryClient.setQueryData<Thread>(threadQueryKey(variables.id), context.previousThread);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: threadDefaultExecutionOptionsQueryKey(variables.id),
      });
      if (wsManager.getConnectionState() !== "connected") {
        queryClient.invalidateQueries({ queryKey: threadQueryKey(variables.id) });
        queryClient.invalidateQueries({
          queryKey: threadTimelineQueryKeyPrefix(variables.id),
        });
        queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
        queryClient.invalidateQueries({ queryKey: statusQueryKey() });
      }
    },
  });
}

export function useCreateThreadDraft() {
  const queryClient = useApiClient();

  return useMutation({
    mutationFn: ({
      id,
      input,
      model,
      serviceTier,
      reasoningLevel,
      sandboxMode,
    }: CreateThreadDraftMutationRequest): Promise<ThreadQueuedMessage> =>
      api.createThreadDraft(id, {
        input,
        model,
        serviceTier,
        reasoningLevel,
        sandboxMode,
      }),
    onSuccess: (_queuedMessage, variables) => {
      queryClient.invalidateQueries({ queryKey: threadQueryKey(variables.id) });
      queryClient.invalidateQueries({ queryKey: threadDraftsQueryKey(variables.id) });
    },
  });
}

export function useSendThreadDraft() {
  const queryClient = useApiClient();

  return useMutation({
    mutationFn: ({
      id,
      queuedMessageId,
    }: SendThreadDraftMutationRequest): Promise<SendDraftResponse> =>
      api.sendThreadDraft(id, queuedMessageId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: threadQueryKey(variables.id) });
      queryClient.invalidateQueries({ queryKey: threadDraftsQueryKey(variables.id) });
      queryClient.invalidateQueries({ queryKey: threadTimelineQueryKeyPrefix(variables.id) });
      queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: statusQueryKey() });
    },
  });
}

export function useDeleteThreadDraft() {
  const queryClient = useApiClient();

  return useMutation({
    mutationFn: ({
      id,
      queuedMessageId,
    }: DeleteThreadDraftMutationRequest) => api.deleteThreadDraft(id, queuedMessageId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: threadQueryKey(variables.id) });
      queryClient.invalidateQueries({ queryKey: threadDraftsQueryKey(variables.id) });
    },
  });
}

export function useStopThread() {
  const queryClient = useApiClient();

  return useMutation({
    mutationFn: (threadId: string) => api.stopThread(threadId),
    onSuccess: (_data, threadId) => {
      queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });
      queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: statusQueryKey() });
    },
  });
}
