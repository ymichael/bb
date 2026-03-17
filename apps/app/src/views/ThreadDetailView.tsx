import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, PanelRight, X } from "lucide-react";
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
  useDeleteThread,
  useSystemEnvironments,
  useUnarchiveThread,
  useThreadDefaultExecutionOptions,
  useThreadManagerWorkspaceFile,
  useThreadManagerWorkspaceFiles,
  useProjects,
  useUpdateThread,
  useUploadPromptAttachment,
} from "../hooks/useApi";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { ThreadDeleteDialog } from "@/components/thread/ThreadDeleteDialog";
import { DetailCard, DetailRow, StatusPill } from "@bb/ui-core";
import {
  type PromptInput,
  type ServiceTier,
  type Thread,
} from "@bb/core";
import { promptDraftToInput } from "@/lib/prompt-draft";
import { HttpError } from "@/lib/api";
import { getAutoArchivePreferences } from "@/lib/auto-archive-preferences";
import { getEnvironmentIconInfo } from "@/lib/environment-icon";
import {
  buildFollowUpSignatureFromInput,
  buildFollowUpSignatureFromRow,
} from "@/lib/thread-follow-up-signature";
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

function formatAttachedEnvironmentLabel(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

function formatAttachedEnvironmentSuffix(path: string, projectRootPath?: string): string | undefined {
  if (!projectRootPath) {
    return formatAttachedEnvironmentLabel(path);
  }
  const normalizedProjectRoot = projectRootPath.replace(/\/+$/, "");
  const normalizedPath = path.replace(/\/+$/, "");
  if (normalizedPath === normalizedProjectRoot) {
    return undefined;
  }
  if (normalizedPath.startsWith(`${normalizedProjectRoot}/`)) {
    return normalizedPath.slice(normalizedProjectRoot.length + 1);
  }
  return formatAttachedEnvironmentLabel(path);
}

function formatThreadEnvironmentLabel(args: {
  projectRootPath?: string;
  attachedEnvironment?: Thread["attachedEnvironment"];
}): string | undefined {
  const attachedEnvironment = args.attachedEnvironment;
  if (attachedEnvironment) {
    const properties = attachedEnvironment.properties;
    const isPrimaryWorkspace =
      args.projectRootPath !== undefined &&
      attachedEnvironment.descriptor !== undefined &&
      attachedEnvironment.descriptor.path === args.projectRootPath;
    if (isPrimaryWorkspace) {
      return "Primary";
    }
    if (properties?.location === "docker") {
      return "Docker";
    }
    if (properties?.workspaceKind === "worktree") {
      const suffix = formatAttachedEnvironmentSuffix(
        attachedEnvironment.descriptor?.path ?? "",
        args.projectRootPath,
      );
      return suffix ? `Worktree (${suffix})` : "Worktree";
    }
    if (properties?.location === "localhost") {
      return "Direct";
    }
    return "Unknown";
  }
  return undefined;
}

const THREAD_HEADER_ACTION_BUTTON_CLASS =
  "h-7 rounded-md border-border/70 bg-background/70 px-2 text-xs font-medium text-foreground/85 shadow-none hover:bg-muted/45 hover:text-foreground";
const TIMELINE_PANEL_DEFAULT_SIZE_PERCENT = 50;
const CLOSED_TIMELINE_PANEL_SIZE_PERCENT = 100;

interface PendingSubmittedFollowUp {
  signature: string;
  submittedAt: number;
}

const MANAGER_DEBUG_VIEW_STORAGE_KEY_PREFIX = "thread-manager-debug-view:";

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
  const [showManagerDebugView, setShowManagerDebugView] = useState(false);
  const { data: projects } = useProjects();
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const project = projects?.find((candidate) => candidate.id === projectId);
  const primaryManagerThreadId = project?.primaryManagerThreadId;
  const { data: primaryManagerThread } = useThread(primaryManagerThreadId ?? "");
  const { data: timeline, isLoading: timelineLoading } = useThreadTimeline(
    threadId ?? "",
    {
      refetchOnMount: "always",
      includeManagerDebugView: showManagerDebugView,
    },
  );
  const { data: defaultExecutionOptions } = useThreadDefaultExecutionOptions(
    threadId ?? "",
  );
  const {
    data: managerWorkspaceFiles,
  } = useThreadManagerWorkspaceFiles(threadId ?? "", {
    enabled: thread?.type === "manager",
  });
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
  const deleteThread = useDeleteThread();
  const updateThread = useUpdateThread();
  const uploadPromptAttachment = useUploadPromptAttachment();
  const promptDraft = usePromptDraftStorage({ projectId, threadId });
  const environmentCatalog = useSystemEnvironments();
  const fileMentions = usePromptFileMentions(projectId, {
    includeThreads: thread?.type === "manager",
    currentThreadId: threadId,
  });
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
  const [threadDeleteTarget, setThreadDeleteTarget] = useState<Thread | null>(null);
  const [threadGitActionTarget, setThreadGitActionTarget] =
    useState<ThreadGitActionDialogTarget | null>(null);
  const [selectedManagerWorkspacePath, setSelectedManagerWorkspacePath] = useState<string | null>(
    null,
  );
  const effectiveManagerWorkspacePath =
    thread?.type === "manager"
      ? selectedManagerWorkspacePath ?? managerWorkspaceFiles?.files?.[0]?.path ?? null
      : null;
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!threadId || thread?.type !== "manager") {
      setShowManagerDebugView(false);
      return;
    }
    const rawValue = window.localStorage.getItem(
      `${MANAGER_DEBUG_VIEW_STORAGE_KEY_PREFIX}${threadId}`,
    );
    setShowManagerDebugView(rawValue === "true");
  }, [thread?.type, threadId]);

  const handleManagerDebugViewChange = useCallback(
    (checked: boolean) => {
      setShowManagerDebugView(checked);
      if (typeof window === "undefined" || !threadId || thread?.type !== "manager") {
        return;
      }
      if (checked) {
        window.localStorage.setItem(
          `${MANAGER_DEBUG_VIEW_STORAGE_KEY_PREFIX}${threadId}`,
          "true",
        );
        return;
      }
      window.localStorage.removeItem(
        `${MANAGER_DEBUG_VIEW_STORAGE_KEY_PREFIX}${threadId}`,
      );
    },
    [thread?.type, threadId],
  );
  const {
    data: managerWorkspaceFile,
    isLoading: isManagerWorkspaceFileLoading,
    error: managerWorkspaceFileError,
  } = useThreadManagerWorkspaceFile(threadId ?? "", effectiveManagerWorkspacePath, {
    enabled: thread?.type === "manager" && effectiveManagerWorkspacePath !== null,
  });
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
  } = usePromptModelReasoning({
    scope: "thread",
    resetKey: threadId,
    initialProviderId: thread?.providerId,
    initialModel: defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialSandboxMode: defaultExecutionOptions?.sandboxMode,
    initialEnvironmentSelectionValue: thread?.environmentId,
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
  const isReasoningBlockActive = false;
  const isTimelineLoading = timelineLoading;
  const isThreadTimelinePending = isTimelineLoading && threadDetailRows.length === 0;
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
      threadToolGroupMessages.mutateAsync({
        ...args,
        includeManagerDebugView: showManagerDebugView,
      }),
  });
  captureTimelineScrollPositionRef.current = captureTimelineScrollPosition;
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
    if (thread?.type !== "manager") {
      setSelectedManagerWorkspacePath(null);
      return;
    }
    const files = managerWorkspaceFiles?.files ?? [];
    if (files.length === 0) {
      setSelectedManagerWorkspacePath(null);
      return;
    }
    setSelectedManagerWorkspacePath((currentPath) =>
      currentPath && files.some((file) => file.path === currentPath)
        ? currentPath
        : null,
    );
  }, [managerWorkspaceFiles?.files, thread?.type]);

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

  const isManagerThread = thread?.type === "manager";
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

    addOption(parentThreadId, parentThreadDisplayName ?? "Manager");
    addOption(
      primaryManagerThreadId ?? undefined,
      primaryManagerThread?.title?.trim() ? primaryManagerThread.title : "Manager",
    );

    return options;
  }, [
    isManagerThread,
    parentThreadDisplayName,
    parentThreadId,
    primaryManagerThread,
    primaryManagerThreadId,
    thread,
  ]);
  const managerSelectorValue = parentThreadId ?? "none";
  const selectedManagerOption = managerSelectorOptions.find(
    (option) => option.value === managerSelectorValue,
  );

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
  const canUseGitUi = !isManagerThread;
  const canAssignToManager =
    thread.type === "standard" &&
    !thread.parentThreadId &&
    Boolean(primaryManagerThreadId) &&
    primaryManagerThreadId !== thread.id;
  const canTakeOverThread =
    thread.type === "standard" && Boolean(thread.parentThreadId);
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
  const showPrimaryCheckoutAction = canUseGitUi && supportsPrimaryCheckout && !isArchivedThread;
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
    if (!canUseGitUi || !resolvedThreadWorkStatus || isArchivedThread) {
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
  const projectRootPath = project?.rootPath;
  const threadEnvironmentLabel = formatThreadEnvironmentLabel({
    projectRootPath,
    attachedEnvironment: thread.attachedEnvironment,
  });
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
  const showPromptGitStatsBanner = canUseGitUi && Boolean(
    resolvedThreadWorkStatus &&
    (
      showBranchComparisonUi
        ? resolvedThreadWorkStatus.changedFiles > 0
        : resolvedThreadWorkStatus.workspaceChangedFiles > 0
    ),
  );
  const canExpandPromptChangeList = Boolean(
    canUseGitUi &&
    resolvedThreadWorkStatus &&
    (resolvedThreadWorkStatus.files?.length ?? 0) > 0,
  );
  const promptBannerMergeBaseBranch = effectiveMergeBaseBranch;
  const threadEnvironmentType =
    threadEnvironmentLabel ??
    (thread.attachedEnvironment?.descriptor ? thread.attachedEnvironment.descriptor.type : undefined);
  const threadBranchName = resolvedThreadWorkStatus?.currentBranch;
  const threadMergeBaseBranch = effectiveMergeBaseBranch;
  const showThreadWorkspaceStatus =
    canUseGitUi &&
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
  const showThreadChangedFiles = canUseGitUi && Boolean(
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
    isManagerThread ||
    parentThreadId ||
      (!isManagerThread && threadEnvironmentType) ||
      (!isManagerThread && threadBranchName) ||
      (!isManagerThread && showThreadMergeBase) ||
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
    deleteThread.isPending ||
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
      <DetailRow
        label={isManagerThread ? "Kind" : "Type"}
        valueClassName="min-w-0 truncate"
      >
        {isManagerThread
          ? "Manager"
          : parentThreadId
            ? "Managed thread"
            : "Thread"}
      </DetailRow>
      {!isManagerThread &&
      (parentThreadId || canAssignToManager || canTakeOverThread) ? (
        <DetailRow
          label="Manager"
          valueClassName="min-w-0"
        >
          {parentThreadId ? (
            <div className="inline-flex h-7 max-w-full min-w-0 items-center gap-1 text-xs text-foreground">
              <Link
                to={`/projects/${projectId}/threads/${parentThreadId}`}
                className="min-w-0 truncate text-xs text-foreground no-underline transition-[text-decoration-color] duration-150 hover:underline hover:underline-offset-2"
              >
                {selectedManagerOption?.label ?? "Manager"}
              </Link>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-3.5 shrink-0 rounded-full p-0 text-muted-foreground hover:bg-transparent hover:text-foreground [&_svg]:size-3"
                disabled={updateThread.isPending}
                onClick={() => {
                  updateThread.mutate({
                    id: thread.id,
                    parentThreadId: null,
                  });
                }}
                aria-label="Unassign manager"
              >
                  <X />
              </Button>
            </div>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <div
                  role="button"
                  tabIndex={
                    updateThread.isPending ||
                    (managerSelectorOptions.length <= 1 && managerSelectorValue === "none")
                      ? -1
                      : 0
                  }
                  className="inline-flex h-8 w-fit max-w-full min-w-0 items-center gap-1 rounded-md px-0 text-xs leading-tight text-foreground outline-none ring-sidebar-ring transition-colors hover:text-foreground focus-visible:ring-2"
                >
                  <span className="min-w-0 truncate text-xs text-foreground">
                    {selectedManagerOption?.label ?? "None"}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-40 max-w-72">
                {managerSelectorOptions.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => {
                      updateThread.mutate({
                        id: thread.id,
                        parentThreadId: option.value === "none" ? null : option.value,
                      });
                    }}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="truncate" title={option.label}>
                      {option.label}
                    </span>
                    <Check
                      className={managerSelectorValue === option.value ? "size-4 opacity-100" : "size-4 opacity-0"}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </DetailRow>
      ) : null}
      {!isManagerThread && threadEnvironmentType ? (
        <DetailRow
          label="Environment"
          valueClassName="min-w-0 truncate"
        >
          {threadEnvironmentType}
        </DetailRow>
      ) : null}
      {!isManagerThread && threadBranchName ? (
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
      {!isManagerThread && showThreadMergeBase ? (
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
  const managerWorkspaceContent = thread.type === "manager" ? (
    <div className="space-y-2">
      {(managerWorkspaceFiles?.files?.length ?? 0) > 0 ? (
        managerWorkspaceFiles?.files.map((file) => {
          const isExpanded = effectiveManagerWorkspacePath === file.path;
          const isActiveFile = isExpanded;

          return (
            <div
              key={file.path}
              className="overflow-hidden rounded-lg border border-border/70 bg-background/45"
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/20"
                onClick={() => {
                  setSelectedManagerWorkspacePath((currentPath) =>
                    currentPath === file.path ? null : file.path,
                  );
                }}
                aria-expanded={isExpanded}
              >
                {isExpanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                  {file.path}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {file.size} B
                </span>
              </button>
              {isExpanded ? (
                <div className="border-t border-border/70 px-3 py-3">
                  {isManagerWorkspaceFileLoading && isActiveFile ? (
                    <p className="text-xs text-muted-foreground">Loading file…</p>
                  ) : managerWorkspaceFileError && isActiveFile ? (
                    <p className="text-xs text-destructive">
                      {managerWorkspaceFileError instanceof Error
                        ? managerWorkspaceFileError.message
                        : "Failed to load workspace file"}
                    </p>
                  ) : managerWorkspaceFile && isActiveFile ? (
                    <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                      {managerWorkspaceFile.content}
                    </pre>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Select a manager workspace file to view it.
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          );
        })
      ) : (
        <p className="rounded-lg border border-dashed border-border/70 bg-background/45 px-3 py-6 text-center text-sm text-muted-foreground">
          No files yet.
        </p>
      )}
    </div>
  ) : undefined;
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
        setThreadDeleteTarget(thread);
      }}
      debugToggleLabel={isManagerThread ? "Show all events" : undefined}
      debugToggleChecked={isManagerThread ? showManagerDebugView : undefined}
      onDebugToggleCheckedChange={
        isManagerThread ? handleManagerDebugViewChange : undefined
      }
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
          reasoningLevel,
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
        reasoningLevel,
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

  const effectiveSecondaryPanel =
    !canUseGitUi && activeSecondaryPanel === "git-diff"
      ? "thread-info"
      : !isManagerThread && activeSecondaryPanel === "manager-workspace"
        ? "thread-info"
        : activeSecondaryPanel;

  const timelineHeader = (
    <header className="shrink-0 border-b border-border/80 bg-background/95 px-4 backdrop-blur-sm">
      <div className="flex h-12 items-center gap-3">
        <SidebarTrigger className="h-5 w-5 shrink-0 rounded-md p-0" />
        <Separator orientation="vertical" className="h-4" />
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <p className="truncate text-sm font-semibold">{threadTitle}</p>
          {isManagerThread ? <StatusPill variant="outline">manager</StatusPill> : null}
          {!isManagerThread && parentThreadId ? (
            <StatusPill variant="outline">managed</StatusPill>
          ) : null}
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
      isDiffPanelActive={canUseGitUi && isDiffPanelActive}
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
      onPromptGitStatsBannerClick={
        canUseGitUi ? handlePromptGitStatsBannerClick : () => {}
      }
      onPromptBannerFileClick={
        canUseGitUi ? handlePromptBannerFileClick : () => {}
      }
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
      hasMultipleProviders={hasMultipleProviders}
      providerOptions={providerOptions}
      selectedProviderId={selectedProviderId}
      providerDisplayName={selectedProviderDisplayName}
      activeModel={activeModel}
      selectedModel={selectedModel}
      modelOptions={modelOptions}
      onSelectedModelChange={setSelectedModel}
      serviceTier={serviceTier}
      onServiceTierChange={setServiceTier}
      supportsServiceTier={supportsServiceTier}
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
              bottomSentinelRef={bottomSentinelRef}
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
            activePanel={effectiveSecondaryPanel}
            metadataContent={
              showThreadMetadata ? (
                renderThreadMetadataContent()
              ) : (
                <div className="pt-1 text-sm text-muted-foreground">
                  No thread details available.
                </div>
              )
            }
            managerWorkspaceContent={managerWorkspaceContent}
            showManagerWorkspaceTab={thread.type === "manager"}
            showGitDiffTab={canUseGitUi}
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
            isGitDiffLoading={canUseGitUi ? isGitDiffLoading : false}
            gitDiffError={canUseGitUi ? gitDiffError : undefined}
            threadGitDiff={canUseGitUi ? threadGitDiff : undefined}
            currentGitDiff={canUseGitUi ? currentGitDiff : ""}
            isPreparingGitDiff={canUseGitUi ? isPreparingGitDiff : false}
            isParsingGitDiffFiles={canUseGitUi ? isParsingGitDiffFiles : false}
            gitDiffStatsLabel={canUseGitUi ? gitDiffStatsLabel : ""}
            hasParsedGitDiffFiles={canUseGitUi ? hasParsedGitDiffFiles : false}
            areAllGitDiffFilesCollapsed={canUseGitUi ? areAllGitDiffFilesCollapsed : true}
            onToggleAllFiles={toggleAllGitDiffFilesCollapsed}
            gitDiffDisplayMode={gitDiffDisplayMode}
            onGitDiffDisplayModeChange={handleGitDiffDisplayModeChange}
            parsedGitDiffFileEntries={canUseGitUi ? parsedGitDiffFileEntries : []}
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
      <ThreadDeleteDialog
        target={threadDeleteTarget}
        pending={deleteThread.isPending}
        onOpenChange={(open) => {
          if (!open) {
            setThreadDeleteTarget(null);
          }
        }}
        onDelete={(target) => {
          deleteThread.mutate(
            { id: target.id },
            {
              onSuccess: () => {
                setThreadDeleteTarget(null);
                navigate(`/projects/${target.projectId}`, { replace: true });
              },
              onError: (error) => {
                toast.error(
                  error instanceof Error ? error.message : "Failed to delete thread.",
                );
              },
            },
          );
        }}
      />
      {canUseGitUi ? (
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
      ) : null}
    </>
  );
}
