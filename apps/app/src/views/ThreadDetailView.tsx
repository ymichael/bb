import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  useThread,
  useEnvironment,
  useEnvironmentWorkStatus,
  useThreadTimeline,
  useThreadTimelineToolDetails,
  useSendThreadMessage,
  useCreateThreadDraft,
  useSendThreadDraft,
  useDeleteThreadDraft,
  useArchiveThread,
  useRequestEnvironmentAction,
  useStopThread,
  useMarkThreadRead,
  useMarkThreadUnread,
  useDeleteThread,
  useUnarchiveThread,
  useThreadDefaultExecutionOptions,
  useThreadDrafts,
  useThreads,
  useUpdateEnvironment,
  useUpdateThread,
  useUploadPromptAttachment,
} from "../hooks/useApi";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { usePreferredTheme } from "@/hooks/useTheme";
import { useDialogState } from "@/hooks/useDialogState";
import { PageShell } from "@/components/layout/PageShell";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import {
  ThreadGitActionDialogError,
  ThreadGitActionDialog,
  type ThreadGitActionDialogTarget,
} from "@/components/thread/ThreadGitActionDialog";
import {
  ThreadRenameDialog,
  type ThreadRenameDialogTarget,
} from "@/components/thread/ThreadRenameDialog";
import { ThreadDeleteDialog } from "@/components/thread/ThreadDeleteDialog";
import {
  buildCommitFailureFollowUpInstruction,
  buildSquashMergeCommitFailureFollowUpInstruction,
  buildSquashMergeConflictFollowUpInstruction,
} from "@/lib/thread-operation-prompts";
import { formatEnvironmentDisplay } from "@bb/core-ui";
import { findLatestActivityRowId } from "@bb/ui-core";
import type { PromptInput, ServiceTier, Thread } from "@bb/domain";
import type { EnvironmentActionFailureDetails } from "@bb/server-contract";
import { environmentActionFailureDetailsSchema } from "@bb/server-contract";
import { promptDraftToInput } from "@/lib/prompt-draft";
import { HttpError } from "@/lib/api";
import { useStoredShowAllEvents } from "@/lib/show-all-events-preference";
import { getGitStatusDisplay } from "@/lib/workspace-status";
import {
  formatChangeSummary,
  formatWorkspaceChangeSummary,
} from "@/lib/workspace-change-summary";
import { getThreadDisplayTitle, threadTypeLabel } from "@/lib/thread-title";
import {
  isArchiveForceRequiredError,
  requiresArchiveConfirmation,
} from "@/lib/thread-archive";
import { queuedInputToDraft } from "./threadQueuedMessages";
import { useGitDiffPanel } from "./useGitDiffPanel";
import { useThreadTimelineController } from "./useThreadTimelineController";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import { ThreadFollowUpComposer } from "./ThreadFollowUpComposer";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import { useThreadStorageViewer } from "./useThreadStorageViewer";
import { useThreadFollowUpTracking } from "./useThreadFollowUpTracking";
import { useEnvironmentMergeBase } from "./useEnvironmentMergeBase";
import { useThreadReadTracking } from "./useThreadReadTracking";
import { toast } from "sonner";

function toEnvironmentActionFailureDetails(error: unknown): EnvironmentActionFailureDetails | undefined {
  if (!(error instanceof HttpError) || typeof error.body !== "object" || error.body === null) {
    return undefined;
  }
  const body = error.body as Record<string, unknown>;
  const result = environmentActionFailureDetailsSchema.safeParse(body.details);
  return result.success ? result.data : undefined;
}

function buildAskAgentInputForGitOperation(args: {
  error: unknown;
  mergeBaseBranch?: string;
}): PromptInput[] | undefined {
  const { error, mergeBaseBranch } = args;
  const details = toEnvironmentActionFailureDetails(error);
  if (!details) {
    return undefined;
  }
  switch (details.kind) {
    case "commit_failed":
      return [
        {
          type: "text",
          text: buildCommitFailureFollowUpInstruction(
            { errorMessage: details.errorMessage },
          ),
        },
      ];
    case "squash_merge_conflict":
      if (!mergeBaseBranch) {
        return undefined;
      }
      return [
        {
          type: "text",
          text: buildSquashMergeConflictFollowUpInstruction(
            {
              action: "squash_merge",
              options: {
                mergeBaseBranch,
              },
            },
            { conflictFiles: details.conflictFiles },
          ),
        },
      ];
    case "squash_merge_commit_failed":
      if (!mergeBaseBranch) {
        return undefined;
      }
      return [
        {
          type: "text",
          text: buildSquashMergeCommitFailureFollowUpInstruction(
            {
              action: "squash_merge",
              options: {
                mergeBaseBranch,
              },
            },
            {
              stage: details.stage,
              errorMessage: details.errorMessage,
            },
          ),
        },
      ];
    default:
      return undefined;
  }
}

function toThreadGitActionDialogError(args: {
  error: unknown;
  mergeBaseBranch?: string;
}): ThreadGitActionDialogError {
  const { error, mergeBaseBranch } = args;
  const message =
    error instanceof Error ? error.message : "Failed to start git action";
  return new ThreadGitActionDialogError(message, {
    askAgentInput: buildAskAgentInputForGitOperation({
      error,
      mergeBaseBranch,
    }),
  });
}

export function ThreadDetailView() {
  const { projectId, threadId } = useParams<{
    projectId: string;
    threadId: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: thread, isLoading, error } = useThread(threadId ?? "", {
    refetchOnMount: "always",
  });
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const isManagerThread = thread?.type === "manager";
  const [storedShowAllEvents, setStoredShowAllEvents] = useStoredShowAllEvents();
  const showAllEvents = isManagerThread ? storedShowAllEvents : false;
  const {
    isThreadStorageFilePreviewLoading,
    threadStorageFilePreview,
    threadStorageFilePreviewError,
    threadStorageFiles,
    selectedThreadStoragePath,
    setSelectedThreadStoragePath,
  } = useThreadStorageViewer({
    threadId,
    threadType: thread?.type,
  });
  const handleShowAllEventsChange = useCallback((checked: boolean) => {
    if (!isManagerThread) {
      return;
    }

    setStoredShowAllEvents(checked);
  }, [isManagerThread, setStoredShowAllEvents]);
  const { data: allProjectThreads } = useThreads({ projectId });
  const { data: queuedMessages = [] } = useThreadDrafts(threadId ?? "");
  const managerThreads = useMemo(
    () => (allProjectThreads ?? []).filter((candidate) => candidate.type === "manager"),
    [allProjectThreads],
  );
  const { data: timeline, isLoading: timelineLoading } = useThreadTimeline(
    threadId ?? "",
    {
      refetchOnMount: "always",
      includeAllEvents: showAllEvents,
    },
  );
  const { data: defaultExecutionOptions } = useThreadDefaultExecutionOptions(
    threadId ?? "",
  );
  const timelineToolDetails = useThreadTimelineToolDetails();
  const sendMessage = useSendThreadMessage();
  const createDraft = useCreateThreadDraft();
  const sendDraft = useSendThreadDraft();
  const deleteDraft = useDeleteThreadDraft();
  const archiveThread = useArchiveThread();
  const requestEnvironmentAction = useRequestEnvironmentAction();
  const stopThread = useStopThread();
  const unarchiveThread = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
  const markThreadUnread = useMarkThreadUnread();
  const deleteThread = useDeleteThread();
  const updateEnvironment = useUpdateEnvironment();
  const updateThread = useUpdateThread();
  const uploadPromptAttachment = useUploadPromptAttachment();
  const promptDraft = usePromptDraftStorage({ projectId, threadId });
  const promptMentions = usePromptMentions(projectId, {
    threadSuggestionMode:
      thread?.type === "manager" ? "all" : thread ? "managers" : "none",
    currentThreadId: threadId,
  });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isChangeListExpanded, setIsChangeListExpanded] = useState(false);
  const [processingQueuedMessageId, setProcessingQueuedMessageId] =
    useState<string | null>(null);
  const threadRenameDialog = useDialogState<ThreadRenameDialogTarget>();
  const threadDeleteDialog = useDialogState<Thread>();
  const threadGitActionDialog = useDialogState<ThreadGitActionDialogTarget>();
  const captureTimelineScrollPositionRef = useRef<() => void>(() => {});
  const promptInput = useMemo(
    () =>
      promptDraftToInput({
        text: promptDraft.text,
        attachments: promptDraft.attachments,
      }),
    [promptDraft.attachments, promptDraft.text],
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
    sandboxMode,
    setSandboxMode,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions,
    supportsServiceTier,
  } = useThreadCreationOptions({
    scope: "thread",
    resetKey: threadId,
    initialProviderId: thread?.providerId,
    initialModel: defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialSandboxMode: defaultExecutionOptions?.sandboxMode,
    initialEnvironmentSelectionValue: thread?.environmentId ?? undefined,
  });
  const preferredTheme = usePreferredTheme();
  const threadDetailRows = useMemo(() => timeline?.rows ?? [], [timeline?.rows]);
  const contextWindowUsage = timeline?.contextWindowUsage ?? undefined;
  const latestActivityRowId = useMemo(
    () => findLatestActivityRowId(threadDetailRows),
    [threadDetailRows],
  );
  const environmentQuery = useEnvironment(thread?.environmentId);
  const environment = environmentQuery.data;
  const {
    activeSecondaryPanel,
    areAllGitDiffFilesCollapsed,
    closeThreadSecondaryPanel,
    collapsedGitDiffFileKeys,
    currentGitDiff,
    gitDiffDisplayMode,
    gitDiffError,
    gitDiffSelectOptions,
    gitDiffSelectValue,
    gitDiffStatsLabel,
    gitDiffViewOptions,
    handleGitDiffDisplayModeChange,
    handleSecondaryPanelDragging,
    handleSecondaryPanelResize,
    isDiffPanelActive,
    isGitDiffLoading,
    isLoadingMergeBaseBranchOptions,
    isSecondaryPanelOpen,
    isSecondaryPanelResizing,
    isParsingGitDiffFiles,
    isPreparingGitDiff,
    loadingGitDiffFileKeys,
    mergeBaseBranchOptions,
    onGitDiffSelectionChange,
    onMergeBaseBranchPickerOpenChange,
    openDiffFile,
    openThreadDiffPanel,
    openThreadSecondaryPanel,
    parsedGitDiffFileEntries,
    queuedGitDiffFileRenderKeys,
    secondaryPanelRef,
    secondaryResizablePanelRef,
    selectedMergeBaseBranch,
    setGitDiffFileRef,
    setSelectedMergeBaseBranch,
    threadGitDiff,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
    toggleThreadSecondaryPanel,
  } = useGitDiffPanel({
    location,
    navigate,
    onBeforePanelChange: () => {
      captureTimelineScrollPositionRef.current();
    },
    preferredTheme,
    defaultMergeBaseBranch:
      environment?.mergeBaseBranch ?? environment?.defaultBranch ?? undefined,
    environmentId: thread?.environmentId ?? undefined,
  });
  const requestedMergeBaseBranch =
    selectedMergeBaseBranch ??
    environment?.mergeBaseBranch ??
    environment?.defaultBranch ??
    undefined;
  const workStatusQuery = useEnvironmentWorkStatus(
    thread?.environmentId,
    requestedMergeBaseBranch,
  );
  const workStatus = workStatusQuery.data;
  const workspaceStatusError = workStatusQuery.error;
  const workspaceStatus =
    workspaceStatusError ? undefined : (workStatus ?? undefined);
  const workspaceWorkingTree = workspaceStatus?.workingTree;
  const workspaceBranch = workspaceStatus?.branch;
  const workspaceMergeBase = workspaceStatus?.mergeBase;
  const { isLocalHost, openPath } = useHostDaemon();
  const isReasoningBlockActive = false;
  const isThreadTimelinePending = timelineLoading && threadDetailRows.length === 0;
  const {
    bottomSentinelRef,
    captureTimelineScrollPosition,
    handleLoadToolGroupMessages,
    handleTimelineScroll,
    loadingToolGroupIds,
    promptComposerRef,
    scrollToBottom,
    setContainerRef,
    showScrollToBottom,
    toolGroupMessagesById,
  } = useThreadTimelineController({
    threadId,
    threadDetailRows,
    isSecondaryPanelOpen,
    loadToolGroupMessages: (args) =>
      timelineToolDetails.mutateAsync({
        ...args,
        includeAllEvents: showAllEvents,
      }),
  });
  captureTimelineScrollPositionRef.current = captureTimelineScrollPosition;
  const handleFollowUpAcknowledged = useCallback(() => {
    promptDraft.clear();
  }, [promptDraft]);
  const {
    beginPendingFollowUp,
    clearPendingFollowUp,
    pendingSubmittedFollowUp,
  } = useThreadFollowUpTracking({
    threadDetailRows,
    threadId,
    onAcknowledged: handleFollowUpAcknowledged,
  });
  useThreadReadTracking({
    markThreadRead,
    thread,
  });
  const {
    canSelectMergeBase,
    effectiveMergeBaseBranch,
    handleMergeBaseBranchChange,
    showBranchComparisonUi,
    showMergeBase,
    mergeBaseBranch,
    mergeBaseCandidates,
  } = useEnvironmentMergeBase({
    environment,
    mergeBaseBranchOptions,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
    thread,
    updateEnvironment,
    workspaceStatus,
  });

  const renameThread = useCallback(() => {
    if (!thread || updateThread.isPending) return;
    threadRenameDialog.onOpen({
      id: thread.id,
      currentTitle: getThreadDisplayTitle(thread),
      threadType: thread.type,
    });
  }, [thread, threadRenameDialog, updateThread.isPending]);
  const submitThreadRename = useCallback((currentThreadId: string, title: string) => {
    updateThread.mutate(
      {
        id: currentThreadId,
        title,
      },
      {
        onSuccess: () => {
          threadRenameDialog.onClose();
        },
      },
    );
  }, [threadRenameDialog, updateThread]);
  const toggleArchiveThread = useCallback(() => {
    if (!thread) return;
    const label = threadTypeLabel(thread.type);
    if (thread.archivedAt != null) {
      unarchiveThread.mutate({ id: thread.id });
      return;
    }

    const archiveWithForce = () => {
      archiveThread.mutate(
        { id: thread.id, force: true },
        {
          onSuccess: () => {
            navigate(`/projects/${thread.projectId}`);
          },
          onError: (nextError) => {
            toast.error(
              nextError instanceof Error ? nextError.message : `Failed to archive ${label}.`,
            );
          },
        },
      );
    };

    if (requiresArchiveConfirmation(workStatus, environment)) {
      const confirmed = window.confirm(
        `This ${label} has uncommitted or unmerged work. Archive anyway?`,
      );
      if (!confirmed) {
        return;
      }
      archiveWithForce();
      return;
    }

    archiveThread.mutate(
      { id: thread.id, force: false },
      {
        onSuccess: () => {
          navigate(`/projects/${thread.projectId}`);
        },
        onError: (nextError) => {
          if (isArchiveForceRequiredError(nextError)) {
            const confirmed = window.confirm(
              `This ${label} has uncommitted or unmerged work. Archive anyway?`,
            );
            if (confirmed) {
              archiveWithForce();
            }
            return;
          }
          toast.error(
            nextError instanceof Error ? nextError.message : `Failed to archive ${label}.`,
          );
        },
      },
    );
  }, [archiveThread, environment, navigate, thread, unarchiveThread, workStatus]);
  const handlePromptGitStatsBannerClick = useCallback(() => {
    openThreadDiffPanel();
  }, [openThreadDiffPanel]);
  const handlePromptBannerFileClick = useCallback(
    (file: { path: string }) => {
      openDiffFile(file.path);
    },
    [openDiffFile],
  );
  const sendFollowUpInput = useCallback(
    async ({
      input,
      mode = "auto",
      model,
      serviceTier: executionServiceTier,
      reasoningLevel: executionReasoningLevel,
      sandboxMode: executionSandboxMode,
    }: {
      input: PromptInput[];
      mode?: "auto" | "steer";
      model?: string;
      serviceTier?: ServiceTier;
      reasoningLevel?: "low" | "medium" | "high" | "xhigh";
      sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    }) => {
      if (!threadId || input.length === 0) return;
      scrollToBottom();
      await sendMessage.mutateAsync({
        id: threadId,
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
    [
      scrollToBottom,
      sendMessage,
      threadId,
    ],
  );
  const parentThreadId = thread?.parentThreadId;
  const parentThreadDisplayName =
    parentThread?.title && parentThread.title.trim().length > 0
      ? parentThread.title
      : parentThreadId;
  const managerSelectorOptions = useMemo(() => {
    if (!thread || isManagerThread) {
      return [];
    }

    const options: Array<{ value: string; label: string }> = [{ value: "none", label: "None" }];
    const seen = new Set<string>(["none"]);
    const addOption = (value: string | undefined, label: string) => {
      if (!value || value === thread.id || seen.has(value)) {
        return;
      }
      seen.add(value);
      options.push({ value, label });
    };

    addOption(parentThreadId ?? undefined, parentThreadDisplayName ?? "Manager");
    for (const manager of managerThreads) {
      addOption(manager.id, manager.title?.trim() ? manager.title : "Manager");
    }

    return options;
  }, [
    isManagerThread,
    managerThreads,
    parentThreadDisplayName,
    parentThreadId,
    thread,
  ]);
  const managerSelectorValue = parentThreadId ?? "none";
  const selectedManagerOption = managerSelectorOptions.find(
    (option) => option.value === managerSelectorValue,
  );
  const handleAssignManager = useCallback((nextParentThreadId: string | null) => {
    if (!thread || updateThread.isPending) {
      return;
    }

    updateThread.mutate({
      id: thread.id,
      parentThreadId: nextParentThreadId,
    });
  }, [thread, updateThread]);
  const handleThreadStoragePathToggle = useCallback((path: string) => {
    setSelectedThreadStoragePath((currentPath) =>
      currentPath === path ? null : path,
    );
  }, [setSelectedThreadStoragePath]);
  const handleAttachFiles = useCallback(async (files: File[]) => {
    if (!projectId || files.length === 0) return;

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

  if (!projectId || !threadId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">Not found</p>
      </PageShell>
    );
  }
  if (isLoading) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">Loading...</p>
      </PageShell>
    );
  }
  const isTransientThreadLoadError =
    Boolean(thread) &&
    Boolean(error) &&
    (!(error instanceof HttpError) || error.status >= 500);
  if (
    (!thread && Boolean(error)) ||
    !thread ||
    (!isTransientThreadLoadError && Boolean(error)) ||
    thread.projectId !== projectId
  ) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          {error ? error.message : "Not found"}
        </p>
      </PageShell>
    );
  }

  const isCreated = thread.status === "created";
  const isProvisioning = thread.status === "provisioning";
  const isRuntimeError = thread.status === "error";
  const isQueueMutationPending =
    createDraft.isPending ||
    sendDraft.isPending ||
    deleteDraft.isPending;
  const isFollowUpSubmitting =
    sendMessage.isPending ||
    pendingSubmittedFollowUp !== null ||
    requestEnvironmentAction.isPending ||
    createDraft.isPending;
  const canSendFollowUp = !isCreated && !isProvisioning;
  const promptPlaceholder =
    isCreated
      ? "Thread is being created..."
      : isProvisioning
      ? "Thread is provisioning..."
      : isRuntimeError
      ? "Retry by sending a follow-up message"
      : thread.status === "idle"
      ? "Ask for follow-up changes"
      : "Send a message to this thread...";
  const canUseGitUi = !isManagerThread;
  const canAssignToManager =
    thread.type === "standard" &&
    !thread.parentThreadId &&
    managerThreads.length > 0 &&
    !managerThreads.some((manager) => manager.id === thread.id);
  const canTakeOverThread =
    thread.type === "standard" && Boolean(thread.parentThreadId);
  const isArchivedThread = thread.archivedAt != null;
  const isDirectThreadEnvironment =
    environment?.managed === false;
  const threadHeaderGitAction: {
    target: ThreadGitActionDialogTarget;
    label: string;
  } | null = (() => {
    if (!canUseGitUi || !workspaceStatus || isArchivedThread) {
      return null;
    }

    if (isDirectThreadEnvironment) {
      if (!workspaceWorkingTree?.hasUncommittedChanges) {
        return null;
      }
      return {
        target: { kind: "commit" },
        label: "Commit",
      };
    }

    if (
      environment?.managed &&
      (
        workspaceMergeBase?.hasCommittedUnmergedChanges ||
        workspaceWorkingTree?.hasUncommittedChanges
      )
    ) {
      return {
        target: {
          kind: workspaceWorkingTree?.hasUncommittedChanges
            ? "commit_and_squash_merge"
            : "squash_merge",
        },
        label: "Squash merge",
      };
    }

    return null;
  })();
  const isThreadGitActionPending = requestEnvironmentAction.isPending;
  const threadEnvironmentLabel = environment
    ? formatEnvironmentDisplay(environment, isLocalHost(environment.hostId)).label
    : undefined;
  const provisioningStatusLabel =
    isCreated
      ? "Created..."
      : isProvisioning
      ? "Provisioning..."
      : undefined;
  const promptBannerSummary = workspaceStatus
    ? showBranchComparisonUi
      ? formatChangeSummary(workspaceStatus.workingTree)
      : formatWorkspaceChangeSummary(workspaceStatus.workingTree)
    : "";
  const showPromptGitStatsBanner = canUseGitUi && Boolean(
    workspaceStatus &&
    workspaceStatus.workingTree.changedFiles > 0,
  );
  const canExpandPromptChangeList = Boolean(
    canUseGitUi &&
    workspaceStatus &&
    (workspaceWorkingTree?.files.length ?? 0) > 0,
  );
  const promptBannerMergeBaseBranch = effectiveMergeBaseBranch;
  const threadEnvironmentType =
    threadEnvironmentLabel ??
    (environment ? "environment" : undefined);
  const threadEnvironmentValue: ReactNode | undefined = threadEnvironmentLabel ?? undefined;
  const threadBranchName = workspaceBranch?.currentBranch ?? undefined;
  const showWorkspaceStatus =
    canUseGitUi &&
    (Boolean(workspaceStatus) || Boolean(workspaceStatusError)) &&
    !(thread.archivedAt != null && environment?.managed !== true);
  const threadGitStatusDisplay = getGitStatusDisplay(
    workspaceStatus,
    {
      mergeBaseBranch,
      showBranchComparison: showBranchComparisonUi,
    },
  );
  const threadGitStatusLabelClass = workspaceWorkingTree?.state === "deleted"
    ? "text-destructive"
    : workspaceWorkingTree?.state === "untracked"
      ? "text-muted-foreground"
      : "text-foreground";
  const showThreadChangedFiles = canUseGitUi && Boolean(
    workspaceStatus &&
      (
        workspaceWorkingTree?.state === "dirty_uncommitted" ||
        workspaceWorkingTree?.state === "dirty_and_committed_unmerged" ||
        workspaceWorkingTree?.state === "committed_unmerged"
      ) &&
      (workspaceWorkingTree?.files.length ?? 0) > 0,
  );
  const showThreadMetadata = Boolean(
    isManagerThread ||
    parentThreadId ||
      (!isManagerThread && threadEnvironmentType) ||
      (!isManagerThread && threadBranchName) ||
      (!isManagerThread && showMergeBase) ||
      showWorkspaceStatus ||
      showThreadChangedFiles ||
      thread.archivedAt != null,
  );
  const threadTitle = getThreadDisplayTitle(thread);
  const threadActionsDisabled =
    archiveThread.isPending ||
    unarchiveThread.isPending ||
    markThreadRead.isPending ||
    markThreadUnread.isPending ||
    deleteThread.isPending ||
    updateThread.isPending ||
    updateEnvironment.isPending;
  const handleCopyThreadBranch = async () => {
    if (!threadBranchName) {
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast.error("Failed to copy branch name");
      return;
    }
    try {
      await navigator.clipboard.writeText(threadBranchName);
      toast.success("Branch name copied");
    } catch {
      toast.error("Failed to copy branch name");
    }
  };
  const handleCommitThread = async () => {
    const attachedEnvironmentId = thread.environmentId;
    if (!attachedEnvironmentId) {
      return;
    }
    try {
      await requestEnvironmentAction.mutateAsync({
        id: attachedEnvironmentId,
        action: "commit",
      });
    } catch (nextError) {
      throw toThreadGitActionDialogError({ error: nextError });
    }
  };
  const handleSquashMergeThread = async ({
    mergeBaseBranch,
  }: {
    mergeBaseBranch: string;
  }) => {
    const attachedEnvironmentId = thread.environmentId;
    if (!attachedEnvironmentId) {
      return;
    }
    try {
      await requestEnvironmentAction.mutateAsync({
        id: attachedEnvironmentId,
        action: "squash_merge",
        options: {
          mergeBaseBranch,
        },
      });
    } catch (nextError) {
      throw toThreadGitActionDialogError({
        error: nextError,
        mergeBaseBranch,
      });
    }
  };
  const handleAskAgentToFixGitAction = async (input: PromptInput[]) => {
    if (!threadId) {
      return;
    }
    await sendMessage.mutateAsync({
      id: threadId,
      input,
      mode: "auto",
    });
  };
  const threadActionsMenu = (
    <ThreadActionsMenu
      triggerClassName="h-7 w-7 rounded-md p-0 text-muted-foreground"
      disabled={threadActionsDisabled}
      align="end"
      isRead={(thread.lastReadAt ?? 0) >= thread.updatedAt}
      onToggleRead={() => {
        if ((thread.lastReadAt ?? 0) >= thread.updatedAt) {
          markThreadUnread.mutate(thread.id);
          return;
        }
        markThreadRead.mutate(thread.id);
      }}
      onRename={renameThread}
      onToggleArchive={() => {
        void toggleArchiveThread();
      }}
      onDelete={() => {
        threadDeleteDialog.onOpen(thread);
      }}
      viewerToggleLabel={isManagerThread ? "Show all events" : undefined}
      viewerToggleChecked={isManagerThread ? showAllEvents : undefined}
      onViewerToggleCheckedChange={
        isManagerThread ? handleShowAllEventsChange : undefined
      }
      isArchived={thread.archivedAt != null}
      threadType={thread.type}
    />
  );
  const handleSend = async () => {
    if (promptInput.length === 0) return;

    if (thread.status === "active") {
      try {
        await createDraft.mutateAsync({
          id: thread.id,
          input: promptInput,
          model: activeModel?.model ?? selectedModel,
          ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
          reasoningLevel,
          sandboxMode,
        });
        promptDraft.clear();
        setAttachmentError(null);
      } catch (nextError) {
        window.alert(nextError instanceof Error ? nextError.message : "Failed to queue follow-up");
      }
      return;
    }

    beginPendingFollowUp(promptInput);
    setAttachmentError(null);

    try {
      await sendFollowUpInput({
        input: promptInput,
        model: activeModel?.model ?? selectedModel,
        ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
        reasoningLevel,
        sandboxMode,
      });
    } catch (nextError) {
      clearPendingFollowUp();
      window.alert(nextError instanceof Error ? nextError.message : "Failed to send follow-up");
    }
  };
  const handleSendQueuedImmediately = (messageId: string) => {
    const queuedMessage = queuedMessages.find((candidate) => candidate.id === messageId);
    if (!queuedMessage) return;

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
        window.alert(
          nextError instanceof Error ? nextError.message : "Failed to send queued follow-up",
        );
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  };
  const handleEditQueuedMessage = (messageId: string) => {
    const queuedMessage = queuedMessages.find((candidate) => candidate.id === messageId);
    if (!queuedMessage) return;

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
        window.alert(
          nextError instanceof Error ? nextError.message : "Failed to edit queued follow-up",
        );
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  };
  const handleDeleteQueuedMessage = (messageId: string) => {
    setProcessingQueuedMessageId(messageId);
    void deleteDraft
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
      })
      .catch((nextError) => {
        window.alert(
          nextError instanceof Error ? nextError.message : "Failed to delete queued follow-up",
        );
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  };
  const effectiveSecondaryPanel =
    !canUseGitUi && activeSecondaryPanel === "git-diff"
      ? "thread-info"
      : !isManagerThread && activeSecondaryPanel === "thread-storage"
        ? "thread-info"
        : activeSecondaryPanel;
  const hasParsedGitDiffFiles = parsedGitDiffFileEntries.length > 0;
  const timelineHeader = (
    <ThreadDetailHeader
      actionsMenu={threadActionsMenu}
      isManagedThread={Boolean(parentThreadId)}
      isManagerThread={isManagerThread}
      isSecondaryPanelOpen={isSecondaryPanelOpen}
      isThreadGitActionPending={isThreadGitActionPending}
      onOpenThreadGitAction={threadGitActionDialog.onOpen}
      onToggleSecondaryPanel={toggleThreadSecondaryPanel}
      threadHeaderGitAction={threadHeaderGitAction}
      threadTitle={threadTitle}
    />
  );
  const composerFooter = (
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
          ? handleMergeBaseBranchChange
          : undefined,
        onPromptBannerMergeBaseBranchPickerOpenChange: showBranchComparisonUi
          ? onMergeBaseBranchPickerOpenChange
          : undefined,
        onPromptGitStatsBannerClick: canUseGitUi ? handlePromptGitStatsBannerClick : () => {},
        onToggleChangeListExpanded: () => {
          setIsChangeListExpanded((prev) => !prev);
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
        provisioningStatusLabel,
        threadId: thread.id,
        threadStatus: thread.status,
      }}
      environment={{
        contextWindowUsage,
        environmentIcon: undefined,
        environmentLabel: threadEnvironmentValue,
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
      }}
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
  const threadStorage = thread.type === "manager"
    ? {
        filePreview: threadStorageFilePreview,
        fileError:
          threadStorageFilePreviewError instanceof Error
            ? threadStorageFilePreviewError
            : threadStorageFilePreviewError
              ? new Error("Failed to load thread storage file")
              : null,
        files: threadStorageFiles?.files,
        isFileLoading: isThreadStorageFilePreviewLoading,
        onTogglePath: handleThreadStoragePathToggle,
        selectedPath: selectedThreadStoragePath,
      }
    : undefined;

  return (
    <>
      <ThreadDetailSecondaryContent
        footer={composerFooter}
        header={timelineHeader}
        isSecondaryPanelOpen={isSecondaryPanelOpen}
        threadStorage={threadStorage}
        metadata={{
          canAssignToManager,
          canSelectMergeBase,
          canTakeOverThread,
          isLoadingMergeBaseBranchOptions,
          isManagerThread,
          managerSelectorOptions,
          managerSelectorValue,
          onAssignManager: handleAssignManager,
          onCopyThreadBranch: () => {
            void handleCopyThreadBranch();
          },
          onMergeBaseBranchChange: handleMergeBaseBranchChange,
          onMergeBaseBranchPickerOpenChange: onMergeBaseBranchPickerOpenChange,
          onUnarchive: () => {
            unarchiveThread.mutate({ id: thread.id });
          },
          parentThreadId: parentThreadId ?? undefined,
          projectId,
          selectedManagerOptionLabel: selectedManagerOption?.label,
          showThreadChangedFiles,
          showMergeBase,
          showWorkspaceStatus,
          thread,
          threadBranchName,
          threadEnvironmentType,
          threadEnvironmentValue,
          threadGitStatusDisplay,
          threadGitStatusLabelClass,
          mergeBaseBranch,
          mergeBaseCandidates,
          unarchivePending:
            unarchiveThread.isPending &&
            unarchiveThread.variables?.id === thread.id,
          updateThreadPending: updateThread.isPending || updateEnvironment.isPending,
          workspaceStatusFiles: workspaceWorkingTree?.files,
        }}
        secondaryPanel={{
          activePanel: effectiveSecondaryPanel,
          areAllGitDiffFilesCollapsed: canUseGitUi ? areAllGitDiffFilesCollapsed : true,
          collapsedGitDiffFileKeys,
          currentGitDiff: canUseGitUi ? currentGitDiff : "",
          gitDiffDisplayMode,
          gitDiffError: canUseGitUi ? gitDiffError : undefined,
          gitDiffSelectOptions,
          gitDiffSelectValue,
          gitDiffStatsLabel: canUseGitUi ? gitDiffStatsLabel : "",
          gitDiffViewOptions,
          hasParsedGitDiffFiles: canUseGitUi ? hasParsedGitDiffFiles : false,
          isGitDiffLoading: canUseGitUi ? isGitDiffLoading : false,
          isOpen: isSecondaryPanelOpen,
          isParsingGitDiffFiles: canUseGitUi ? isParsingGitDiffFiles : false,
          isPreparingGitDiff: canUseGitUi ? isPreparingGitDiff : false,
          isResizing: isSecondaryPanelResizing,
          loadingGitDiffFileKeys,
          onClose: closeThreadSecondaryPanel,
          onCollapse: closeThreadSecondaryPanel,
          onDragging: handleSecondaryPanelDragging,
          onGitDiffDisplayModeChange: handleGitDiffDisplayModeChange,
          onGitDiffSelectionChange: onGitDiffSelectionChange,
          onOpenFile:
            environment?.path && isLocalHost(environment.hostId)
              ? (relativePath: string) => {
                  const fullPath = `${environment.path}/${relativePath}`;
                  void openPath?.(fullPath);
                }
              : undefined,
          onPanelChange: openThreadSecondaryPanel,
          onResize: handleSecondaryPanelResize,
          onToggleAllFiles: toggleAllGitDiffFilesCollapsed,
          onToggleGitDiffFileCollapsed: toggleGitDiffFileCollapsed,
          panelRef: secondaryPanelRef,
          parsedGitDiffFileEntries: canUseGitUi ? parsedGitDiffFileEntries : [],
          queuedGitDiffFileRenderKeys,
          resizablePanelRef: secondaryResizablePanelRef,
          setGitDiffFileRef,
          showGitDiffTab: canUseGitUi,
          showThreadStorageTab: thread.type === "manager",
          threadGitDiff: canUseGitUi ? threadGitDiff : undefined,
          threadId: thread.id,
        }}
        showThreadMetadata={showThreadMetadata}
        timeline={{
          bottomSentinelRef,
          isReasoningBlockActive,
          isThreadTimelinePending,
          isTransientThreadLoadError,
          latestActivityRowId,
          loadingToolGroupIds,
          onLoadToolGroupMessages: handleLoadToolGroupMessages,
          onScroll: handleTimelineScroll,
          projectId,
          scrollRef: setContainerRef,
          showOngoingIndicator:
            thread.status === "active" &&
            !isThreadTimelinePending,
          threadDetailRows,
          threadId: thread.id,
          threadStatus: thread.status,
          toolGroupMessagesById,
        }}
      />
      <ThreadRenameDialog
        target={threadRenameDialog.target}
        pending={updateThread.isPending}
        onOpenChange={threadRenameDialog.onOpenChange}
        onRename={submitThreadRename}
      />
      <ThreadDeleteDialog
        target={threadDeleteDialog.target}
        pending={deleteThread.isPending}
        onOpenChange={threadDeleteDialog.onOpenChange}
        onDelete={(target) => {
          deleteThread.mutate(
            { id: target.id },
            {
              onSuccess: () => {
                threadDeleteDialog.onClose();
                navigate(`/projects/${target.projectId}`, { replace: true });
              },
              onError: (nextError) => {
                toast.error(
                  nextError instanceof Error ? nextError.message : `Failed to delete ${threadTypeLabel(target.type)}.`,
                );
              },
            },
          );
        }}
      />
      {canUseGitUi ? (
        <ThreadGitActionDialog
          target={threadGitActionDialog.target}
          pending={requestEnvironmentAction.isPending}
          askAgentPending={sendMessage.isPending}
          branchName={threadBranchName}
          gitStatusLabel={threadGitStatusDisplay.label}
          gitStatusSummary={threadGitStatusDisplay.summary}
          changedFiles={workspaceWorkingTree?.files}
          threadId={thread.id}
          threadType={thread.type}
          showMergeBaseDetails={showBranchComparisonUi}
          mergeBaseBranch={effectiveMergeBaseBranch}
          mergeBaseBranchOptions={mergeBaseBranchOptions}
          mergeBaseBranchOptionsLoading={isLoadingMergeBaseBranchOptions}
          onMergeBaseBranchChange={
            showBranchComparisonUi ? handleMergeBaseBranchChange : undefined
          }
          onMergeBaseBranchPickerOpenChange={
            showBranchComparisonUi ? onMergeBaseBranchPickerOpenChange : undefined
          }
          onOpenChange={(open) => {
            if (!open) {
              threadGitActionDialog.onClose();
              onMergeBaseBranchPickerOpenChange(false);
            }
          }}
          onCommit={handleCommitThread}
          onSquashMerge={handleSquashMergeThread}
          onAskAgentToFix={handleAskAgentToFixGitAction}
        />
      ) : null}
    </>
  );
}
