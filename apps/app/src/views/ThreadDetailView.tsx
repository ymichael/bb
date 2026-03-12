import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, PanelRight } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Panel, PanelGroup } from "react-resizable-panels";
import {
  useThread,
  useThreadWorkStatus,
  useThreadTimeline,
  useThreadToolGroupMessages,
  useTellThread,
  useEnqueueThreadMessage,
  useSendQueuedThreadMessage,
  useDeleteQueuedThreadMessage,
  useArchiveThread,
  useRequestThreadOperation,
  usePromoteThread,
  useDemotePrimaryCheckout,
  useStopThread,
  useMarkThreadRead,
  useMarkThreadUnread,
  useSystemEnvironments,
  useUnarchiveThread,
  useThreadDefaultExecutionOptions,
  useUpdateThread,
  useUploadPromptAttachment,
} from "../hooks/useApi";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { usePreferredTheme } from "@/hooks/useTheme";
import { PageShell } from "@/components/layout/PageShell";
import { WorkspaceChangesList } from "@/components/shared/WorkspaceChangesList";
import {
  getMergeBaseBranchCandidates,
  MergeBaseBranchPicker,
} from "@/components/thread/MergeBaseBranchPicker";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import {
  ThreadGitActionDialog,
  type ThreadGitActionDialogTarget,
} from "@/components/thread/ThreadGitActionDialog";
import {
  ThreadRenameDialog,
  type ThreadRenameDialogTarget,
} from "@/components/thread/ThreadRenameDialog";
import { DetailCard, DetailRow, StatusPill } from "@beanbag/ui-core";
import {
  formatEnvironmentDisplayName,
  type PromptInput,
  type ServiceTier,
  type ThreadDetailRow,
} from "@beanbag/agent-core";
import { promptDraftToInput } from "@/lib/prompt-draft";
import { HttpError } from "@/lib/api";
import { getAutoArchivePreferences } from "@/lib/auto-archive-preferences";
import { getEnvironmentIconInfo } from "@/lib/environment-icon";
import { ArchiveTimestampAction } from "@/components/shared/ArchiveTimestampAction";
import { getThreadGitStatusDisplay } from "@/lib/thread-work-status";
import {
  formatChangeSummary,
  formatWorkspaceChangeSummary,
} from "@/lib/workspace-change-summary";
import { supportsPrimaryCheckoutMetadata } from "@/lib/thread-primary-checkout";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import {
  isArchiveForceRequiredError,
  requiresArchiveConfirmation,
} from "@/lib/thread-archive";
import { ThreadComposerPane } from "./ThreadComposerPane";
import { ThreadSecondaryPanel } from "./ThreadSecondaryPanel";
import {
  findLatestActivityRowId,
} from "./threadDetailActivity";
import { extractThreadQueuedMessages, queuedInputToDraft } from "./threadQueuedMessages";
import { useGitDiffPanel } from "./useGitDiffPanel";
import { useThreadTimelineController } from "./useThreadTimelineController";
import { ThreadTimelinePane } from "./ThreadTimelinePane";
import { toast } from "sonner";

const THREAD_HEADER_ACTION_BUTTON_CLASS =
  "h-7 rounded-md border-border/70 bg-background/70 px-2 text-xs font-medium text-foreground/85 shadow-none hover:bg-muted/45 hover:text-foreground";
const TIMELINE_PANEL_DEFAULT_SIZE_PERCENT = 50;
const CLOSED_TIMELINE_PANEL_SIZE_PERCENT = 100;

interface PendingSubmittedFollowUp {
  signature: string;
  submittedAt: number;
}

function buildFollowUpText(input: PromptInput[]): string {
  return input
    .filter((entry): entry is Extract<PromptInput, { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text.trim())
    .filter((entry) => entry.length > 0)
    .join("\n\n");
}

function buildFollowUpAttachmentsSignature(input: PromptInput[]) {
  let webImages = 0;
  let localImages = 0;
  let localFiles = 0;
  const imageUrls: string[] = [];
  const localImagePaths: string[] = [];
  const localFilePaths: string[] = [];

  for (const entry of input) {
    switch (entry.type) {
      case "text":
        break;
      case "image":
        webImages += 1;
        imageUrls.push(entry.url);
        break;
      case "localImage":
        localImages += 1;
        localImagePaths.push(entry.path);
        break;
      case "localFile":
        localFiles += 1;
        localFilePaths.push(entry.path);
        break;
    }
  }

  if (webImages === 0 && localImages === 0 && localFiles === 0) {
    return null;
  }

  return {
    webImages,
    localImages,
    localFiles,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    ...(localImagePaths.length > 0 ? { localImagePaths } : {}),
    ...(localFilePaths.length > 0 ? { localFilePaths } : {}),
  };
}

function buildFollowUpSignatureFromInput(input: PromptInput[]): string {
  return JSON.stringify({
    text: buildFollowUpText(input),
    attachments: buildFollowUpAttachmentsSignature(input),
  });
}

function buildFollowUpSignatureFromRow(row: ThreadDetailRow): string | null {
  if (row.kind !== "message" || row.message.kind !== "user") {
    return null;
  }

  return JSON.stringify({
    text: row.message.text,
    attachments: row.message.attachments ?? null,
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
  const { data: timeline, isLoading: timelineLoading } = useThreadTimeline(
    threadId ?? "",
    { refetchOnMount: "always" },
  );
  const { data: defaultExecutionOptions } = useThreadDefaultExecutionOptions(
    threadId ?? "",
  );
  const threadToolGroupMessages = useThreadToolGroupMessages();
  const tellThread = useTellThread();
  const enqueueThreadMessage = useEnqueueThreadMessage();
  const sendQueuedThreadMessage = useSendQueuedThreadMessage();
  const deleteQueuedThreadMessage = useDeleteQueuedThreadMessage();
  const archiveThread = useArchiveThread();
  const requestThreadCommitOperation = useRequestThreadOperation();
  const requestThreadSquashOperation = useRequestThreadOperation();
  const promoteThread = usePromoteThread();
  const demotePrimaryCheckout = useDemotePrimaryCheckout();
  const stopThread = useStopThread();
  const unarchiveThread = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
  const markThreadUnread = useMarkThreadUnread();
  const updateThread = useUpdateThread();
  const uploadPromptAttachment = useUploadPromptAttachment();
  const promptDraft = usePromptDraftStorage({ projectId, threadId });
  const environmentCatalog = useSystemEnvironments();
  const fileMentions = usePromptFileMentions(projectId);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [pendingSubmittedFollowUp, setPendingSubmittedFollowUp] =
    useState<PendingSubmittedFollowUp | null>(null);
  const [isChangeListExpanded, setIsChangeListExpanded] = useState(false);
  const [processingQueuedMessageId, setProcessingQueuedMessageId] = useState<string | null>(
    null,
  );
  const [threadRenameTarget, setThreadRenameTarget] = useState<ThreadRenameDialogTarget | null>(
    null,
  );
  const [threadGitActionTarget, setThreadGitActionTarget] =
    useState<ThreadGitActionDialogTarget | null>(null);
  const markedReadKeysRef = useRef<Set<string>>(new Set());
  const captureTimelineScrollPositionRef = useRef<() => void>(() => {});
  const mergeBaseStateThreadIdRef = useRef<string | undefined>(undefined);
  const message = promptDraft.text;
  const promptInput = useMemo(
    () =>
      promptDraftToInput({
        text: promptDraft.text,
        attachments: promptDraft.attachments,
      }),
    [promptDraft.attachments, promptDraft.text],
  );
  const {
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
    supportsModelList,
    supportsReasoningLevels,
    supportsServiceTier,
  } = usePromptModelReasoning({
    scope: "thread",
    resetKey: threadId,
    initialModel: defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialSandboxMode: defaultExecutionOptions?.sandboxMode,
    initialEnvironmentId: thread?.environmentId,
  });
  const preferredTheme = usePreferredTheme();
  const threadDetailRows = useMemo(() => timeline?.rows ?? [], [timeline?.rows]);
  const contextWindowUsage = timeline?.contextWindowUsage ?? undefined;
  const latestActivityRowId = useMemo(
    () => findLatestActivityRowId(threadDetailRows),
    [threadDetailRows],
  );
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
    threadId,
  });
  const {
    data: threadWorkStatus,
    error: threadWorkStatusError,
  } = useThreadWorkStatus(threadId ?? "", selectedMergeBaseBranch);
  const resolvedThreadWorkStatus =
    threadWorkStatusError ? undefined : (threadWorkStatus ?? undefined);
  const {
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
    loadToolGroupMessages: threadToolGroupMessages.mutateAsync,
  });
  captureTimelineScrollPositionRef.current = captureTimelineScrollPosition;


  const isReasoningBlockActive = false;
  const isTimelineLoading = timelineLoading;
  const isThreadTimelinePending = isTimelineLoading && threadDetailRows.length === 0;
  const isThreadPrimaryCheckoutActive = thread?.primaryCheckout?.isActive === true;
  const environmentInfo = useMemo(
    () =>
      environmentCatalog.data?.find((environment) => environment.id === thread?.environmentId),
    [environmentCatalog.data, thread?.environmentId],
  );
  const builtInActionsById = useMemo(
    () => new Map((thread?.builtInActions ?? []).map((action) => [action.id, action])),
    [thread?.builtInActions],
  );
  const squashMergeAction = builtInActionsById.get("squash_merge");
  const promoteAction = builtInActionsById.get("promote");
  const demoteAction = builtInActionsById.get("demote");
  const supportsPrimaryCheckout =
    isThreadPrimaryCheckoutActive || supportsPrimaryCheckoutMetadata(environmentInfo?.capabilities);
  const supportsSquashMerge = squashMergeAction?.available === true;

  useEffect(() => {
    if (mergeBaseStateThreadIdRef.current === thread?.id) {
      return;
    }
    mergeBaseStateThreadIdRef.current = thread?.id;
    setSelectedMergeBaseBranch(thread?.mergeBaseBranch);
  }, [setSelectedMergeBaseBranch, thread?.id, thread?.mergeBaseBranch]);

  useEffect(() => {
    setPendingSubmittedFollowUp(null);
  }, [threadId]);

  useEffect(() => {
    if (!pendingSubmittedFollowUp) {
      return;
    }

    const acknowledged = threadDetailRows.some((row) => {
      const rowSignature = buildFollowUpSignatureFromRow(row);
      if (rowSignature !== pendingSubmittedFollowUp.signature) {
        return false;
      }
      return row.kind === "message" && row.message.createdAt + 2_000 >= pendingSubmittedFollowUp.submittedAt;
    });

    if (!acknowledged) {
      return;
    }

    promptDraft.clear();
    setPendingSubmittedFollowUp(null);
  }, [pendingSubmittedFollowUp, promptDraft, threadDetailRows]);

  useEffect(() => {
    if (!thread) return;
    if ((thread.lastReadAt ?? 0) >= thread.updatedAt) return;

    const marker = `${thread.id}:${thread.updatedAt}`;
    if (markedReadKeysRef.current.has(marker)) return;

    markedReadKeysRef.current.add(marker);
    markThreadRead.mutate(thread.id, {
      onError: () => {
        markedReadKeysRef.current.delete(marker);
      },
    });
  }, [markThreadRead, thread]);

  const renameThread = useCallback(() => {
    if (!thread || updateThread.isPending) return;
    setThreadRenameTarget({
      id: thread.id,
      currentTitle: getThreadDisplayTitle(thread),
    });
  }, [thread, updateThread.isPending]);

  const submitThreadRename = useCallback((currentThreadId: string, title: string) => {
    updateThread.mutate(
      {
        id: currentThreadId,
        title,
      },
      {
        onSuccess: () => {
          setThreadRenameTarget(null);
        },
      },
    );
  }, [updateThread]);

  const handleThreadMergeBaseBranchChange = useCallback((branch: string) => {
    if (!threadId || !thread) {
      return;
    }

    const normalizedBranch = branch.trim();
    const defaultBranch = resolvedThreadWorkStatus?.defaultBranch?.trim();
    const nextPersistedMergeBaseBranch =
      normalizedBranch.length > 0 && normalizedBranch !== defaultBranch
        ? normalizedBranch
        : null;
    const currentPersistedMergeBaseBranch = thread.mergeBaseBranch ?? null;

    setSelectedMergeBaseBranch(normalizedBranch);
    if (nextPersistedMergeBaseBranch === currentPersistedMergeBaseBranch) {
      return;
    }

    updateThread.mutate(
      {
        id: threadId,
        mergeBaseBranch: nextPersistedMergeBaseBranch,
      },
      {
        onError: (error) => {
          setSelectedMergeBaseBranch(thread.mergeBaseBranch);
          toast.error(
            error instanceof Error ? error.message : "Failed to update merge base branch.",
          );
        },
      },
    );
  }, [
    resolvedThreadWorkStatus?.defaultBranch,
    setSelectedMergeBaseBranch,
    thread,
    threadId,
    updateThread,
  ]);

  const toggleArchiveThread = useCallback(() => {
    if (!thread) return;
    if (thread.archivedAt !== undefined) {
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
              nextError instanceof Error ? nextError.message : "Failed to archive thread.",
            );
          },
        },
      );
    };

    if (requiresArchiveConfirmation(thread.workStatus, environmentInfo)) {
      const confirmed = window.confirm(
        "This thread has uncommitted or unmerged work. Archive anyway?",
      );
      if (!confirmed) {
        return;
      }
      archiveWithForce();
      return;
    }

    archiveThread.mutate(
      { id: thread.id },
      {
        onSuccess: () => {
          navigate(`/projects/${thread.projectId}`);
        },
        onError: (nextError) => {
          if (isArchiveForceRequiredError(nextError)) {
            const confirmed = window.confirm(
              "This thread has uncommitted or unmerged work. Archive anyway?",
            );
            if (confirmed) {
              archiveWithForce();
            }
            return;
          }
          toast.error(
            nextError instanceof Error ? nextError.message : "Failed to archive thread.",
          );
        },
      },
    );
  }, [archiveThread, environmentInfo, navigate, thread, unarchiveThread]);

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
      mode,
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
      const shouldDemotePrimaryIfNeeded =
        mode !== "steer" && isThreadPrimaryCheckoutActive;
      scrollToBottom();
      await tellThread.mutateAsync({
        id: threadId,
        input,
        ...(mode ? { mode } : {}),
        ...(shouldDemotePrimaryIfNeeded
          ? { demotePrimaryIfNeeded: true }
          : {}),
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
      isThreadPrimaryCheckoutActive,
      scrollToBottom,
      tellThread,
      threadId,
    ],
  );

  const handleAttachFiles = useCallback(async (files: File[]) => {
    if (!projectId || files.length === 0) return;

    setAttachmentError(null);
    for (const file of files) {
      try {
        const uploaded = await uploadPromptAttachment.mutateAsync({
          projectId,
          file,
        });
        promptDraft.addAttachment(uploaded);
      } catch (err) {
        setAttachmentError(err instanceof Error ? err.message : "Attachment upload failed");
        break;
      }
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
  const isProvisioningFailed = thread.status === "provisioning_failed";
  const isRuntimeError = thread.status === "error";
  const queuedMessages = extractThreadQueuedMessages(thread);
  const isQueueMutationPending =
    enqueueThreadMessage.isPending ||
    sendQueuedThreadMessage.isPending ||
    deleteQueuedThreadMessage.isPending;
  const isFollowUpSubmitting =
    tellThread.isPending ||
    pendingSubmittedFollowUp !== null ||
    demotePrimaryCheckout.isPending ||
    enqueueThreadMessage.isPending;
  const canSendFollowUp = !isCreated && !isProvisioning;
  const promptPlaceholder =
    isCreated
      ? "Thread is being created..."
      : isProvisioning
      ? "Thread is provisioning..."
      : isProvisioningFailed
      ? "Retry provisioning by sending a message"
      : isRuntimeError
      ? "Retry by sending a follow-up message"
      : thread.status === "idle"
      ? "Ask for follow-up changes"
      : "Send a message to this thread...";
  const parentThreadId = thread.parentThreadId;
  const parentThreadDisplayName =
    parentThread?.title && parentThread.title.trim().length > 0
      ? parentThread.title
      : parentThreadId;
  const isPrimaryCheckoutActive = thread.primaryCheckout?.isActive === true;
  const isPrimaryCheckoutMutationPending = promoteThread.isPending || demotePrimaryCheckout.isPending;
  const primaryCheckoutActionLabel = isPrimaryCheckoutActive
    ? demotePrimaryCheckout.isPending
      ? "Demoting..."
      : "Demote"
    : promoteThread.isPending
    ? "Promoting..."
    : "Promote";
  const isArchivedThread = thread.archivedAt !== undefined;
  const showPrimaryCheckoutAction = supportsPrimaryCheckout && !isArchivedThread;
  const isPromoteBlockedByThreadStatus =
    !isPrimaryCheckoutActive && thread.status !== "idle";
  const isPrimaryCheckoutActionDisabled =
    isPrimaryCheckoutMutationPending ||
    isPromoteBlockedByThreadStatus ||
    (isPrimaryCheckoutActive
      ? demoteAction?.available === false
      : promoteAction?.available === false);
  const isDirectThreadEnvironment =
    environmentInfo?.capabilities.host_filesystem === true &&
    environmentInfo.capabilities.isolated_workspace !== true;
  const threadHeaderGitAction: {
    target: ThreadGitActionDialogTarget;
    label: string;
  } | null = (() => {
    if (!resolvedThreadWorkStatus || isArchivedThread) {
      return null;
    }

    if (isDirectThreadEnvironment) {
      if (!resolvedThreadWorkStatus.hasUncommittedChanges) {
        return null;
      }
      return {
        target: { kind: "commit" },
        label: "Commit",
      };
    }

    if (
      supportsSquashMerge &&
      (
        resolvedThreadWorkStatus.hasCommittedUnmergedChanges ||
        resolvedThreadWorkStatus.hasUncommittedChanges
      )
    ) {
      return {
        target: {
          kind: resolvedThreadWorkStatus.hasUncommittedChanges
            ? "commit_and_squash_merge"
            : "squash_merge",
        },
        label: "Squash merge",
      };
    }

    return null;
  })();
  const isThreadGitActionPending =
    requestThreadCommitOperation.isPending || requestThreadSquashOperation.isPending;
  const environmentIconInfo = getEnvironmentIconInfo(environmentInfo);
  const threadEnvironmentLabel =
    thread.environmentId
      ? (
          formatEnvironmentDisplayName({
            id: thread.environmentId,
            displayName: environmentInfo?.displayName,
          }) ?? thread.environmentId
        )
      : undefined;
  const provisioningStatusLabel =
    isCreated
      ? "Created..."
      : isProvisioning
      ? "Provisioning..."
      : undefined;
  const effectiveMergeBaseBranch =
    selectedMergeBaseBranch ??
    resolvedThreadWorkStatus?.mergeBaseBranch ??
    resolvedThreadWorkStatus?.defaultBranch;
  const showBranchComparisonUi = Boolean(
    effectiveMergeBaseBranch || resolvedThreadWorkStatus?.defaultBranch,
  );
  const promptBannerSummary = resolvedThreadWorkStatus
    ? showBranchComparisonUi
      ? formatChangeSummary({
          changedFiles: resolvedThreadWorkStatus.changedFiles,
          insertions: resolvedThreadWorkStatus.insertions,
          deletions: resolvedThreadWorkStatus.deletions,
        })
      : formatWorkspaceChangeSummary(resolvedThreadWorkStatus)
    : "";
  const showPromptGitStatsBanner = Boolean(
    resolvedThreadWorkStatus &&
    (
      showBranchComparisonUi
        ? resolvedThreadWorkStatus.changedFiles > 0
        : resolvedThreadWorkStatus.workspaceChangedFiles > 0
    ),
  );
  const canExpandPromptChangeList = Boolean(
    resolvedThreadWorkStatus &&
    (resolvedThreadWorkStatus.files?.length ?? 0) > 0,
  );
  const promptBannerMergeBaseBranch = effectiveMergeBaseBranch;
  const threadEnvironmentType =
    threadEnvironmentLabel ??
    thread.environmentRecord?.kind ??
    undefined;
  const threadBranchName = resolvedThreadWorkStatus?.currentBranch;
  const threadMergeBaseBranch = effectiveMergeBaseBranch;
  const showThreadWorkspaceStatus =
    (Boolean(resolvedThreadWorkStatus) || Boolean(threadWorkStatusError)) &&
    !(thread.archivedAt !== undefined && environmentInfo?.capabilities.isolated_workspace !== true);
  const threadGitStatusDisplay = getThreadGitStatusDisplay(
    resolvedThreadWorkStatus,
    {
      mergeBaseBranch: threadMergeBaseBranch,
      showBranchComparison: showBranchComparisonUi,
    },
  );
  const threadGitStatusLabelClass = resolvedThreadWorkStatus?.state === "deleted"
    ? "text-destructive"
    : resolvedThreadWorkStatus?.state === "untracked"
      ? "text-muted-foreground"
      : "text-foreground";
  const showThreadChangedFiles = Boolean(
    resolvedThreadWorkStatus &&
      (
        resolvedThreadWorkStatus.state === "dirty_uncommitted" ||
        resolvedThreadWorkStatus.state === "dirty_and_committed_unmerged" ||
        resolvedThreadWorkStatus.state === "committed_unmerged"
      ) &&
      (resolvedThreadWorkStatus.files?.length ?? 0) > 0,
  );
  const showThreadMergeBase = showBranchComparisonUi && Boolean(threadMergeBaseBranch);
  const threadMergeBaseCandidates = getMergeBaseBranchCandidates({
    mergeBaseBranch: threadMergeBaseBranch,
    mergeBaseBranchOptions,
  });
  const canSelectThreadMergeBase = Boolean(
    showThreadMergeBase &&
      threadMergeBaseBranch &&
      threadMergeBaseCandidates.length > 0,
  );
  const showThreadMetadata = Boolean(
    parentThreadId ||
      threadEnvironmentType ||
      threadBranchName ||
      showThreadMergeBase ||
      showThreadWorkspaceStatus ||
      showThreadChangedFiles ||
      thread.archivedAt !== undefined,
  );
  const threadTitle = getThreadDisplayTitle(thread);
  const threadActionsDisabled =
    archiveThread.isPending ||
    unarchiveThread.isPending ||
    markThreadRead.isPending ||
    markThreadUnread.isPending ||
    updateThread.isPending;
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
  const handleTogglePrimaryCheckout = () => {
    const action = isPrimaryCheckoutActive
      ? demotePrimaryCheckout.mutateAsync({ id: thread.id })
      : promoteThread.mutateAsync({ id: thread.id });
    void action.catch((err) => {
      window.alert(
        err instanceof Error
          ? err.message
          : "Failed to update primary checkout state",
      );
    });
  };
  const handleCommitThread = async ({
    includeUnstaged,
  }: {
    includeUnstaged: boolean;
  }) => {
    if (!threadId) {
      return;
    }
    const autoArchiveOnSuccess = getAutoArchivePreferences().autoArchiveThreadOnCommit;
    await requestThreadCommitOperation.mutateAsync({
      id: threadId,
      operation: "commit",
      options: {
        includeUnstaged,
        autoArchiveOnSuccess,
      },
    });
  };
  const handleSquashMergeThread = async ({
    commitIfNeeded,
    includeUnstaged,
    mergeBaseBranch,
  }: {
    commitIfNeeded: boolean;
    includeUnstaged: boolean;
    mergeBaseBranch?: string;
  }) => {
    if (!threadId) {
      return;
    }
    const autoArchiveOnSuccess = getAutoArchivePreferences().autoArchiveThreadOnCommit;
    await requestThreadSquashOperation.mutateAsync({
      id: threadId,
      operation: "squash_merge",
      options: {
        commitIfNeeded,
        includeUnstaged,
        ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
        autoArchiveOnSuccess,
      },
    });
  };
  const renderThreadMetadataRows = () => (
    <>
      {parentThreadId ? (
        <DetailRow
          label="Parent thread"
          valueClassName="min-w-0 truncate"
        >
          <Link
            to={`/projects/${projectId}/threads/${parentThreadId}`}
            className="underline underline-offset-2"
          >
            {parentThreadDisplayName}
          </Link>
        </DetailRow>
      ) : null}
      {threadEnvironmentType ? (
        <DetailRow
          label="Environment"
          valueClassName="min-w-0 truncate"
        >
          {threadEnvironmentType}
        </DetailRow>
      ) : null}
      {threadBranchName ? (
        <DetailRow
          label="Branch"
          valueClassName="min-w-0 truncate"
        >
          <button
            type="button"
            className="inline-flex max-w-full items-center gap-1.5 rounded-md text-left text-foreground transition-colors hover:text-foreground/80"
            onClick={() => {
              void handleCopyThreadBranch();
            }}
            aria-label="Copy branch name"
            title="Copy branch name"
          >
            <span className="truncate">{threadBranchName}</span>
            <Copy className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DetailRow>
      ) : null}
      {showThreadMergeBase ? (
        <DetailRow
          label="Merge base"
          valueClassName="min-w-0 truncate"
        >
          {canSelectThreadMergeBase && threadMergeBaseBranch ? (
            <MergeBaseBranchPicker
              value={threadMergeBaseBranch}
              options={threadMergeBaseCandidates}
              variant="minimal"
              loading={isLoadingMergeBaseBranchOptions}
              onChange={handleThreadMergeBaseBranchChange}
              onOpenChange={onMergeBaseBranchPickerOpenChange}
              className="max-w-full text-foreground"
            />
          ) : (
            threadMergeBaseBranch
          )}
        </DetailRow>
      ) : null}
      {showThreadWorkspaceStatus ? (
        <DetailRow
          label="Git status"
          align="start"
          valueClassName="min-w-0"
        >
          <div
            className="flex min-w-0 items-baseline gap-2 whitespace-nowrap"
            title={`${threadGitStatusDisplay.label} ${threadGitStatusDisplay.summary}`}
          >
            <span className={`shrink-0 font-medium ${threadGitStatusLabelClass}`}>
              {threadGitStatusDisplay.label}
            </span>
            <span className="min-w-0 truncate text-muted-foreground">
              {threadGitStatusDisplay.summary}
            </span>
          </div>
        </DetailRow>
      ) : null}
      {thread.archivedAt !== undefined ? (
        <DetailRow
          label="Archived"
          valueClassName="min-w-0 truncate"
        >
          <ArchiveTimestampAction
            isPending={
              unarchiveThread.isPending &&
              unarchiveThread.variables?.id === thread.id
            }
            onUnarchive={() => {
              unarchiveThread.mutate({ id: thread.id });
            }}
          />
        </DetailRow>
      ) : null}
    </>
  );
  const renderThreadMetadataCard = (className?: string) => (
    <DetailCard className={className}>
      {renderThreadMetadataRows()}
      {showThreadChangedFiles ? (
        <DetailRow
          label="Changed files"
          layout="vertical"
          valueClassName="pt-0.5"
        >
          <WorkspaceChangesList
            files={resolvedThreadWorkStatus?.files}
            threadId={thread.id}
            maxHeightClassName="max-h-48"
          />
        </DetailRow>
      ) : null}
    </DetailCard>
  );
  const renderThreadMetadataContent = (className?: string) => (
    renderThreadMetadataCard(
      [
        "rounded-none border-0 bg-transparent px-0 py-0",
        className,
      ].filter(Boolean).join(" "),
    )
  );
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
      isArchived={thread.archivedAt !== undefined}
    />
  );

  const handleSend = async () => {
    if (promptInput.length === 0) return;

    if (thread.status === "active") {
      try {
        await enqueueThreadMessage.mutateAsync({
          id: thread.id,
          input: promptInput,
          model: activeModel?.model ?? selectedModel,
          ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
          ...(supportsReasoningLevels ? { reasoningLevel } : {}),
          sandboxMode,
        });
        promptDraft.clear();
        setAttachmentError(null);
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Failed to queue follow-up");
      }
      return;
    }

    const submittedAt = Date.now();
    setPendingSubmittedFollowUp({
      signature: buildFollowUpSignatureFromInput(promptInput),
      submittedAt,
    });
    setAttachmentError(null);

    try {
      await sendFollowUpInput({
        input: promptInput,
        model: activeModel?.model ?? selectedModel,
        ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
          ...(supportsReasoningLevels ? { reasoningLevel } : {}),
          sandboxMode,
      });
    } catch (err) {
      setPendingSubmittedFollowUp(null);
      window.alert(err instanceof Error ? err.message : "Failed to send follow-up");
    }
  };

  const handleSendQueuedImmediately = (messageId: string) => {
    const queuedMessage = queuedMessages.find((candidate) => candidate.id === messageId);
    if (!queuedMessage) return;

    setProcessingQueuedMessageId(messageId);
    void sendQueuedThreadMessage
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
        mode: "steer-if-active",
      })
      .then(() => {
        setAttachmentError(null);
      })
      .catch((err) => {
        window.alert(
          err instanceof Error ? err.message : "Failed to send queued follow-up",
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
    void deleteQueuedThreadMessage
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
      })
      .then(() => {
        const restoredDraft = queuedInputToDraft(queuedMessage.input);
        promptDraft.setText(restoredDraft.text);
        promptDraft.setAttachments(restoredDraft.attachments);
        setAttachmentError(null);
      })
      .catch((err) => {
        window.alert(
          err instanceof Error ? err.message : "Failed to edit queued follow-up",
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
    void deleteQueuedThreadMessage
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
      })
      .catch((err) => {
        window.alert(
          err instanceof Error ? err.message : "Failed to delete queued follow-up",
        );
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  };

  const timelineHeader = (
    <header className="shrink-0 border-b border-border/80 bg-background/95 px-4 backdrop-blur-sm">
      <div className="flex h-12 items-center gap-3">
        <SidebarTrigger className="h-5 w-5 shrink-0 rounded-md p-0" />
        <Separator orientation="vertical" className="h-4" />
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <p className="truncate text-sm font-semibold">{threadTitle}</p>
          {isPrimaryCheckoutActive ? (
            <StatusPill variant="emphasis">active</StatusPill>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showPrimaryCheckoutAction ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={THREAD_HEADER_ACTION_BUTTON_CLASS}
              disabled={isPrimaryCheckoutActionDisabled}
              onClick={handleTogglePrimaryCheckout}
            >
              {primaryCheckoutActionLabel}
            </Button>
          ) : null}
          {threadHeaderGitAction ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isThreadGitActionPending}
              className={THREAD_HEADER_ACTION_BUTTON_CLASS}
              onClick={() => {
                setThreadGitActionTarget(threadHeaderGitAction.target);
              }}
            >
              {threadHeaderGitAction.label}
            </Button>
          ) : null}
          {threadActionsMenu}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={
              isSecondaryPanelOpen
                ? "h-7 w-7 rounded-md p-0 bg-accent/35 text-foreground hover:bg-accent/45"
                : "h-7 w-7 rounded-md p-0 text-muted-foreground hover:bg-accent/45 hover:text-foreground"
            }
            aria-label={isSecondaryPanelOpen ? "Hide secondary panel" : "Show secondary panel"}
            title={isSecondaryPanelOpen ? "Hide secondary panel" : "Show secondary panel"}
            onClick={toggleThreadSecondaryPanel}
          >
            <PanelRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </header>
  );

  const hasParsedGitDiffFiles = parsedGitDiffFileEntries.length > 0;

  const composerFooter = (
    <ThreadComposerPane
      composerRef={promptComposerRef}
      provisioningStatusLabel={provisioningStatusLabel}
      showScrollToBottom={showScrollToBottom}
      onScrollToBottom={scrollToBottom}
      showPromptGitStatsBanner={showPromptGitStatsBanner}
      isDiffPanelActive={isDiffPanelActive}
      canExpandPromptChangeList={canExpandPromptChangeList}
      isChangeListExpanded={isChangeListExpanded}
      onToggleChangeListExpanded={() => {
        setIsChangeListExpanded((prev) => !prev);
      }}
      promptBannerSummary={promptBannerSummary}
      showBranchComparisonUi={showBranchComparisonUi}
      promptBannerMergeBaseBranch={promptBannerMergeBaseBranch}
      mergeBaseBranchOptions={mergeBaseBranchOptions}
      mergeBaseBranchOptionsLoading={isLoadingMergeBaseBranchOptions}
      onPromptBannerMergeBaseBranchChange={
        showBranchComparisonUi ? handleThreadMergeBaseBranchChange : undefined
      }
      onPromptBannerMergeBaseBranchPickerOpenChange={
        showBranchComparisonUi ? onMergeBaseBranchPickerOpenChange : undefined
      }
      resolvedThreadWorkStatus={resolvedThreadWorkStatus}
      threadId={thread.id}
      onPromptGitStatsBannerClick={handlePromptGitStatsBannerClick}
      onPromptBannerFileClick={handlePromptBannerFileClick}
      queuedMessages={queuedMessages}
      canSendFollowUp={canSendFollowUp}
      isFollowUpSubmitting={isFollowUpSubmitting}
      isQueueMutationPending={isQueueMutationPending}
      processingQueuedMessageId={processingQueuedMessageId}
      onSendQueuedImmediately={handleSendQueuedImmediately}
      onEditQueuedMessage={handleEditQueuedMessage}
      onDeleteQueuedMessage={handleDeleteQueuedMessage}
      message={message}
      onChangeMessage={promptDraft.setText}
      onSubmit={handleSend}
      threadStatus={thread.status}
      onStop={() => stopThread.mutate(thread.id)}
      promptPlaceholder={promptPlaceholder}
      mentionSuggestions={fileMentions.suggestions}
      mentionLoading={fileMentions.isLoading}
      mentionError={fileMentions.isError}
      onMentionQueryChange={fileMentions.setQuery}
      attachments={promptDraft.attachments}
      projectId={projectId}
      onAttachFiles={handleAttachFiles}
      onRemoveAttachment={promptDraft.removeAttachment}
      isAttaching={uploadPromptAttachment.isPending}
      attachmentError={attachmentError}
      supportsModelList={supportsModelList}
      activeModel={activeModel}
      selectedModel={selectedModel}
      modelOptions={modelOptions}
      onSelectedModelChange={setSelectedModel}
      serviceTier={serviceTier}
      onServiceTierChange={setServiceTier}
      supportsServiceTier={supportsServiceTier}
      supportsReasoningLevels={supportsReasoningLevels}
      reasoningLevel={reasoningLevel}
      reasoningOptions={reasoningOptions}
      onReasoningLevelChange={setReasoningLevel}
      sandboxMode={sandboxMode}
      sandboxOptions={sandboxOptions}
      onSandboxModeChange={setSandboxMode}
      environmentLabel={threadEnvironmentLabel}
      environmentIcon={environmentIconInfo?.icon}
      contextWindowUsage={contextWindowUsage}
    />
  );

  return (
    <>
      <div className="-mx-4 -mb-4 -mt-4 flex h-full min-h-0 min-w-0 flex-1 overflow-hidden md:-mx-5 md:-mb-5 md:-mt-5">
        <PanelGroup direction="horizontal" className="h-full w-full min-w-0">
          <Panel
            id="thread-detail-timeline-panel"
            defaultSize={
              isSecondaryPanelOpen
                ? TIMELINE_PANEL_DEFAULT_SIZE_PERCENT
                : CLOSED_TIMELINE_PANEL_SIZE_PERCENT
            }
            minSize={30}
            order={1}
            className="min-w-0 overflow-hidden"
          >
            <ThreadTimelinePane
              footer={composerFooter}
              header={timelineHeader}
              isReasoningBlockActive={isReasoningBlockActive}
              isThreadTimelinePending={isThreadTimelinePending}
              isTransientThreadLoadError={isTransientThreadLoadError}
              latestActivityRowId={latestActivityRowId}
              loadingToolGroupIds={loadingToolGroupIds}
              onLoadToolGroupMessages={handleLoadToolGroupMessages}
              onScroll={handleTimelineScroll}
              projectId={projectId}
              scrollRef={setContainerRef}
              showOngoingIndicator={
                thread.status === "active" &&
                !isThreadTimelinePending
              }
              threadDetailRows={threadDetailRows}
              threadId={thread.id}
              threadStatus={thread.status}
              toolGroupMessagesById={toolGroupMessagesById}
            />
          </Panel>
          <ThreadSecondaryPanel
            activePanel={activeSecondaryPanel}
            metadataContent={
              showThreadMetadata ? (
                renderThreadMetadataContent()
              ) : (
                <div className="pt-1 text-sm text-muted-foreground">
                  No thread details available.
                </div>
              )
            }
            onPanelChange={openThreadSecondaryPanel}
            threadId={thread.id}
            panelRef={secondaryPanelRef}
            resizablePanelRef={secondaryResizablePanelRef}
            isOpen={isSecondaryPanelOpen}
            isResizing={isSecondaryPanelResizing}
            onCollapse={closeThreadSecondaryPanel}
            onClose={closeThreadSecondaryPanel}
            onDragging={handleSecondaryPanelDragging}
            onResize={handleSecondaryPanelResize}
            gitDiffSelectValue={gitDiffSelectValue}
            gitDiffSelectOptions={gitDiffSelectOptions}
            onGitDiffSelectionChange={onGitDiffSelectionChange}
            isGitDiffLoading={isGitDiffLoading}
            gitDiffError={gitDiffError}
            threadGitDiff={threadGitDiff}
            currentGitDiff={currentGitDiff}
            isPreparingGitDiff={isPreparingGitDiff}
            isParsingGitDiffFiles={isParsingGitDiffFiles}
            gitDiffStatsLabel={gitDiffStatsLabel}
            hasParsedGitDiffFiles={hasParsedGitDiffFiles}
            areAllGitDiffFilesCollapsed={areAllGitDiffFilesCollapsed}
            onToggleAllFiles={toggleAllGitDiffFilesCollapsed}
            gitDiffDisplayMode={gitDiffDisplayMode}
            onGitDiffDisplayModeChange={handleGitDiffDisplayModeChange}
            parsedGitDiffFileEntries={parsedGitDiffFileEntries}
            collapsedGitDiffFileKeys={collapsedGitDiffFileKeys}
            queuedGitDiffFileRenderKeys={queuedGitDiffFileRenderKeys}
            loadingGitDiffFileKeys={loadingGitDiffFileKeys}
            setGitDiffFileRef={setGitDiffFileRef}
            onToggleGitDiffFileCollapsed={toggleGitDiffFileCollapsed}
            gitDiffViewOptions={gitDiffViewOptions}
          />
        </PanelGroup>
      </div>
      <ThreadRenameDialog
        target={threadRenameTarget}
        pending={updateThread.isPending}
        onOpenChange={(open) => {
          if (!open) {
            setThreadRenameTarget(null);
          }
        }}
        onRename={submitThreadRename}
      />
      <ThreadGitActionDialog
        target={threadGitActionTarget}
        pending={
          threadGitActionTarget?.kind === "commit"
            ? requestThreadCommitOperation.isPending
            : requestThreadSquashOperation.isPending
        }
        branchName={threadBranchName}
        gitStatusLabel={threadGitStatusDisplay.label}
        gitStatusSummary={threadGitStatusDisplay.summary}
        changedFiles={resolvedThreadWorkStatus?.files}
        threadId={thread.id}
        showMergeBaseDetails={showBranchComparisonUi}
        mergeBaseBranch={effectiveMergeBaseBranch}
        mergeBaseBranchOptions={mergeBaseBranchOptions}
        mergeBaseBranchOptionsLoading={isLoadingMergeBaseBranchOptions}
        onMergeBaseBranchChange={
          showBranchComparisonUi ? handleThreadMergeBaseBranchChange : undefined
        }
        onMergeBaseBranchPickerOpenChange={
          showBranchComparisonUi ? onMergeBaseBranchPickerOpenChange : undefined
        }
        onOpenChange={(open) => {
          if (!open) {
            setThreadGitActionTarget(null);
            onMergeBaseBranchPickerOpenChange(false);
          }
        }}
        onCommit={handleCommitThread}
        onSquashMerge={handleSquashMergeThread}
      />
    </>
  );
}
