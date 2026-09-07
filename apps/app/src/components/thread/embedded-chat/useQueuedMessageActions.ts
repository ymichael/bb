import { useCallback, useMemo, useRef, useState } from "react";
import type { PromptInput, ThreadQueuedMessage } from "@bb/domain";
import type { SendQueuedMessageMode } from "@bb/server-contract";
import type {
  QueuedMessageGroupBoundaryRequest,
  QueuedMessageProcessingAction,
} from "@/components/promptbox/banner/QueuedMessagesList";
import {
  useDeleteThreadQueuedMessage,
  useReorderThreadQueuedMessage,
  useSendThreadQueuedMessage,
  useSetThreadQueuedMessageGroupBoundary,
  useUpdateThreadQueuedMessage,
} from "@/hooks/mutations/thread-runtime-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import type { QueuedMessageReorderRequest } from "@/lib/queued-message-reorder";
import { appToast } from "@/components/ui/app-toast";
import { BbHttpError } from "@/lib/sdk";
import type { InlineQueuedMessageEditState } from "./useInlineQueuedMessageEditing";

type QueuedMessageSendGuard = "current-head" | "exists" | "none";

interface SendQueuedMessageByIdArgs {
  guard: QueuedMessageSendGuard;
  messageId: string;
  mode: SendQueuedMessageMode;
}

interface UseQueuedMessageActionsArgs {
  threadId: string;
  queuedMessages: readonly ThreadQueuedMessage[];
  sendProcessingPersistence: "clear-on-settle" | "until-left-queue";
  onSendSuccess?: () => void;
  onSaveSuccess?: () => void;
  inlineEditingQueuedMessage: InlineQueuedMessageEditState | null;
  dismissInlineQueuedMessageEditor: () => void;
  activeComposerDraftInput: PromptInput[];
}

interface UseQueuedMessageActionsResult {
  processingQueuedMessage: {
    action: QueuedMessageProcessingAction;
    id: string;
  } | null;
  queuedMessageActionPending: boolean;
  isUpdateQueuedMessagePending: boolean;
  sendQueuedMessageById: (args: SendQueuedMessageByIdArgs) => Promise<void>;
  handleSaveInlineQueuedMessage: () => Promise<void>;
  handleDeleteQueuedMessage: (queuedMessageId: string) => void;
  handleReorderQueuedMessage: (request: QueuedMessageReorderRequest) => void;
  handleSetQueuedMessageGroupBoundary: (
    request: QueuedMessageGroupBoundaryRequest,
  ) => void;
}

export function useQueuedMessageActions({
  threadId,
  queuedMessages,
  sendProcessingPersistence,
  onSendSuccess,
  onSaveSuccess,
  inlineEditingQueuedMessage,
  dismissInlineQueuedMessageEditor,
  activeComposerDraftInput,
}: UseQueuedMessageActionsArgs): UseQueuedMessageActionsResult {
  const updateQueuedMessage = useUpdateThreadQueuedMessage();
  const sendQueuedMessage = useSendThreadQueuedMessage();
  const deleteQueuedMessage = useDeleteThreadQueuedMessage();
  const reorderQueuedMessage = useReorderThreadQueuedMessage();
  const setQueuedMessageGroupBoundary =
    useSetThreadQueuedMessageGroupBoundary();
  const [processingQueuedMessage, setProcessingQueuedMessage] = useState<{
    action: QueuedMessageProcessingAction;
    id: string;
  } | null>(null);
  const queuedMessagesRef = useRef<readonly ThreadQueuedMessage[]>([]);
  queuedMessagesRef.current = queuedMessages;

  const displayedProcessingQueuedMessage = useMemo(
    () =>
      sendProcessingPersistence === "until-left-queue"
        ? processingQueuedMessage &&
          queuedMessages.some(
            (message) => message.id === processingQueuedMessage.id,
          )
          ? processingQueuedMessage
          : null
        : processingQueuedMessage,
    [processingQueuedMessage, queuedMessages, sendProcessingPersistence],
  );

  const sendQueuedMessageById = useCallback(
    async ({ guard, messageId, mode }: SendQueuedMessageByIdArgs) => {
      if (
        guard !== "none" &&
        !queuedMessagesRef.current.some((message) => message.id === messageId)
      ) {
        return;
      }
      if (
        guard === "current-head" &&
        queuedMessagesRef.current[0]?.id !== messageId
      ) {
        return;
      }

      setProcessingQueuedMessage({ id: messageId, action: "send" });
      try {
        await sendQueuedMessage.mutateAsync({
          id: threadId,
          mode,
          queuedMessageId: messageId,
        });
        onSendSuccess?.();
        if (
          mode === "steer" ||
          sendProcessingPersistence === "clear-on-settle"
        ) {
          setProcessingQueuedMessage((current) =>
            current?.id === messageId ? null : current,
          );
        }
      } catch (error) {
        appToast.error(
          getMutationErrorMessage({
            error,
            fallbackMessage: "Failed to send queued message",
            lifecycleOperation: "send_queued_message",
          }),
        );
        setProcessingQueuedMessage((current) =>
          current?.id === messageId ? null : current,
        );
      }
    },
    [onSendSuccess, sendProcessingPersistence, sendQueuedMessage, threadId],
  );

  const handleSaveInlineQueuedMessage = useCallback(async () => {
    if (
      !inlineEditingQueuedMessage ||
      activeComposerDraftInput.length === 0 ||
      updateQueuedMessage.isPending
    ) {
      return;
    }
    if (
      inlineEditingQueuedMessage.ownerThreadId !== threadId ||
      !queuedMessagesRef.current.some(
        (message) => message.id === inlineEditingQueuedMessage.queuedMessageId,
      )
    ) {
      dismissInlineQueuedMessageEditor();
      return;
    }
    const { expectedUpdatedAt, ownerThreadId, queuedMessageId } =
      inlineEditingQueuedMessage;
    setProcessingQueuedMessage({ id: queuedMessageId, action: "edit" });
    try {
      await updateQueuedMessage.mutateAsync({
        expectedUpdatedAt,
        id: ownerThreadId,
        input: activeComposerDraftInput,
        queuedMessageId,
      });
      onSaveSuccess?.();
      dismissInlineQueuedMessageEditor();
    } catch (error) {
      if (error instanceof BbHttpError && error.status === 404) {
        dismissInlineQueuedMessageEditor();
      }
      appToast.error(
        getMutationErrorMessage({
          error,
          fallbackMessage: "Failed to update queued message",
          lifecycleOperation: "update_queued_message",
        }),
      );
    } finally {
      setProcessingQueuedMessage((current) =>
        current?.id === queuedMessageId ? null : current,
      );
    }
  }, [
    activeComposerDraftInput,
    dismissInlineQueuedMessageEditor,
    inlineEditingQueuedMessage,
    onSaveSuccess,
    threadId,
    updateQueuedMessage,
  ]);

  const handleDeleteQueuedMessage = useCallback(
    (queuedMessageId: string) => {
      setProcessingQueuedMessage({ id: queuedMessageId, action: "delete" });
      void deleteQueuedMessage
        .mutateAsync({
          id: threadId,
          queuedMessageId,
        })
        .catch((error) => {
          appToast.error(
            getMutationErrorMessage({
              error,
              fallbackMessage: "Failed to delete queued message",
              lifecycleOperation: "queue_message",
            }),
          );
        })
        .finally(() => {
          setProcessingQueuedMessage((current) =>
            current?.id === queuedMessageId ? null : current,
          );
        });
    },
    [deleteQueuedMessage, threadId],
  );

  const handleReorderQueuedMessage = useCallback(
    (request: QueuedMessageReorderRequest) => {
      void reorderQueuedMessage
        .mutateAsync({
          ...request,
          id: threadId,
        })
        .catch((error) => {
          appToast.error(
            getMutationErrorMessage({
              error,
              fallbackMessage: "Failed to reorder queued message",
              lifecycleOperation: "reorder_queued_message",
            }),
          );
        });
    },
    [reorderQueuedMessage, threadId],
  );

  const handleSetQueuedMessageGroupBoundary = useCallback(
    (request: QueuedMessageGroupBoundaryRequest) => {
      void setQueuedMessageGroupBoundary
        .mutateAsync({
          id: threadId,
          ...request,
        })
        .catch((error) => {
          appToast.error(
            getMutationErrorMessage({
              error,
              fallbackMessage: "Failed to group queued messages",
              lifecycleOperation: "set_queued_message_group_boundary",
            }),
          );
        });
    },
    [setQueuedMessageGroupBoundary, threadId],
  );

  const queuedMessageActionPending =
    deleteQueuedMessage.isPending ||
    reorderQueuedMessage.isPending ||
    setQueuedMessageGroupBoundary.isPending ||
    sendQueuedMessage.isPending ||
    updateQueuedMessage.isPending;

  return {
    processingQueuedMessage: displayedProcessingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending: updateQueuedMessage.isPending,
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleDeleteQueuedMessage,
    handleReorderQueuedMessage,
    handleSetQueuedMessageGroupBoundary,
  };
}
