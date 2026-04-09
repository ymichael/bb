import { useCallback, useState, type ComponentType, type ReactNode, type RefObject } from "react";
import type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
  Thread,
  TimelineRow,
  WorkspaceStatus,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import { ThreadPendingInteractionBanner } from "@/components/thread/ThreadPendingInteractionBanner";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { useCreateThreadDraft, useDeleteThreadDraft, useSendThreadDraft, useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import {
  getLatestPendingInteraction,
  useThreadDefaultExecutionOptions,
  useThreadDrafts,
  useThreadPendingInteractions,
} from "@/hooks/queries/thread-queries";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptDraftToInput, type PromptDraftState } from "@/lib/prompt-draft";
import { toast } from "sonner";
import { ThreadFollowUpComposer } from "./ThreadFollowUpComposer";
import { queuedInputToDraft } from "./threadQueuedMessages";
import type { SendMessageMutationLike } from "./threadDetailMutationTypes";
import { useThreadFollowUpTracking } from "./useThreadFollowUpTracking";

interface PromptBannerFile {
  path: string;
}

interface SendFollowUpInputParams {
  input: PromptInput[];
  mode?: "auto" | "steer";
  model?: string;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  serviceTier?: ServiceTier;
}

interface ThreadDetailPromptAreaProps {
  canExpandPromptChangeList: boolean;
  canUseGitUi: boolean;
  contextWindowUsage?: ThreadTimelineResponse["contextWindowUsage"];
  environmentHostConnected?: boolean;
  environmentIcon?: ComponentType<{ className?: string }>;
  environmentLabel?: ReactNode;
  isDiffPanelActive: boolean;
  isEnvironmentActionPending: boolean;
  isLoadingMergeBaseBranchOptions: boolean;
  mergeBaseBranchOptions?: readonly string[];
  onMergeBaseBranchChange?: (branch: string) => void;
  onMergeBaseBranchPickerOpenChange?: (open: boolean) => void;
  openDiffFile: (path: string) => void;
  openThreadDiffPanel: () => void;
  projectId: string;
  promptBannerMergeBaseBranch?: string;
  promptBannerSummary: string;
  promptComposerRef: RefObject<HTMLDivElement | null>;
  scrollToBottom: () => void;
  sendMessage: SendMessageMutationLike;
  showBranchComparisonUi: boolean;
  showPromptGitStatsBanner: boolean;
  showScrollToBottom: boolean;
  thread: Thread;
  threadDetailRows: TimelineRow[];
  workspaceStatus?: WorkspaceStatus;
}

export function ThreadDetailPromptArea({
  canExpandPromptChangeList,
  canUseGitUi,
  contextWindowUsage,
  environmentHostConnected,
  environmentIcon,
  environmentLabel,
  isDiffPanelActive,
  isEnvironmentActionPending,
  isLoadingMergeBaseBranchOptions,
  mergeBaseBranchOptions,
  onMergeBaseBranchChange,
  onMergeBaseBranchPickerOpenChange,
  openDiffFile,
  openThreadDiffPanel,
  projectId,
  promptBannerMergeBaseBranch,
  promptBannerSummary,
  promptComposerRef,
  scrollToBottom,
  sendMessage,
  showBranchComparisonUi,
  showPromptGitStatsBanner,
  showScrollToBottom,
  thread,
  threadDetailRows,
  workspaceStatus,
}: ThreadDetailPromptAreaProps) {
  const { data: defaultExecutionOptions } = useThreadDefaultExecutionOptions(thread.id);
  const { data: queuedMessages = [] } = useThreadDrafts(thread.id);
  const { data: pendingInteractions = [] } = useThreadPendingInteractions(thread.id);
  const createDraft = useCreateThreadDraft();
  const sendDraft = useSendThreadDraft();
  const deleteDraft = useDeleteThreadDraft();
  const stopThread = useStopThread();
  const uploadPromptAttachment = useUploadPromptAttachment();
  const promptDraft = usePromptDraftStorage({
    projectId,
    threadId: thread.id,
  });
  const promptMentions = usePromptMentions(projectId, {
    threadSuggestionMode: thread.type === "manager" ? "all" : "managers",
    currentThreadId: thread.id,
  });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isChangeListExpanded, setIsChangeListExpanded] = useState(false);
  const [processingQueuedMessageId, setProcessingQueuedMessageId] =
    useState<string | null>(null);
  const {
    selectedProviderId,
    providerOptions,
    hasMultipleProviders,
    selectedProviderDisplayName,
    selectedModel,
    setSelectedModel,
    serviceTier,
    setServiceTier,
    reasoningLevel,
    setReasoningLevel,
    sandboxMode,
    setSandboxMode,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions,
    supportsServiceTier,
    serviceTierSupportByProvider,
  } = useThreadCreationOptions({
    scope: "thread",
    resetKey: thread.id,
    initialProviderId: thread.providerId,
    initialModel: defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialSandboxMode: defaultExecutionOptions?.sandboxMode,
    initialEnvironmentSelectionValue: thread.environmentId ?? undefined,
  });
  const handleFollowUpAcknowledged = useCallback((submittedDraft: PromptDraftState) => {
    promptDraft.clearIfCurrentMatches(submittedDraft);
  }, [promptDraft]);
  const {
    beginPendingFollowUp,
    clearPendingFollowUp,
    pendingSubmittedFollowUp,
  } = useThreadFollowUpTracking({
    threadDetailRows,
    threadId: thread.id,
    onAcknowledged: handleFollowUpAcknowledged,
  });
  const isCreated = thread.status === "created";
  const isProvisioning = thread.status === "provisioning";
  const isRuntimeError = thread.status === "error";
  const activePendingInteraction = getLatestPendingInteraction(pendingInteractions);
  const hasPendingInteraction = activePendingInteraction !== null;
  const isQueueMutationPending =
    createDraft.isPending ||
    sendDraft.isPending ||
    deleteDraft.isPending;
  const isFollowUpSubmitting =
    sendMessage.isPending ||
    pendingSubmittedFollowUp !== null ||
    isEnvironmentActionPending ||
    createDraft.isPending;
  const canSendFollowUp = !isCreated && !isProvisioning && !hasPendingInteraction;
  const promptPlaceholder =
    isCreated
      ? "Thread is being created..."
      : isProvisioning
      ? "Thread is provisioning..."
      : hasPendingInteraction
      ? "Resolve the pending interaction below before sending another message"
      : isRuntimeError
      ? "Retry by sending a follow-up message"
      : thread.status === "idle"
      ? "Ask for follow-up changes"
      : "Send a message to this thread...";
  const sendFollowUpInput = useCallback(
    async ({
      input,
      mode = "auto",
      model,
      serviceTier: executionServiceTier,
      reasoningLevel: executionReasoningLevel,
      sandboxMode: executionSandboxMode,
    }: SendFollowUpInputParams) => {
      if (input.length === 0) {
        return;
      }

      scrollToBottom();
      await sendMessage.mutateAsync({
        id: thread.id,
        input,
        mode,
        ...(mode === "steer"
          ? {}
          : {
              ...(model ? { model } : {}),
              ...(executionServiceTier ? { serviceTier: executionServiceTier } : {}),
              ...(executionReasoningLevel ? { reasoningLevel: executionReasoningLevel } : {}),
              ...(executionSandboxMode ? { sandboxMode: executionSandboxMode } : {}),
            }),
      });
    },
    [scrollToBottom, sendMessage, thread.id],
  );

  const handleAttachFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    setAttachmentError(null);
    const failedFiles: string[] = [];
    for (const file of files) {
      try {
        const uploaded = await uploadPromptAttachment.mutateAsync({
          projectId,
          file,
        });
        promptDraft.addAttachment(uploaded);
      } catch {
        failedFiles.push(file.name);
      }
    }
    if (failedFiles.length > 0) {
      setAttachmentError(`Failed to attach: ${failedFiles.join(", ")}`);
    }
  }, [projectId, promptDraft, uploadPromptAttachment]);

  const handleSend = useCallback(async () => {
    const submittedDraft = {
      text: promptDraft.text,
      attachments: promptDraft.attachments,
    };
    const submittedInput = promptDraftToInput(submittedDraft);
    if (submittedInput.length === 0) {
      return;
    }

    if (thread.status === "active") {
      try {
        await createDraft.mutateAsync({
          id: thread.id,
          input: submittedInput,
          model: activeModel?.model ?? selectedModel,
          ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
          reasoningLevel,
          sandboxMode,
        });
        promptDraft.clearIfCurrentMatches(submittedDraft);
        setAttachmentError(null);
      } catch (nextError) {
        toast.error(getMutationErrorMessage({
          error: nextError,
          fallbackMessage: "Failed to queue follow-up.",
        }));
      }
      return;
    }

    beginPendingFollowUp({
      draft: submittedDraft,
      input: submittedInput,
    });
    setAttachmentError(null);

    try {
      await sendFollowUpInput({
        input: submittedInput,
        model: activeModel?.model ?? selectedModel,
        ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
        reasoningLevel,
        sandboxMode,
      });
    } catch (nextError) {
      clearPendingFollowUp();
      toast.error(getMutationErrorMessage({
        error: nextError,
        fallbackMessage: "Failed to send follow-up.",
      }));
    }
  }, [
    activeModel?.model,
    beginPendingFollowUp,
    clearPendingFollowUp,
    createDraft,
    promptDraft,
    reasoningLevel,
    sandboxMode,
    selectedModel,
    sendFollowUpInput,
    serviceTier,
    supportsServiceTier,
    thread.id,
    thread.status,
  ]);

  const handleSendQueuedImmediately = useCallback((messageId: string) => {
    const queuedMessage = queuedMessages.find((candidate) => candidate.id === messageId);
    if (!queuedMessage) {
      return;
    }

    setProcessingQueuedMessageId(messageId);
    void sendDraft
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
      })
      .then(() => {
        setAttachmentError(null);
      })
      .catch((nextError) => {
        toast.error(getMutationErrorMessage({
          error: nextError,
          fallbackMessage: "Failed to send queued follow-up.",
        }));
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  }, [queuedMessages, sendDraft, thread.id]);

  const handleEditQueuedMessage = useCallback((messageId: string) => {
    const queuedMessage = queuedMessages.find((candidate) => candidate.id === messageId);
    if (!queuedMessage) {
      return;
    }

    setProcessingQueuedMessageId(messageId);
    void deleteDraft
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
      })
      .then(() => {
        const restoredDraft = queuedInputToDraft(queuedMessage.content);
        promptDraft.setText(restoredDraft.text);
        promptDraft.setAttachments(restoredDraft.attachments);
        setAttachmentError(null);
      })
      .catch((nextError) => {
        toast.error(getMutationErrorMessage({
          error: nextError,
          fallbackMessage: "Failed to edit queued follow-up.",
        }));
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  }, [deleteDraft, promptDraft, queuedMessages, thread.id]);

  const handleDeleteQueuedMessage = useCallback((messageId: string) => {
    setProcessingQueuedMessageId(messageId);
    void deleteDraft
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
      })
      .catch((nextError) => {
        toast.error(getMutationErrorMessage({
          error: nextError,
          fallbackMessage: "Failed to delete queued follow-up.",
        }));
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  }, [deleteDraft, thread.id]);

  const handlePromptBannerFileClick = useCallback((file: PromptBannerFile) => {
    openDiffFile(file.path);
  }, [openDiffFile]);

  return (
    <ThreadFollowUpComposer
      attachments={{
        attachmentError,
        attachments: promptDraft.attachments,
        isAttaching: uploadPromptAttachment.isPending,
        onAttachFiles: handleAttachFiles,
        onRemoveAttachment: promptDraft.removeAttachment,
        projectId,
      }}
      banner={{
        canExpandPromptChangeList,
        isChangeListExpanded,
        isDiffPanelActive: canUseGitUi && isDiffPanelActive,
        mergeBaseBranchOptions,
        mergeBaseBranchOptionsLoading: isLoadingMergeBaseBranchOptions,
        onPromptBannerFileClick: canUseGitUi ? handlePromptBannerFileClick : () => {},
        onPromptBannerMergeBaseBranchChange: showBranchComparisonUi
          ? onMergeBaseBranchChange
          : undefined,
        onPromptBannerMergeBaseBranchPickerOpenChange: showBranchComparisonUi
          ? onMergeBaseBranchPickerOpenChange
          : undefined,
        onPromptGitStatsBannerClick: canUseGitUi ? openThreadDiffPanel : () => {},
        onToggleChangeListExpanded: () => {
          setIsChangeListExpanded((previousValue) => !previousValue);
        },
        promptBannerMergeBaseBranch,
        promptBannerSummary,
        showBranchComparisonUi,
        showPromptGitStatsBanner,
        workspaceStatus,
      }}
      composer={{
        canSendFollowUp,
        composerRef: promptComposerRef,
        isFollowUpSubmitting,
        message: promptDraft.text,
        onChangeMessage: promptDraft.setText,
        onStop: () => stopThread.mutate(thread.id),
        onSubmit: handleSend,
        processingQueuedMessageId,
        promptPlaceholder,
        threadId: thread.id,
        threadStatus: thread.status,
      }}
      environment={{
        contextWindowUsage,
        environmentHostConnected,
        environmentIcon,
        environmentLabel,
      }}
      execution={{
        activeModel,
        hasMultipleProviders,
        modelOptions,
        onReasoningLevelChange: setReasoningLevel,
        onSandboxModeChange: setSandboxMode,
        onSelectedModelChange: setSelectedModel,
        onServiceTierChange: setServiceTier,
        providerDisplayName: selectedProviderDisplayName,
        providerOptions,
        reasoningLevel,
        reasoningOptions,
        sandboxMode,
        sandboxOptions,
        selectedModel,
        selectedProviderId,
        serviceTier,
        supportsServiceTier,
        serviceTierSupportByProvider,
      }}
      interactionBanner={
        activePendingInteraction ? (
          <ThreadPendingInteractionBanner
            interaction={activePendingInteraction}
            threadId={thread.id}
          />
        ) : undefined
      }
      mentions={{
        mentionError: promptMentions.isError,
        mentionLoading: promptMentions.isLoading,
        mentionSearchScope:
          promptMentions.threadSuggestionMode === "all"
            ? "files-and-threads"
            : promptMentions.threadSuggestionMode === "managers"
              ? "files-and-managers"
              : "files",
        mentionSuggestions: promptMentions.suggestions,
        onMentionQueryChange: promptMentions.setQuery,
      }}
      queue={{
        isQueueMutationPending,
        onDeleteQueuedMessage: handleDeleteQueuedMessage,
        onEditQueuedMessage: handleEditQueuedMessage,
        onScrollToBottom: scrollToBottom,
        onSendQueuedImmediately: handleSendQueuedImmediately,
        queuedMessages,
        showScrollToBottom,
      }}
    />
  );
}
