import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Thread, ThreadQueuedMessage } from "@bb/domain";
import type {
  CreateDraftRequest,
  CreateThreadRequest,
  SendDraftResponse,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import { wsManager } from "@/lib/ws";
import type { SendThreadMessageMutationRequest } from "./mutation-request-types";
import {
  getPrimaryCheckoutWorkspaceStateInvalidationQueryKeys,
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
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to create thread.",
    },
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
      for (const queryKey of getPrimaryCheckoutWorkspaceStateInvalidationQueryKeys()) {
        queryClient.invalidateQueries({ queryKey });
      }
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
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to queue follow-up.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      input,
      model,
      serviceTier,
      reasoningLevel,
      permissionMode,
    }: CreateThreadDraftMutationRequest): Promise<ThreadQueuedMessage> =>
      api.createThreadDraft(id, {
        input,
        model,
        serviceTier,
        reasoningLevel,
        permissionMode,
      }),
    onSuccess: (_queuedMessage, variables) => {
      queryClient.invalidateQueries({ queryKey: threadQueryKey(variables.id) });
      queryClient.invalidateQueries({ queryKey: threadDraftsQueryKey(variables.id) });
    },
  });
}

export function useSendThreadDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to send queued follow-up.",
      showErrorToast: false,
    },
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
      for (const queryKey of getPrimaryCheckoutWorkspaceStateInvalidationQueryKeys()) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useDeleteThreadDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to delete queued follow-up.",
      showErrorToast: false,
    },
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
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to stop thread.",
    },
    mutationFn: (threadId: string) => api.stopThread(threadId),
    onSuccess: (_data, threadId) => {
      queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });
      queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: statusQueryKey() });
    },
  });
}
