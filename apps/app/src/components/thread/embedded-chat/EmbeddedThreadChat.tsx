import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { defaultAppSettings, type PromptInput } from "@bb/domain";
import type { SendMessageDelivery } from "@bb/server-contract";
import type {
  AttachmentsConfig,
  HistoryConfig,
} from "@/components/promptbox/PromptBoxInternal";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { cn } from "@bb/shared-ui/lib/utils";
import { Button } from "@bb/shared-ui/button";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  FollowUpPromptBox,
  type FollowUpComposerProps,
} from "@/components/promptbox/FollowUpPromptBox";
import {
  useComposerHostDraftNotifier,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import { ThreadPendingInteractionBanner } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import {
  QueuedMessagesList,
  type QueuedMessageInlineEditor,
} from "@/components/promptbox/banner/QueuedMessagesList";
import type {
  ExecutionControlsProps,
  ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import { OverflowFade } from "@/components/ui/overflow-fade";
import {
  ThreadTimelinePanelContent,
  ThreadTimelineSurface,
  type ThreadTimelineAddToChatHandler,
  type ThreadTimelineConsumerMessageAction,
  type ThreadTimelineLinkHandler,
  type ThreadTimelineLocalFileLinkHandler,
  type ThreadTimelineSurfaceProps,
} from "@/components/thread/timeline";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import {
  getLatestPendingInteraction,
  isPendingInteractionStateUnknown,
  useThread,
  useThreadPendingInteractions,
  useThreadQueuedMessages,
} from "@/hooks/queries/thread-queries";
import { useThreadDefaultExecutionOptions } from "@/hooks/queries/thread-default-execution-options-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  useCreateThreadQueuedMessage,
  useSendThreadMessage,
  useStopThread,
} from "@/hooks/mutations/thread-runtime-mutations";
import { useMarkThreadRead } from "@/hooks/mutations/thread-state-mutations";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import { useComposerTextEffects } from "@/lib/composer-text-effects";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import type { PromptDraftScope } from "@/hooks/usePromptDraftStorage";
import { appToast } from "@/components/ui/app-toast";
import {
  buildSideChatSubmitMode,
  canSubmitFollowUpShortcut,
  shouldQueueFollowUpMessage,
} from "@bb/client-core";
import { useActiveComposerDraft } from "./useActiveComposerDraft";
import { useComposerAttachmentUploads } from "./useComposerAttachmentUploads";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useComposerTypeahead } from "./useComposerTypeahead";
import { useInlineQueuedMessageEditing } from "./useInlineQueuedMessageEditing";
import { useQueuedMessageActions } from "./useQueuedMessageActions";

function reportQueuedSendDelivery(delivery: SendMessageDelivery): void {
  if (delivery !== "queued") {
    return;
  }
  appToast.message(
    "Message queued until this thread can take it. It sends by itself; do not send it again.",
  );
}

let pluginComposerHostOwnershipSequence = 0;

function createPluginComposerHostIdentity(scopeIdentity: string): string {
  pluginComposerHostOwnershipSequence += 1;
  return `${scopeIdentity}:ownership:${pluginComposerHostOwnershipSequence}`;
}

interface EmbeddedThreadChatLabels {
  placeholder: string;
  stopping: string;
  provisioning: string;
  sendError: string;
}

const DEFAULT_LABELS: EmbeddedThreadChatLabels = {
  placeholder: "Reply…",
  stopping: "Stopping thread...",
  provisioning: "Provisioning thread...",
  sendError: "Failed to send message",
};

type PendingInteractionsQueryBannerProps =
  | { state: "loading" }
  | { state: "error"; isRetrying: boolean; onRetry: () => void };

function PendingInteractionsQueryBanner(
  props: PendingInteractionsQueryBannerProps,
) {
  const isError = props.state === "error";
  return (
    <div
      className={cn(
        "mb-2 flex min-w-0 max-w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface-recessed px-4 py-3 text-xs text-muted-foreground",
        isError &&
          "border-surface-destructive-border bg-surface-destructive text-destructive-text",
      )}
      role={isError ? "alert" : "status"}
    >
      <span>
        {isError
          ? "Couldn't check pending interactions."
          : "Checking pending interactions…"}
      </span>
      {props.state === "error" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.isRetrying}
          onClick={props.onRetry}
          className="h-7 cursor-pointer px-2"
        >
          {props.isRetrying ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}

interface EmbeddedThreadChatComposerProps {
  draftScope: PromptDraftScope;
  executionDefaultsThreadId: string;
  executionResetKey: string;
  executionEnvironmentId?: string;
  executionEnvironmentHostId?: string;
  permissionPolicy: "editable" | "snapshot";
  environmentSummary: ReactNode;
  pluginComposerBottomScope?: PluginComposerHost["scope"] | null;
  composerIdentity?: string;
  focusRequestKey?: number;
}

interface EmbeddedThreadChatSharedProps {
  threadId: string;
  projectId: string;
  providerId: string;
  promptContextEnvironmentId: string | null;
  resolveMentionLink: PromptMentionLinkResolver;
  leadingContent?: ReactNode;
  consumerMessageActions?: readonly ThreadTimelineConsumerMessageAction[];
  includePluginMessageActions?: boolean;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  workspaceRootPath?: string;
  layout?: "contained" | "document";
  measure?: "panel" | "page";
}

interface EmbeddedThreadChatComposerModeProps extends EmbeddedThreadChatSharedProps {
  variant: "compact";
  surfaceTone?: "background" | "sidebar";
  composer: EmbeddedThreadChatComposerProps;
  footer?: never;
}

interface EmbeddedThreadChatHostedFooterProps {
  variant: "hosted-footer";
  footer: ReactNode;
  scrollOverlay?: ReactNode;
  surface: ThreadTimelineSurfaceProps;
  composer?: never;
}

type EmbeddedThreadChatProps =
  | EmbeddedThreadChatComposerModeProps
  | EmbeddedThreadChatHostedFooterProps;

export function EmbeddedThreadChat(props: EmbeddedThreadChatProps) {
  if (props.variant === "hosted-footer") {
    return <EmbeddedThreadChatHostedFooter {...props} />;
  }
  return <EmbeddedThreadChatWithComposer {...props} />;
}

function EmbeddedThreadChatHostedFooter({
  footer,
  scrollOverlay,
  surface,
}: EmbeddedThreadChatHostedFooterProps) {
  return (
    <div
      data-thread-window=""
      className="flex h-full min-h-0 min-w-0 flex-col overflow-clip"
    >
      <PageShell
        key={surface.threadId}
        scrollBehavior="bottom-anchor"
        scrollAnchorThreadId={surface.threadId}
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="gap-2 pt-4"
        footerClassName="chat-prompt-box"
        footer={footer}
        scrollOverlay={scrollOverlay}
      >
        <ThreadTimelineSurface {...surface} />
      </PageShell>
    </div>
  );
}

function EmbeddedThreadChatWithComposer({
  threadId,
  projectId,
  providerId,
  promptContextEnvironmentId,
  resolveMentionLink,
  leadingContent,
  consumerMessageActions,
  includePluginMessageActions,
  onOpenLink,
  onOpenLocalFileLink,
  workspaceRootPath,
  layout = "contained",
  measure = "panel",
  surfaceTone = "background",
  composer,
}: EmbeddedThreadChatComposerModeProps) {
  const labels = DEFAULT_LABELS;
  const systemConfigQuery = useSystemConfig();
  const steerActiveThreadOnEnter =
    systemConfigQuery.data?.generalSettings.steerActiveThreadOnEnter ??
    defaultAppSettings.steerActiveThreadOnEnter;
  const surfaceKey = threadId;
  const markThreadRead = useMarkThreadRead();
  const stopThread = useStopThread();
  const sendThreadMessage = useSendThreadMessage();
  const createQueuedMessage = useCreateThreadQueuedMessage();
  const threadQuery = useThread(threadId);
  const pendingInteractionsQuery = useThreadPendingInteractions(threadId);
  const activePendingInteraction = getLatestPendingInteraction(
    pendingInteractionsQuery.data,
  );
  const hasComposerBlockingPendingInteraction =
    activePendingInteraction !== null &&
    activePendingInteraction.payload.kind !== "plugin";
  const pendingInteractionsInitialLoading = isPendingInteractionStateUnknown(
    pendingInteractionsQuery.data,
    pendingInteractionsQuery.isFetching,
  );
  const pendingInteractionsUnavailable =
    activePendingInteraction === null && pendingInteractionsQuery.isError;
  const pendingInteractionOccupiesComposer =
    hasComposerBlockingPendingInteraction ||
    pendingInteractionsInitialLoading ||
    pendingInteractionsUnavailable;
  useThreadReadTracking({
    markThreadRead,
    thread: threadQuery.data,
  });
  const { data: queuedMessages = [] } = useThreadQueuedMessages(threadId);

  const executionOptionsQuery = useThreadDefaultExecutionOptions(
    composer.executionDefaultsThreadId,
    { enabled: true },
  );
  const defaultExecutionOptions = executionOptionsQuery.data;
  const threadCreationOptions = useThreadCreationOptions({
    enabled: true,
    scope: "component-local",
    environmentId: composer.executionEnvironmentId,
    environmentHostId: composer.executionEnvironmentHostId,
    resetKey: composer.executionResetKey,
    initialProviderId: providerId,
    initialModel: defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialPermissionMode: defaultExecutionOptions?.permissionMode,
  });
  const {
    executionOptionsRouting,
    selectedProviderId,
    providerOptions,
    hasMultipleProviders,
    selectedProviderComposerActions,
    selectedModel,
    setSelectedModel,
    serviceTier,
    setServiceTier,
    reasoningLevel,
    setReasoningLevel,
    permissionMode,
    setPermissionMode,
    activeModel,
    modelOptions,
    moreModelOptions,
    modelLoadFailed,
    modelLoadError,
    reasoningOptions,
    permissionModeOptions,
    supportsPermissionModeSelection,
    supportsServiceTier,
    serviceTierSupportByProvider,
    serviceTierFastLabel,
    isLoadingModels,
  } = threadCreationOptions;
  const selectedExecutionModel = activeModel?.model ?? selectedModel;
  const selectedExecutionServiceTier = supportsServiceTier
    ? serviceTier
    : undefined;
  const snapshotPermissionMode = defaultExecutionOptions?.permissionMode;
  const effectivePermissionMode =
    composer.permissionPolicy === "snapshot"
      ? snapshotPermissionMode
      : permissionMode;

  const displayStatus = threadQuery.data?.runtime.displayStatus ?? "idle";
  const executionRequestFields = useMemo(
    () => ({
      ...(selectedExecutionModel.length > 0
        ? {
            model: selectedExecutionModel,
            reasoningLevel,
            ...(selectedExecutionServiceTier
              ? { serviceTier: selectedExecutionServiceTier }
              : {}),
          }
        : {}),
      ...(effectivePermissionMode !== undefined
        ? { permissionMode: effectivePermissionMode }
        : {}),
    }),
    [
      effectivePermissionMode,
      reasoningLevel,
      selectedExecutionModel,
      selectedExecutionServiceTier,
    ],
  );
  const [composerFocusNonce, setComposerFocusNonce] = useState(0);
  const [inlineComposerFocusNonce, setInlineComposerFocusNonce] = useState(0);
  const [isTurnSubmitting, setIsTurnSubmitting] = useState(false);
  const isMountedRef = useRef(false);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const clearInlineAttachmentErrorRef = useRef<() => void>(() => {});
  const {
    inlineEditingQueuedMessage,
    inlineEditingQueuedMessageRef,
    updateInlineQueuedMessage,
    dismissInlineQueuedMessageEditor,
    beginEditQueuedMessage,
    queuedMessageDraftSession,
  } = useInlineQueuedMessageEditing({
    ownerThreadId: threadId,
    queuedMessages,
    onBeginEdit: () => {
      clearInlineAttachmentErrorRef.current();
      setInlineComposerFocusNonce((nonce) => nonce + 1);
    },
  });
  const inlineDraftSessionRef = useLatestRef(queuedMessageDraftSession);
  const {
    promptDraft,
    currentPromptDraft,
    currentPromptDraftInput,
    activeComposerDraft,
    activeComposerDraftInput,
    setActiveComposerDraft,
    handleChangeMessage,
    removeActiveComposerAttachment,
  } = useActiveComposerDraft({
    draftScope: composer.draftScope,
    inlineDraft: inlineEditingQueuedMessage?.draft ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });
  const {
    bottomAttachmentError,
    setBottomAttachmentError,
    handleAttachBottomFiles,
    isAttachingBottomFiles,
    inlineAttachmentError,
    setInlineAttachmentError,
    handleAttachInlineFiles,
    isAttachingInlineFiles,
  } = useComposerAttachmentUploads({
    projectId,
    addDraftAttachment: promptDraft.addAttachment,
    inlineEditSessionId: queuedMessageDraftSession?.editSessionId ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });
  clearInlineAttachmentErrorRef.current = () => setInlineAttachmentError(null);
  const { typeaheadConfig, promptActions } = useComposerTypeahead({
    projectId,
    providerId,
    environmentId: promptContextEnvironmentId,
    currentThreadId: threadId,
    selectedProviderComposerActions,
    resolveMentionLink,
  });

  const isStopRequested =
    threadQuery.data?.status === "stopping" ||
    (stopThread.isPending && stopThread.variables === threadId);
  const handleStopThread = useCallback(() => {
    stopThread.mutate(threadId);
  }, [stopThread, threadId]);
  const isProvisioning =
    displayStatus === "provisioning" || displayStatus === "starting";
  const isDefaultExecutionOptionsLoading =
    executionOptionsQuery.isPlaceholderData ||
    (defaultExecutionOptions === undefined && executionOptionsQuery.isLoading);

  const {
    processingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending,
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleDeleteQueuedMessage,
    handleReorderQueuedMessage,
    handleSetQueuedMessageGroupBoundary,
  } = useQueuedMessageActions({
    threadId,
    queuedMessages,
    sendProcessingPersistence: "clear-on-settle",
    onSaveSuccess: () => setInlineAttachmentError(null),
    inlineEditingQueuedMessage,
    dismissInlineQueuedMessageEditor,
    activeComposerDraftInput,
  });

  const submitMode = useMemo<FollowUpComposerProps["submitMode"]>(
    () =>
      buildSideChatSubmitMode({
        childThreadId: threadId,
        hasPendingInteraction: hasComposerBlockingPendingInteraction,
        isDefaultExecutionOptionsLoading,
        isPendingInteractionsInitialLoading:
          pendingInteractionsInitialLoading || pendingInteractionsUnavailable,
        isStopRequested,
        onStop: handleStopThread,
        runtimeDisplayStatus: displayStatus,
      }),
    [
      displayStatus,
      hasComposerBlockingPendingInteraction,
      handleStopThread,
      isDefaultExecutionOptionsLoading,
      isStopRequested,
      pendingInteractionsInitialLoading,
      pendingInteractionsUnavailable,
      threadId,
    ],
  );

  const defaultSendOrQueueInput = useCallback(
    async (input: PromptInput[]) => {
      if (shouldQueueFollowUpMessage(displayStatus)) {
        await createQueuedMessage.mutateAsync({
          id: threadId,
          input,
          ...executionRequestFields,
        });
        return;
      }
      const result = await sendThreadMessage.mutateAsync({
        id: threadId,
        input,
        mode: "queue-if-active",
        ...executionRequestFields,
      });
      reportQueuedSendDelivery(result.delivery);
    },
    [
      createQueuedMessage,
      displayStatus,
      executionRequestFields,
      sendThreadMessage,
      threadId,
    ],
  );
  const handleSubmit = useCallback(() => {
    const submittedDraft = currentPromptDraft;
    const submittedInput = currentPromptDraftInput;
    if (submittedInput.length === 0 || isTurnSubmitting) {
      return;
    }
    promptDraft.clearIfCurrentMatches(submittedDraft);
    setBottomAttachmentError(null);
    setIsTurnSubmitting(true);
    void defaultSendOrQueueInput(submittedInput)
      .catch((error) => {
        if (!isMountedRef.current) {
          return;
        }
        promptDraft.restoreIfEmpty(submittedDraft);
        appToast.error(
          getMutationErrorMessage({
            error,
            fallbackMessage: labels.sendError,
            lifecycleOperation: shouldQueueFollowUpMessage(displayStatus)
              ? "queue_message"
              : "send_message",
          }),
        );
      })
      .finally(() => {
        if (isMountedRef.current) {
          setIsTurnSubmitting(false);
        }
      });
  }, [
    currentPromptDraft,
    currentPromptDraftInput,
    defaultSendOrQueueInput,
    displayStatus,
    isTurnSubmitting,
    labels.sendError,
    promptDraft,
    setBottomAttachmentError,
  ]);

  const isQueueMutationPending =
    queuedMessageActionPending || createQueuedMessage.isPending;
  const handleSendQueuedMessage = useCallback(
    (queuedMessageId: string) => {
      void sendQueuedMessageById({
        guard: "exists",
        messageId: queuedMessageId,
        mode: isProvisioning ? "steer" : "auto",
      });
    },
    [isProvisioning, sendQueuedMessageById],
  );
  const hasPromptDraftInput = currentPromptDraftInput.length > 0;
  const canSubmitModifierShortcut = canSubmitFollowUpShortcut({
    hasPromptDraftInput,
    isFollowUpSubmitting: isTurnSubmitting,
    isQueueMutationPending,
    queuedMessageCount: queuedMessages.length,
    runtimeDisplayStatus: displayStatus,
    submitModeKind: submitMode.kind,
  });
  const handleModifierSubmit = useCallback(() => {
    if (!canSubmitModifierShortcut) {
      return;
    }

    const submittedDraft = currentPromptDraft;
    const submittedInput = currentPromptDraftInput;
    if (submittedInput.length === 0) {
      const nextQueuedMessage = queuedMessages[0];
      if (nextQueuedMessage) {
        void sendQueuedMessageById({
          guard: "current-head",
          messageId: nextQueuedMessage.id,
          mode: "steer",
        });
      }
      return;
    }

    promptDraft.clearIfCurrentMatches(submittedDraft);
    setBottomAttachmentError(null);
    setIsTurnSubmitting(true);
    void sendThreadMessage
      .mutateAsync({
        id: threadId,
        input: submittedInput,
        mode: "steer-if-active",
        ...executionRequestFields,
      })
      .then((result) => {
        reportQueuedSendDelivery(result.delivery);
      })
      .catch((error) => {
        if (!isMountedRef.current) {
          return;
        }
        promptDraft.restoreIfEmpty(submittedDraft);
        appToast.error(
          getMutationErrorMessage({
            error,
            fallbackMessage: labels.sendError,
            lifecycleOperation: "send_message",
          }),
        );
      })
      .finally(() => {
        if (isMountedRef.current) {
          setIsTurnSubmitting(false);
        }
      });
  }, [
    canSubmitModifierShortcut,
    currentPromptDraft,
    currentPromptDraftInput,
    executionRequestFields,
    labels.sendError,
    promptDraft,
    queuedMessages,
    sendQueuedMessageById,
    sendThreadMessage,
    setBottomAttachmentError,
    threadId,
  ]);

  const handleInlineComposerSubmit = useCallback(() => {
    void handleSaveInlineQueuedMessage();
  }, [handleSaveInlineQueuedMessage]);

  const addQuoteToPromptDraft = promptDraft.addQuote;
  const handleAddToChat = useCallback<ThreadTimelineAddToChatHandler>(
    (text, attachments) => {
      addQuoteToPromptDraft(text, attachments);
      setComposerFocusNonce((nonce) => nonce + 1);
    },
    [addQuoteToPromptDraft],
  );

  const queuedEditSessionId = inlineEditingQueuedMessage?.editSessionId ?? null;
  const queuedEditOwnerThreadId =
    inlineEditingQueuedMessage?.ownerThreadId ?? null;
  const queuedEditMessageId =
    inlineEditingQueuedMessage?.queuedMessageId ?? null;
  const queuedComposerIdentity = useMemo(
    () =>
      queuedEditSessionId === null ||
      queuedEditOwnerThreadId === null ||
      queuedEditMessageId === null
        ? null
        : {
            editSessionId: queuedEditSessionId,
            ownerThreadId: queuedEditOwnerThreadId,
            queuedMessageId: queuedEditMessageId,
          },
    [queuedEditMessageId, queuedEditOwnerThreadId, queuedEditSessionId],
  );
  const bottomScope = composer.pluginComposerBottomScope ?? null;
  const bottomComposerHostIdentity = useMemo(
    () =>
      createPluginComposerHostIdentity(
        `${composer.composerIdentity ?? surfaceKey}:bottom:active`,
      ),
    [composer.composerIdentity, surfaceKey],
  );
  const queuedComposerHostIdentity = useMemo(
    () =>
      queuedComposerIdentity
        ? createPluginComposerHostIdentity(
            `queued-message:${queuedComposerIdentity.ownerThreadId}:${queuedComposerIdentity.queuedMessageId}:${queuedComposerIdentity.editSessionId}:active`,
          )
        : null,
    [queuedComposerIdentity],
  );
  const activeBottomComposerIdentityRef = useRef<string | null>(null);
  const activeQueuedComposerIdentityRef = useRef<string | null>(null);
  const currentPromptDraftRef = useRef(currentPromptDraft);
  const committedInlineEditRef = useRef(inlineEditingQueuedMessage);
  useLayoutEffect(() => {
    currentPromptDraftRef.current = currentPromptDraft;
    committedInlineEditRef.current = inlineEditingQueuedMessage;
  }, [currentPromptDraft, inlineEditingQueuedMessage]);
  useLayoutEffect(() => {
    activeBottomComposerIdentityRef.current = bottomComposerHostIdentity;
    return () => {
      if (
        activeBottomComposerIdentityRef.current === bottomComposerHostIdentity
      ) {
        activeBottomComposerIdentityRef.current = null;
      }
    };
  }, [bottomComposerHostIdentity]);
  useLayoutEffect(() => {
    activeQueuedComposerIdentityRef.current =
      queuedComposerHostIdentity ?? null;
    return () => {
      if (
        activeQueuedComposerIdentityRef.current === queuedComposerHostIdentity
      ) {
        activeQueuedComposerIdentityRef.current = null;
      }
    };
  }, [queuedComposerHostIdentity]);
  const subscribeBottomDraft = useComposerHostDraftNotifier(currentPromptDraft);
  const subscribeQueuedDraft = useComposerHostDraftNotifier(
    inlineEditingQueuedMessage?.draft ?? null,
  );
  const setStoredPromptDraft = promptDraft.setDraft;
  const bottomPluginComposerHost = useMemo<PluginComposerHost | null>(() => {
    if (bottomScope === null) return null;
    const identity = bottomComposerHostIdentity;
    const initialDraft = currentPromptDraftRef.current;
    return {
      scope: bottomScope,
      textEffectKey: identity,
      getCurrent: () =>
        activeBottomComposerIdentityRef.current === identity
          ? currentPromptDraftRef.current
          : initialDraft,
      subscribeDraft: subscribeBottomDraft,
      setDraft: (draft) => {
        if (activeBottomComposerIdentityRef.current === identity) {
          setStoredPromptDraft(draft);
        }
      },
      focus: () => {
        if (activeBottomComposerIdentityRef.current === identity) {
          setComposerFocusNonce((nonce) => nonce + 1);
        }
      },
    };
  }, [
    bottomComposerHostIdentity,
    bottomScope,
    setStoredPromptDraft,
    subscribeBottomDraft,
  ]);
  const queuedPluginComposerHost = useMemo<PluginComposerHost | null>(() => {
    if (
      queuedComposerIdentity === null ||
      queuedComposerHostIdentity === null
    ) {
      return null;
    }
    const identity = queuedComposerHostIdentity;
    const initialDraft = inlineEditingQueuedMessageRef.current?.draft ?? {
      attachments: [],
      mentions: [],
      text: "",
    };
    const queuedEdit = queuedComposerIdentity;
    const isCurrentQueuedEdit = (
      current: typeof inlineEditingQueuedMessageRef.current,
    ): current is NonNullable<typeof current> =>
      queuedEdit !== null &&
      current?.editSessionId === queuedEdit.editSessionId &&
      current.ownerThreadId === queuedEdit.ownerThreadId &&
      current.queuedMessageId === queuedEdit.queuedMessageId;
    return {
      scope: {
        kind: "queued-message",
        threadId: queuedEdit.ownerThreadId,
        queuedMessageId: queuedEdit.queuedMessageId,
      },
      textEffectKey: identity,
      getCurrent: () => {
        if (activeQueuedComposerIdentityRef.current !== identity) {
          return initialDraft;
        }
        const currentQueuedEdit = committedInlineEditRef.current;
        return isCurrentQueuedEdit(currentQueuedEdit)
          ? currentQueuedEdit.draft
          : initialDraft;
      },
      subscribeDraft: subscribeQueuedDraft,
      setDraft: (draft) => {
        if (activeQueuedComposerIdentityRef.current !== identity) {
          return;
        }
        updateInlineQueuedMessage((current) =>
          isCurrentQueuedEdit(current) ? { ...current, draft } : current,
        );
      },
      focus: () => {
        if (activeQueuedComposerIdentityRef.current === identity) {
          setInlineComposerFocusNonce((nonce) => nonce + 1);
        }
      },
    };
  }, [
    inlineEditingQueuedMessageRef,
    queuedComposerIdentity,
    queuedComposerHostIdentity,
    subscribeQueuedDraft,
    updateInlineQueuedMessage,
  ]);
  const activeBottomPluginComposerHost = bottomPluginComposerHost;
  const activeQueuedPluginComposerHost = queuedPluginComposerHost;
  const bottomComposerTextEffects = useComposerTextEffects(
    activeBottomPluginComposerHost?.textEffectKey ?? null,
  );
  const queuedComposerTextEffects = useComposerTextEffects(
    activeQueuedPluginComposerHost?.textEffectKey ?? null,
  );

  const composerPlaceholder = isStopRequested
    ? labels.stopping
    : isProvisioning
      ? labels.provisioning
      : labels.placeholder;

  const bottomComposerConfig = useMemo<FollowUpComposerProps>(
    () => ({
      history: {
        currentDraft: currentPromptDraft,
        entries: [],
        onSelectEntry: promptDraft.setDraft,
      } satisfies HistoryConfig,
      isFollowUpSubmitting: isTurnSubmitting,
      message: currentPromptDraft.text,
      mentionRanges: currentPromptDraft.mentions,
      onChangeMessage: promptDraft.setTextAndMentions,
      onModifierSubmit: handleModifierSubmit,
      onSubmit: handleSubmit,
      compactPromptPlaceholder: composerPlaceholder,
      promptPlaceholder: composerPlaceholder,
      canModifierSubmit: canSubmitModifierShortcut,
      steerActiveThreadOnEnter,
      submitMode,
      threadRuntimeDisplayStatus: displayStatus,
    }),
    [
      canSubmitModifierShortcut,
      composerPlaceholder,
      currentPromptDraft,
      displayStatus,
      handleModifierSubmit,
      handleSubmit,
      isTurnSubmitting,
      promptDraft.setDraft,
      promptDraft.setTextAndMentions,
      steerActiveThreadOnEnter,
      submitMode,
    ],
  );
  const inlineComposerConfig = useMemo<FollowUpComposerProps | null>(
    () =>
      inlineEditingQueuedMessage
        ? {
            history: {
              currentDraft: activeComposerDraft,
              entries: [],
              onSelectEntry: setActiveComposerDraft,
            } satisfies HistoryConfig,
            isFollowUpSubmitting: isUpdateQueuedMessagePending,
            message: activeComposerDraft.text,
            mentionRanges: activeComposerDraft.mentions,
            onChangeMessage: handleChangeMessage,
            onModifierSubmit: handleInlineComposerSubmit,
            onSubmit: handleInlineComposerSubmit,
            compactPromptPlaceholder: composerPlaceholder,
            promptPlaceholder: composerPlaceholder,
            canModifierSubmit:
              activeComposerDraftInput.length > 0 &&
              !isUpdateQueuedMessagePending,
            steerActiveThreadOnEnter: false,
            submitMode: { kind: "ready" },
            threadRuntimeDisplayStatus: displayStatus,
          }
        : null,
    [
      activeComposerDraft,
      activeComposerDraftInput.length,
      composerPlaceholder,
      displayStatus,
      handleChangeMessage,
      handleInlineComposerSubmit,
      inlineEditingQueuedMessage,
      isUpdateQueuedMessagePending,
      setActiveComposerDraft,
    ],
  );

  const bottomAttachmentsConfig = useMemo<AttachmentsConfig>(
    () => ({
      items: currentPromptDraft.attachments,
      projectId,
      isAttaching: isAttachingBottomFiles,
      error: bottomAttachmentError,
      onAttachFiles: handleAttachBottomFiles,
      onRemove: promptDraft.removeAttachment,
    }),
    [
      bottomAttachmentError,
      currentPromptDraft.attachments,
      handleAttachBottomFiles,
      isAttachingBottomFiles,
      projectId,
      promptDraft.removeAttachment,
    ],
  );
  const inlineAttachmentsConfig = useMemo<AttachmentsConfig>(
    () => ({
      items: activeComposerDraft.attachments,
      projectId,
      isAttaching: isAttachingInlineFiles,
      error: inlineAttachmentError,
      onAttachFiles: handleAttachInlineFiles,
      onRemove: removeActiveComposerAttachment,
    }),
    [
      activeComposerDraft.attachments,
      inlineAttachmentError,
      handleAttachInlineFiles,
      isAttachingInlineFiles,
      projectId,
      removeActiveComposerAttachment,
    ],
  );

  const bottomExecutionConfig = useMemo<ExecutionControlsProps>(
    () => ({
      providerRouting: executionOptionsRouting,
      provider: {
        options: providerOptions,
        selectedId: selectedProviderId,
        hasMultiple: hasMultipleProviders,
      },
      model: {
        active: activeModel,
        selected: selectedModel,
        options: modelOptions,
        moreOptions: moreModelOptions,
        loadError: modelLoadError,
        isLoading: isLoadingModels,
        loadFailed: modelLoadFailed,
        onChange: setSelectedModel,
      },
      serviceTier: {
        value: serviceTier,
        onChange: setServiceTier,
        supported: supportsServiceTier,
        supportByProvider: serviceTierSupportByProvider,
        fastLabel: serviceTierFastLabel,
      },
      reasoning: {
        value: reasoningLevel,
        options: reasoningOptions,
        onChange: setReasoningLevel,
      },
    }),
    [
      activeModel,
      executionOptionsRouting,
      hasMultipleProviders,
      isLoadingModels,
      modelLoadFailed,
      modelLoadError,
      modelOptions,
      moreModelOptions,
      providerOptions,
      reasoningLevel,
      reasoningOptions,
      selectedModel,
      selectedProviderId,
      serviceTier,
      serviceTierSupportByProvider,
      setReasoningLevel,
      setSelectedModel,
      setServiceTier,
      supportsServiceTier,
      serviceTierFastLabel,
    ],
  );
  const inlineExecutionConfig = useMemo<ExecutionControlsProps | null>(
    () =>
      inlineEditingQueuedMessage
        ? {
            ...bottomExecutionConfig,
            model: {
              ...bottomExecutionConfig.model,
              active: { model: inlineEditingQueuedMessage.model },
              selected: inlineEditingQueuedMessage.model,
            },
            serviceTier: {
              value: inlineEditingQueuedMessage.serviceTier,
              onChange: setServiceTier,
              supported: supportsServiceTier,
              supportByProvider: serviceTierSupportByProvider,
              fastLabel: serviceTierFastLabel,
            },
            reasoning: {
              ...bottomExecutionConfig.reasoning,
              value: inlineEditingQueuedMessage.reasoningLevel,
            },
          }
        : null,
    [
      bottomExecutionConfig,
      inlineEditingQueuedMessage,
      serviceTierSupportByProvider,
      setServiceTier,
      supportsServiceTier,
      serviceTierFastLabel,
    ],
  );

  const bottomPermissionConfig = useMemo<ExecutionPermissionConfig>(
    () =>
      composer.permissionPolicy === "snapshot"
        ? {
            value: snapshotPermissionMode,
            options: permissionModeOptions,
            onChange: () => {},
            supported: supportsPermissionModeSelection,
          }
        : {
            value: permissionMode,
            options: permissionModeOptions,
            onChange: setPermissionMode,
            supported: supportsPermissionModeSelection,
          },
    [
      composer.permissionPolicy,
      permissionMode,
      permissionModeOptions,
      setPermissionMode,
      snapshotPermissionMode,
      supportsPermissionModeSelection,
    ],
  );
  const inlinePermissionConfig = useMemo<ExecutionPermissionConfig | null>(
    () =>
      inlineEditingQueuedMessage
        ? {
            ...bottomPermissionConfig,
            value: inlineEditingQueuedMessage.permissionMode,
          }
        : null,
    [bottomPermissionConfig, inlineEditingQueuedMessage],
  );

  const inlineEditor = useMemo<QueuedMessageInlineEditor | undefined>(() => {
    if (
      !inlineEditingQueuedMessage ||
      !inlineComposerConfig ||
      !inlineExecutionConfig ||
      !inlinePermissionConfig
    ) {
      return undefined;
    }
    return {
      queuedMessageId: inlineEditingQueuedMessage.queuedMessageId,
      queuedMessageIndex: inlineEditingQueuedMessage.queuedMessageIndex,
      onDismiss: dismissInlineQueuedMessageEditor,
      content: (
        <FollowUpPromptBox
          attachments={inlineAttachmentsConfig}
          stack={null}
          composer={inlineComposerConfig}
          pluginComposerHost={activeQueuedPluginComposerHost}
          pluginComposerScope={activeQueuedPluginComposerHost?.scope ?? null}
          textEffects={queuedComposerTextEffects}
          environmentSummary={null}
          contextWindowUsage={null}
          execution={inlineExecutionConfig}
          executionReadOnly
          permission={inlinePermissionConfig}
          permissionReadOnly
          typeahead={typeaheadConfig}
          promptActions={promptActions}
          collapseResetKey={`${surfaceKey}:queued-message:${inlineEditingQueuedMessage.queuedMessageId}`}
          focusEndKey={`${inlineEditingQueuedMessage.editSessionId}:${inlineComposerFocusNonce}`}
          isPrimaryComposer={false}
          showScrollToBottomButton={false}
        />
      ),
    };
  }, [
    activeQueuedPluginComposerHost,
    dismissInlineQueuedMessageEditor,
    inlineAttachmentsConfig,
    inlineComposerConfig,
    inlineComposerFocusNonce,
    inlineEditingQueuedMessage,
    inlineExecutionConfig,
    inlinePermissionConfig,
    promptActions,
    queuedComposerTextEffects,
    surfaceKey,
    typeaheadConfig,
  ]);

  const queuedMessagesStack = useMemo(
    () =>
      queuedMessages.length > 0 && !pendingInteractionOccupiesComposer ? (
        <QueuedMessagesList
          attachedToComposer
          queuedMessages={queuedMessages}
          resolveMentionLink={resolveMentionLink}
          inlineEditor={inlineEditor}
          sendAction={isProvisioning ? "steer-when-ready" : "send-now"}
          sendDisabled={queuedMessageActionPending}
          actionDisabled={queuedMessageActionPending}
          processingMessageId={processingQueuedMessage?.id ?? null}
          processingAction={processingQueuedMessage?.action ?? null}
          onSend={handleSendQueuedMessage}
          onReorder={handleReorderQueuedMessage}
          onSetGroupBoundary={handleSetQueuedMessageGroupBoundary}
          onEdit={beginEditQueuedMessage}
          onDelete={handleDeleteQueuedMessage}
        />
      ) : null,
    [
      beginEditQueuedMessage,
      handleDeleteQueuedMessage,
      handleReorderQueuedMessage,
      handleSendQueuedMessage,
      handleSetQueuedMessageGroupBoundary,
      inlineEditor,
      isProvisioning,
      processingQueuedMessage?.action,
      processingQueuedMessage?.id,
      pendingInteractionOccupiesComposer,
      queuedMessageActionPending,
      queuedMessages,
      resolveMentionLink,
    ],
  );

  const surfaceClassName =
    surfaceTone === "sidebar" ? "bg-sidebar" : "bg-background";
  const pendingInteractionBanner = pendingInteractionsUnavailable ? (
    <PendingInteractionsQueryBanner
      state="error"
      isRetrying={pendingInteractionsQuery.isFetching}
      onRetry={() => void pendingInteractionsQuery.refetch()}
    />
  ) : pendingInteractionsInitialLoading ? (
    <PendingInteractionsQueryBanner state="loading" />
  ) : activePendingInteraction !== null &&
    activePendingInteraction.payload.kind !== "plugin" ? (
    <ThreadPendingInteractionBanner
      interaction={activePendingInteraction}
      threadId={threadId}
    />
  ) : null;
  const footer = (
    <div className={cn("relative", surfaceClassName)}>
      <OverflowFade placement="above" tone={surfaceTone} />
      <div className="px-4 pb-4 pt-2">
        <FollowUpPromptBox
          attachments={bottomAttachmentsConfig}
          stack={queuedMessagesStack}
          pendingInteraction={pendingInteractionBanner}
          composer={bottomComposerConfig}
          pluginComposerHost={activeBottomPluginComposerHost}
          pluginComposerScope={activeBottomPluginComposerHost?.scope ?? null}
          textEffects={bottomComposerTextEffects}
          environmentSummary={composer.environmentSummary}
          contextWindowUsage={null}
          execution={bottomExecutionConfig}
          permission={bottomPermissionConfig}
          permissionReadOnly={composer.permissionPolicy === "snapshot"}
          typeahead={typeaheadConfig}
          promptActions={promptActions}
          collapseResetKey={surfaceKey}
          focusEndKey={
            composer.focusRequestKey === undefined
              ? composerFocusNonce
              : `${composerFocusNonce}:${composer.focusRequestKey}`
          }
          isPrimaryComposer={false}
        />
      </div>
    </div>
  );

  const maxWidthClassName = measure === "page" ? "max-w-[760px]" : "max-w-none";
  const timelineBody = (
    <ThreadTimelinePanelContent
      isTurnSubmitting={isTurnSubmitting}
      leadingContent={leadingContent}
      consumerMessageActions={consumerMessageActions}
      includePluginMessageActions={includePluginMessageActions}
      onOpenLink={onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      onMessageAddToChat={handleAddToChat}
      onSelectionAddToChat={handleAddToChat}
      projectId={projectId}
      resolveMentionLink={resolveMentionLink}
      threadId={threadId}
      workspaceRootPath={workspaceRootPath}
    />
  );

  if (layout === "document") {
    return (
      <div
        key={surfaceKey}
        data-thread-window=""
        data-surface-tone={surfaceTone}
        className={cn("flex min-w-0 flex-col", surfaceClassName)}
      >
        <div
          className={cn(
            "mx-auto flex w-full min-w-0 flex-col",
            measure === "page" ? "px-4 pb-3 pt-3" : "px-2 pb-3 pt-3",
            maxWidthClassName,
          )}
        >
          {timelineBody}
        </div>
        <div className="sticky bottom-0 z-20">{footer}</div>
      </div>
    );
  }

  return (
    <div
      data-thread-window=""
      data-surface-tone={surfaceTone}
      className="flex min-h-0 flex-1 flex-col"
    >
      <BottomAnchoredScrollBody
        key={surfaceKey}
        scrollAreaClassName={surfaceClassName}
        contentClassName={
          measure === "page" ? "!pb-3 !pt-3" : "!px-2 !pb-3 !pt-3"
        }
        maxWidthClassName={maxWidthClassName}
        footer={footer}
        scrollAnchorThreadId={threadId}
      >
        {timelineBody}
      </BottomAnchoredScrollBody>
    </div>
  );
}
