import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { assertNever } from "@bb/core-ui";
import { useActiveSecondaryPanel } from "@/lib/thread-secondary-panel";
import type {
  PendingInteraction,
  PermissionMode,
  PromptInput,
  ReasoningLevel,
  ServiceTier,
  ThreadRuntimeDisplayStatus,
  ThreadWithRuntime,
  WorkspaceFileStatus,
  WorkspaceStatus,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import { ThreadPendingInteractionBanner } from "@/components/thread/ThreadPendingInteractionBanner";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import {
  useCreateThreadDraft,
  useDeleteThreadDraft,
  useSendThreadDraft,
  useStopThread,
} from "@/hooks/mutations/thread-runtime-mutations";
import {
  getLatestPendingInteraction,
  useThreadDefaultExecutionOptions,
  useThreadDrafts,
  useThreadPromptHistory,
} from "@/hooks/queries/thread-queries";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { promptDraftToInput } from "@/lib/prompt-draft";
import { toast } from "sonner";
import { FollowUpPromptBox } from "@/components/promptbox/FollowUpPromptBox";
import { queuedInputToDraft } from "./threadQueuedMessages";
import type { SendMessageMutationLike } from "./threadDetailMutationTypes";

interface PromptBannerFile {
  path: string;
}

interface SendFollowUpInputParams {
  input: PromptInput[];
  mode?: "auto" | "steer";
  model?: string;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
}

interface ThreadDetailPromptAreaProps {
  canExpandPromptChangeList: boolean;
  canUseGitUi: boolean;
  contextWindowUsage?: ThreadTimelineResponse["contextWindowUsage"];
  environmentBranchName?: string;
  environmentHostConnected?: boolean;
  environmentIcon?: ComponentType<{ className?: string }>;
  environmentLabel?: ReactNode;
  isEnvironmentActionPending: boolean;
  isLoadingMergeBaseBranchOptions: boolean;
  mergeBaseBranchOptions?: readonly string[];
  onMergeBaseBranchChange?: (branch: string) => void;
  pendingInteractions: readonly PendingInteraction[];
  openDiffFile: (path: string) => void;
  openThreadDiffPanel: () => void;
  projectId: string;
  promptBannerFiles?: WorkspaceFileStatus[];
  promptBannerMergeBaseBranch?: string;
  promptBannerSummary: ReactNode;
  sendMessage: SendMessageMutationLike;
  showBranchComparisonUi: boolean;
  showPromptGitStatsBanner: boolean;
  thread: ThreadWithRuntime;
  workspaceStatus?: WorkspaceStatus;
}

function getPromptPlaceholder(
  displayStatus: ThreadRuntimeDisplayStatus,
  hasPendingInteraction: boolean,
): string {
  if (displayStatus === "created") {
    return "Thread is being created...";
  }
  if (displayStatus === "provisioning") {
    return "Thread is being provisioned...";
  }
  if (hasPendingInteraction) {
    return "Resolve the pending interaction below before sending another message";
  }

  switch (displayStatus) {
    case "waiting-for-host":
      return "Host daemon disconnected";
    case "host-reconnecting":
      return "Waiting for host daemon to reconnect...";
    case "error":
      return "Retry by sending a follow-up message";
    case "idle":
      return "Ask for follow-up changes";
    case "active":
      return "Send a message to this thread...";
    default:
      return assertNever(displayStatus);
  }
}

function shouldQueueFollowUpDraft(
  displayStatus: ThreadRuntimeDisplayStatus,
): boolean {
  return displayStatus === "active" || displayStatus === "host-reconnecting";
}

export function ThreadDetailPromptArea({
  canExpandPromptChangeList,
  canUseGitUi,
  contextWindowUsage,
  environmentBranchName,
  environmentHostConnected,
  environmentIcon,
  environmentLabel,
  isEnvironmentActionPending,
  isLoadingMergeBaseBranchOptions,
  mergeBaseBranchOptions,
  onMergeBaseBranchChange,
  pendingInteractions,
  openDiffFile,
  openThreadDiffPanel,
  projectId,
  promptBannerFiles,
  promptBannerMergeBaseBranch,
  promptBannerSummary,
  sendMessage,
  showBranchComparisonUi,
  showPromptGitStatsBanner,
  thread,
  workspaceStatus,
}: ThreadDetailPromptAreaProps) {
  const isDiffPanelActive = useActiveSecondaryPanel() === "git-diff";
  const { data: defaultExecutionOptions } = useThreadDefaultExecutionOptions(
    thread.id,
  );
  const { data: queuedMessages = [] } = useThreadDrafts(thread.id);
  const { data: promptHistoryEntries = [] } = useThreadPromptHistory(thread.id);
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
    environmentId: thread.environmentId ?? null,
  });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isChangeListExpanded, setIsChangeListExpanded] = useState(false);
  const [processingQueuedMessageId, setProcessingQueuedMessageId] = useState<
    string | null
  >(null);
  const promptHistoryDrafts = useMemo(
    () => promptHistoryEntriesToDrafts(promptHistoryEntries),
    [promptHistoryEntries],
  );
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
    permissionMode,
    setPermissionMode,
    activeModel,
    modelOptions,
    reasoningOptions,
    permissionModeOptions,
    supportsPermissionModeSelection,
    supportsServiceTier,
    serviceTierSupportByProvider,
  } = useThreadCreationOptions({
    scope: "thread",
    resetKey: thread.id,
    initialProviderId: thread.providerId,
    initialModel: defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialPermissionMode: defaultExecutionOptions?.permissionMode,
    initialEnvironmentSelectionValue: thread.environmentId ?? undefined,
  });
  const runtimeDisplayStatus = thread.runtime.displayStatus;
  const isCreated = runtimeDisplayStatus === "created";
  const isProvisioning = runtimeDisplayStatus === "provisioning";
  const isWaitingForHost = runtimeDisplayStatus === "waiting-for-host";
  const activePendingInteraction =
    getLatestPendingInteraction(pendingInteractions);
  const hasPendingInteraction = activePendingInteraction !== null;
  const isQueueMutationPending =
    createDraft.isPending || sendDraft.isPending || deleteDraft.isPending;
  const isFollowUpSubmitting =
    sendMessage.isPending ||
    isEnvironmentActionPending ||
    createDraft.isPending;
  const canSendFollowUp =
    !isCreated &&
    !isProvisioning &&
    !hasPendingInteraction &&
    !isWaitingForHost;
  const promptPlaceholder = getPromptPlaceholder(
    runtimeDisplayStatus,
    hasPendingInteraction,
  );
  const sendFollowUpInput = useCallback(
    async ({
      input,
      mode = "auto",
      model,
      serviceTier: executionServiceTier,
      reasoningLevel: executionReasoningLevel,
      permissionMode: executionPermissionMode,
    }: SendFollowUpInputParams) => {
      if (input.length === 0) {
        return;
      }

      await sendMessage.mutateAsync({
        id: thread.id,
        input,
        mode,
        ...(mode === "steer"
          ? {}
          : {
              ...(model ? { model } : {}),
              ...(executionServiceTier
                ? { serviceTier: executionServiceTier }
                : {}),
              ...(executionReasoningLevel
                ? { reasoningLevel: executionReasoningLevel }
                : {}),
              ...(executionPermissionMode
                ? { permissionMode: executionPermissionMode }
                : {}),
            }),
      });
    },
    [sendMessage, thread.id],
  );

  const handleAttachFiles = useCallback(
    async (files: File[]) => {
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
    },
    [projectId, promptDraft, uploadPromptAttachment],
  );

  const handleSend = useCallback(async () => {
    const submittedDraft = {
      text: promptDraft.text,
      attachments: promptDraft.attachments,
    };
    const submittedInput = promptDraftToInput(submittedDraft);
    if (submittedInput.length === 0) {
      return;
    }

    promptDraft.clearIfCurrentMatches(submittedDraft);
    setAttachmentError(null);

    const isQueuingDraft = shouldQueueFollowUpDraft(runtimeDisplayStatus);
    try {
      if (isQueuingDraft) {
        await createDraft.mutateAsync({
          id: thread.id,
          input: submittedInput,
          model: activeModel?.model ?? selectedModel,
          ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
          reasoningLevel,
          permissionMode,
        });
      } else {
        await sendFollowUpInput({
          input: submittedInput,
          model: activeModel?.model ?? selectedModel,
          ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
          reasoningLevel,
          permissionMode,
        });
      }
    } catch (nextError) {
      promptDraft.restoreIfEmpty(submittedDraft);
      toast.error(
        getMutationErrorMessage({
          error: nextError,
          fallbackMessage: isQueuingDraft
            ? "Failed to queue follow-up."
            : "Failed to send follow-up.",
        }),
      );
    }
  }, [
    activeModel?.model,
    createDraft,
    promptDraft,
    reasoningLevel,
    permissionMode,
    selectedModel,
    sendFollowUpInput,
    serviceTier,
    supportsServiceTier,
    thread.id,
    runtimeDisplayStatus,
  ]);

  const handleSendQueuedImmediately = useCallback(
    (messageId: string) => {
      const queuedMessage = queuedMessages.find(
        (candidate) => candidate.id === messageId,
      );
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
          toast.error(
            getMutationErrorMessage({
              error: nextError,
              fallbackMessage: "Failed to send queued follow-up.",
            }),
          );
        })
        .finally(() => {
          setProcessingQueuedMessageId((currentMessageId) =>
            currentMessageId === messageId ? null : currentMessageId,
          );
        });
    },
    [queuedMessages, sendDraft, thread.id],
  );

  const handleEditQueuedMessage = useCallback(
    (messageId: string) => {
      const queuedMessage = queuedMessages.find(
        (candidate) => candidate.id === messageId,
      );
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
          promptDraft.setDraft(restoredDraft);
          setAttachmentError(null);
        })
        .catch((nextError) => {
          toast.error(
            getMutationErrorMessage({
              error: nextError,
              fallbackMessage: "Failed to edit queued follow-up.",
            }),
          );
        })
        .finally(() => {
          setProcessingQueuedMessageId((currentMessageId) =>
            currentMessageId === messageId ? null : currentMessageId,
          );
        });
    },
    [deleteDraft, promptDraft, queuedMessages, thread.id],
  );

  const handleDeleteQueuedMessage = useCallback(
    (messageId: string) => {
      setProcessingQueuedMessageId(messageId);
      void deleteDraft
        .mutateAsync({
          id: thread.id,
          queuedMessageId: messageId,
        })
        .catch((nextError) => {
          toast.error(
            getMutationErrorMessage({
              error: nextError,
              fallbackMessage: "Failed to delete queued follow-up.",
            }),
          );
        })
        .finally(() => {
          setProcessingQueuedMessageId((currentMessageId) =>
            currentMessageId === messageId ? null : currentMessageId,
          );
        });
    },
    [deleteDraft, thread.id],
  );

  const handlePromptBannerFileClick = useCallback(
    (file: PromptBannerFile) => {
      openDiffFile(file.path);
    },
    [openDiffFile],
  );

  if (activePendingInteraction) {
    return (
      <ThreadPendingInteractionBanner
        interaction={activePendingInteraction}
        threadId={thread.id}
      />
    );
  }

  return (
    <FollowUpPromptBox
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
        onPromptBannerFileClick: canUseGitUi
          ? handlePromptBannerFileClick
          : () => {},
        onPromptBannerMergeBaseBranchChange: showBranchComparisonUi
          ? onMergeBaseBranchChange
          : undefined,
        onPromptGitStatsBannerClick: canUseGitUi
          ? openThreadDiffPanel
          : () => {},
        onToggleChangeListExpanded: () => {
          setIsChangeListExpanded((previousValue) => !previousValue);
        },
        promptBannerFiles,
        promptBannerMergeBaseBranch,
        promptBannerSummary,
        showBranchComparisonUi,
        showPromptGitStatsBanner,
        workspaceStatus,
      }}
      composer={{
        canSendFollowUp,
        history: {
          currentDraft: {
            text: promptDraft.text,
            attachments: promptDraft.attachments,
          },
          entries: promptHistoryDrafts,
          onSelectEntry: promptDraft.setDraft,
          resetKey: thread.id,
        },
        isFollowUpSubmitting,
        message: promptDraft.text,
        onChangeMessage: promptDraft.setText,
        onStop: () => stopThread.mutate(thread.id),
        onSubmit: handleSend,
        processingQueuedMessageId,
        promptPlaceholder,
        threadId: thread.id,
        threadRuntimeDisplayStatus: runtimeDisplayStatus,
      }}
      environment={{
        contextWindowUsage,
        environmentBranchName,
        environmentHostConnected,
        environmentIcon,
        environmentLabel,
      }}
      execution={{
        activeModel,
        hasMultipleProviders,
        modelOptions,
        onReasoningLevelChange: setReasoningLevel,
        onPermissionModeChange: setPermissionMode,
        onSelectedModelChange: setSelectedModel,
        onServiceTierChange: setServiceTier,
        providerDisplayName: selectedProviderDisplayName,
        providerOptions,
        reasoningLevel,
        reasoningOptions,
        permissionMode,
        permissionModeOptions,
        supportsPermissionModeSelection,
        selectedModel,
        selectedProviderId,
        serviceTier,
        supportsServiceTier,
        serviceTierSupportByProvider,
      }}
      mentions={{
        mentionError: promptMentions.isError,
        mentionLoading: promptMentions.isLoading,
        mentionSuggestions: promptMentions.suggestions,
        onMentionQueryChange: promptMentions.setQuery,
      }}
      queue={{
        isQueueMutationPending,
        onDeleteQueuedMessage: handleDeleteQueuedMessage,
        onEditQueuedMessage: handleEditQueuedMessage,
        onSendQueuedImmediately: handleSendQueuedImmediately,
        queuedMessages,
      }}
    />
  );
}
