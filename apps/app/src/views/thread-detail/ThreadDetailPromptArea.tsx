import { useCallback, useMemo, useState } from "react";
import type { IconName } from "@/components/ui/icon.js";
import { assertNever } from "@bb/core-ui";
import type {
  PendingInteraction,
  PermissionMode,
  PromptInput,
  ReasoningLevel,
  ServiceTier,
  ThreadRuntimeDisplayStatus,
  ThreadTimelinePendingTodos,
  ThreadWithRuntime,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import { ThreadPendingInteractionBanner } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import {
  ThreadPromptContextBanner,
  type ContextBannerMergeBaseConfig,
  type ThreadPromptContextBannerExpandedSection,
  type ThreadPromptManagedBySection,
  type ThreadPromptManagerChildrenSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import type {
  WorkspaceChangedFileSelection,
  WorkspaceChangedFilesSection,
} from "@/components/workspace/workspace-change-summary";
import { QueuedMessagesList } from "@/components/promptbox/banner/QueuedMessagesList";
import { ThreadEnvironmentSummary } from "@/components/promptbox/ThreadEnvironmentSummary";
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
import {
  FollowUpPromptBox,
  type FollowUpSubmitMode,
} from "@/components/promptbox/FollowUpPromptBox";
import { queuedInputToDraft } from "./threadQueuedMessages";
import type { SendMessageMutationLike } from "./threadDetailMutationTypes";

interface SendFollowUpInputParams {
  input: PromptInput[];
  mode?: "auto" | "steer";
  model?: string;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
}

type ComposerQueryRefetchOnMount = boolean | "always";

interface ThreadDetailPromptAreaProps {
  canUseGitUi: boolean;
  composerQueriesEnabled: boolean;
  composerQueriesRefetchOnMount: ComposerQueryRefetchOnMount;
  composerQueriesStaleTime?: number;
  contextWindowUsage?: ThreadTimelineResponse["contextWindowUsage"];
  environmentBranchName?: string;
  environmentHostConnected?: boolean;
  environmentHostLabel?: string;
  environmentIcon?: IconName;
  environmentLabel?: string;
  isEnvironmentActionPending: boolean;
  pendingInteractions: readonly PendingInteraction[];
  onChangedFileClick: (selection: WorkspaceChangedFileSelection) => void;
  openThreadDiffPanel: () => void;
  projectId: string;
  /**
   * Resolved changed-files section for the thread's workspace. Null hides the
   * banner. Production passes null when the thread is a manager
   * (canUseGitUi === false) or the workspace has no changes; otherwise the
   * value is selectWorkspaceChangedFilesSection(workspaceStatus).
   */
  workspaceChangedFilesSection: WorkspaceChangedFilesSection | null;
  /**
   * True while the workspace status query is in flight on initial load.
   * Suppresses the prompt context banner until the result settles so the
   * banner's first paint is its final form.
   */
  workspaceStatusPending: boolean;
  /**
   * Merge-base picker config for the prompt context banner. Null hides the
   * picker (e.g. thread is on default branch — no merge base to compare).
   */
  contextBannerMergeBase: ContextBannerMergeBaseConfig | null;
  /** Latest TODO snapshot from the timeline projection. Null on older pages or when no candidate observed. */
  pendingTodos: ThreadTimelinePendingTodos | null;
  /** Manager reference for managed threads. Null for unmanaged or manager threads. */
  managedBySection: ThreadPromptManagedBySection | null;
  /** Active managed children for manager threads. Null otherwise. */
  managerChildrenSection: ThreadPromptManagerChildrenSection | null;
  sendMessage: SendMessageMutationLike;
  thread: ThreadWithRuntime;
}

function getPromptPlaceholder(
  displayStatus: ThreadRuntimeDisplayStatus,
  isManagerThread: boolean,
): string {
  if (displayStatus === "created" || displayStatus === "provisioning") {
    return isManagerThread ? "Hiring manager..." : "Creating thread...";
  }

  switch (displayStatus) {
    case "waiting-for-host":
      return "Host daemon disconnected";
    case "host-reconnecting":
      return "Waiting for host daemon to reconnect...";
    case "error":
      return "Retry by sending a follow-up message";
    case "idle":
    case "active":
      return isManagerThread
        ? "Send a message. @ to mention files or threads"
        : "Ask for follow-up changes. @ to mention files";
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
  canUseGitUi,
  composerQueriesEnabled,
  composerQueriesRefetchOnMount,
  composerQueriesStaleTime,
  contextWindowUsage,
  environmentBranchName,
  environmentHostConnected,
  environmentHostLabel,
  environmentIcon,
  environmentLabel,
  isEnvironmentActionPending,
  pendingInteractions,
  onChangedFileClick,
  openThreadDiffPanel,
  projectId,
  workspaceChangedFilesSection,
  workspaceStatusPending,
  contextBannerMergeBase,
  pendingTodos,
  managedBySection,
  managerChildrenSection,
  sendMessage,
  thread,
}: ThreadDetailPromptAreaProps) {
  const { data: defaultExecutionOptions } = useThreadDefaultExecutionOptions(
    thread.id,
    {
      enabled: composerQueriesEnabled,
      refetchOnMount: composerQueriesRefetchOnMount,
      staleTime: composerQueriesStaleTime,
    },
  );
  const { data: queuedMessages = [] } = useThreadDrafts(thread.id, {
    enabled: composerQueriesEnabled,
    refetchOnMount: composerQueriesRefetchOnMount,
    staleTime: composerQueriesStaleTime,
  });
  const { data: promptHistoryEntries = [] } = useThreadPromptHistory(
    thread.id,
    {
      enabled: composerQueriesEnabled,
      refetchOnMount: composerQueriesRefetchOnMount,
      staleTime: composerQueriesStaleTime,
    },
  );
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
  const [expandedBannerSection, setExpandedBannerSection] =
    useState<ThreadPromptContextBannerExpandedSection | null>(null);
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
    enabled: composerQueriesEnabled,
    environmentId: thread.environmentId ?? undefined,
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
  const isStopRequested =
    thread.stopRequestedAt !== null ||
    (stopThread.isPending && stopThread.variables === thread.id);
  const activePendingInteraction =
    getLatestPendingInteraction(pendingInteractions);
  const hasPendingInteraction = activePendingInteraction !== null;
  const isQueueMutationPending =
    createDraft.isPending || sendDraft.isPending || deleteDraft.isPending;
  const isFollowUpSubmitting =
    sendMessage.isPending ||
    isEnvironmentActionPending ||
    createDraft.isPending;
  const submitMode: FollowUpSubmitMode = (() => {
    if (isStopRequested) {
      return { kind: "blocked", reason: "stopping" };
    }
    if (hasPendingInteraction) {
      return { kind: "blocked", reason: "pending-interaction" };
    }
    if (isCreated || isProvisioning) {
      return { kind: "blocked", reason: "provisioning" };
    }
    if (isWaitingForHost) {
      return { kind: "stop-only", onStop: () => stopThread.mutate(thread.id) };
    }
    if (
      runtimeDisplayStatus === "active" ||
      runtimeDisplayStatus === "host-reconnecting"
    ) {
      return { kind: "queue", onStop: () => stopThread.mutate(thread.id) };
    }
    return { kind: "ready" };
  })();
  const promptPlaceholder = isStopRequested
    ? "Stopping thread..."
    : getPromptPlaceholder(runtimeDisplayStatus, thread.type === "manager");
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
    (selection: WorkspaceChangedFileSelection) => {
      onChangedFileClick(selection);
    },
    [onChangedFileClick],
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
        items: promptDraft.attachments,
        projectId,
        isAttaching: uploadPromptAttachment.isPending,
        error: attachmentError,
        onAttachFiles: handleAttachFiles,
        onRemove: promptDraft.removeAttachment,
      }}
      stack={
        <>
          <ThreadPromptContextBanner
            todoSection={
              thread.type === "manager" || !pendingTodos
                ? null
                : { pendingTodos }
            }
            archivedSection={
              thread.archivedAt !== null
                ? { archivedAt: thread.archivedAt }
                : null
            }
            managedBySection={managedBySection}
            managerChildrenSection={managerChildrenSection}
            gitSection={
              workspaceChangedFilesSection
                ? {
                    changedFiles: workspaceChangedFilesSection,
                    mergeBase: contextBannerMergeBase,
                    onPromptBannerFileClick: canUseGitUi
                      ? handlePromptBannerFileClick
                      : () => {},
                  }
                : null
            }
            gitSectionPending={workspaceStatusPending}
            expandedSection={expandedBannerSection}
            onToggleSection={(section) => {
              setExpandedBannerSection((previous) =>
                previous === section ? null : section,
              );
            }}
          />
          <QueuedMessagesList
            queuedMessages={queuedMessages}
            sendDisabled={
              !(submitMode.kind === "ready" || submitMode.kind === "queue") ||
              isFollowUpSubmitting ||
              isQueueMutationPending
            }
            actionDisabled={isQueueMutationPending}
            processingMessageId={processingQueuedMessageId}
            onSendImmediately={handleSendQueuedImmediately}
            onEdit={handleEditQueuedMessage}
            onDelete={handleDeleteQueuedMessage}
          />
        </>
      }
      composer={{
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
        onSubmit: handleSend,
        promptPlaceholder,
        submitMode,
        threadRuntimeDisplayStatus: runtimeDisplayStatus,
      }}
      zenModeResetKey={thread.id}
      environmentSummary={
        environmentLabel || environmentHostConnected !== undefined ? (
          <ThreadEnvironmentSummary
            environmentLabel={environmentLabel}
            environmentHostLabel={environmentHostLabel}
            environmentHostConnected={environmentHostConnected}
            environmentIcon={environmentIcon}
            environmentBranchName={environmentBranchName}
          />
        ) : null
      }
      contextWindowUsage={contextWindowUsage ?? null}
      execution={{
        provider: {
          options: providerOptions,
          selectedId: selectedProviderId,
          hasMultiple: hasMultipleProviders,
          displayName: selectedProviderDisplayName,
        },
        model: {
          active: activeModel,
          selected: selectedModel,
          options: modelOptions,
          onChange: setSelectedModel,
        },
        serviceTier: {
          value: serviceTier,
          onChange: setServiceTier,
          supported: supportsServiceTier,
          supportByProvider: serviceTierSupportByProvider,
        },
        reasoning: {
          value: reasoningLevel,
          options: reasoningOptions,
          onChange: setReasoningLevel,
        },
      }}
      permission={{
        value: permissionMode,
        options: permissionModeOptions,
        onChange: setPermissionMode,
        supported: supportsPermissionModeSelection,
      }}
      mentions={{
        suggestions: promptMentions.suggestions,
        isLoading: promptMentions.isLoading,
        isError: promptMentions.isError,
        onQueryChange: promptMentions.setQuery,
      }}
    />
  );
}
