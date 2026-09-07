import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ThreadQueuedMessage } from "@bb/domain";
import type { QueuedMessageEditRequest } from "@/components/promptbox/banner/QueuedMessagesList";
import type { PromptDraftState } from "@bb/client-core";
import { queuedInputToDraft } from "@bb/client-core";
import type { InlineComposerDraftSession } from "./useActiveComposerDraft";

export interface InlineQueuedMessageEditState {
  draft: PromptDraftState;
  editSessionId: number;
  expectedUpdatedAt: number;
  model: ThreadQueuedMessage["model"];
  ownerThreadId: string;
  permissionMode: ThreadQueuedMessage["permissionMode"];
  queuedMessageId: string;
  queuedMessageIndex: number;
  reasoningLevel: ThreadQueuedMessage["reasoningLevel"];
  serviceTier: ThreadQueuedMessage["serviceTier"];
}

interface UseInlineQueuedMessageEditingArgs {
  ownerThreadId: string;
  queuedMessages: readonly ThreadQueuedMessage[];
  onBeginEdit?: () => void;
}

interface UseInlineQueuedMessageEditingResult {
  inlineEditingQueuedMessage: InlineQueuedMessageEditState | null;
  inlineEditingQueuedMessageRef: React.RefObject<InlineQueuedMessageEditState | null>;
  commitInlineQueuedMessage: (
    next: InlineQueuedMessageEditState | null,
  ) => void;
  updateInlineQueuedMessage: (
    updater: (
      current: InlineQueuedMessageEditState | null,
    ) => InlineQueuedMessageEditState | null,
  ) => void;
  dismissInlineQueuedMessageEditor: () => void;
  beginEditQueuedMessage: (request: QueuedMessageEditRequest) => void;
  queuedMessageDraftSession: InlineComposerDraftSession | null;
}

export function useInlineQueuedMessageEditing({
  ownerThreadId,
  queuedMessages,
  onBeginEdit,
}: UseInlineQueuedMessageEditingArgs): UseInlineQueuedMessageEditingResult {
  const [inlineEditingQueuedMessageState, setInlineEditingQueuedMessage] =
    useState<InlineQueuedMessageEditState | null>(null);
  const inlineEditingQueuedMessageRef =
    useRef<InlineQueuedMessageEditState | null>(null);
  const inlineEditSessionIdRef = useRef(0);

  const queuedMessagesByIdRef = useRef<
    ReadonlyMap<string, ThreadQueuedMessage>
  >(new Map());
  queuedMessagesByIdRef.current = useMemo(() => {
    const next = new Map<string, ThreadQueuedMessage>();
    for (const message of queuedMessages) {
      next.set(message.id, message);
    }
    return next;
  }, [queuedMessages]);

  const commitInlineQueuedMessage = useCallback(
    (next: InlineQueuedMessageEditState | null) => {
      inlineEditingQueuedMessageRef.current = next;
      setInlineEditingQueuedMessage(next);
    },
    [],
  );
  const updateInlineQueuedMessage = useCallback(
    (
      updater: (
        current: InlineQueuedMessageEditState | null,
      ) => InlineQueuedMessageEditState | null,
    ) => {
      setInlineEditingQueuedMessage((current) => {
        const next = updater(current);
        inlineEditingQueuedMessageRef.current = next;
        return next;
      });
    },
    [],
  );
  const dismissInlineQueuedMessageEditor = useCallback(() => {
    commitInlineQueuedMessage(null);
  }, [commitInlineQueuedMessage]);

  const inlineEditingQueuedMessage = useMemo(
    () =>
      inlineEditingQueuedMessageState !== null &&
      inlineEditingQueuedMessageState.ownerThreadId === ownerThreadId &&
      queuedMessages.some(
        (message) =>
          message.id === inlineEditingQueuedMessageState.queuedMessageId,
      )
        ? inlineEditingQueuedMessageState
        : null,
    [inlineEditingQueuedMessageState, ownerThreadId, queuedMessages],
  );
  useEffect(() => {
    if (
      inlineEditingQueuedMessageState !== null &&
      inlineEditingQueuedMessage === null
    ) {
      dismissInlineQueuedMessageEditor();
    }
  }, [
    dismissInlineQueuedMessageEditor,
    inlineEditingQueuedMessage,
    inlineEditingQueuedMessageState,
  ]);

  const beginEditQueuedMessage = useCallback(
    ({ queuedMessageId, queuedMessageIndex }: QueuedMessageEditRequest) => {
      const queuedMessage = queuedMessagesByIdRef.current.get(queuedMessageId);
      if (!queuedMessage) {
        return;
      }
      commitInlineQueuedMessage({
        draft: queuedInputToDraft(queuedMessage.content),
        editSessionId: (inlineEditSessionIdRef.current += 1),
        expectedUpdatedAt: queuedMessage.updatedAt,
        model: queuedMessage.model,
        ownerThreadId,
        permissionMode: queuedMessage.permissionMode,
        queuedMessageId,
        queuedMessageIndex,
        reasoningLevel: queuedMessage.reasoningLevel,
        serviceTier: queuedMessage.serviceTier,
      });
      onBeginEdit?.();
    },
    [commitInlineQueuedMessage, onBeginEdit, ownerThreadId],
  );

  const editSessionId = inlineEditingQueuedMessage?.editSessionId ?? null;
  const queuedMessageDraftSession =
    useMemo<InlineComposerDraftSession | null>(() => {
      if (editSessionId === null) {
        return null;
      }
      return {
        editSessionId,
        setDraft: (update) => {
          const current = inlineEditingQueuedMessageRef.current;
          if (current === null) return;
          commitInlineQueuedMessage({
            ...current,
            draft: update(current.draft),
          });
        },
      };
    }, [commitInlineQueuedMessage, editSessionId]);

  return {
    inlineEditingQueuedMessage,
    inlineEditingQueuedMessageRef,
    commitInlineQueuedMessage,
    updateInlineQueuedMessage,
    dismissInlineQueuedMessageEditor,
    beginEditQueuedMessage,
    queuedMessageDraftSession,
  };
}
