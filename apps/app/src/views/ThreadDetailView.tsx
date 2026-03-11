import {
  type ComponentProps,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Copy, PanelRight } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
} from "react-resizable-panels";
import {
  useThread,
  useThreadWorkStatus,
  useThreadMergeBaseBranches,
  useThreadTimeline,
  useThreadGitDiff,
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
import {
  ConversationEntry,
} from "@/components/messages/ConversationEntry";
import { ConversationWorkingIndicator } from "@/components/messages/ConversationWorkingIndicator";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useScrollToBottomIndicator } from "@/hooks/useScrollToBottomIndicator";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { usePreferredTheme } from "@/hooks/useTheme";
import { PageShell } from "@/components/layout/PageShell";
import { ThreadGitStatusDetails } from "@/components/shared/ThreadGitStatusDetails";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import {
  ThreadGitActionDialog,
  type ThreadGitActionDialogTarget,
} from "@/components/thread/ThreadGitActionDialog";
import {
  ThreadRenameDialog,
  type ThreadRenameDialogTarget,
} from "@/components/thread/ThreadRenameDialog";
import {
  DEFAULT_SCROLL_STICK_THRESHOLD_PX,
  DetailCard,
  DetailRow,
  ConversationEmptyState,
  ConversationTimeline,
  ExpandablePanel,
  StatusPill,
} from "@beanbag/ui-core";
import {
  formatEnvironmentDisplayName,
  type PromptInput,
  type ServiceTier,
  type UIMessage,
} from "@beanbag/agent-core";
import { type ThreadDetailToolGroupRow } from "./threadDetailRows";
import {
  useLatestInitialExpanded,
} from "@/lib/latestInitialExpanded";
import {
  promptDraftToInput,
} from "@/lib/prompt-draft";
import { HttpError } from "@/lib/api";
import { getAutoArchivePreferences } from "@/lib/auto-archive-preferences";
import { getEnvironmentIconInfo } from "@/lib/environment-icon";
import { ArchiveTimestampAction } from "@/components/shared/ArchiveTimestampAction";
import {
  getThreadGitStatusDisplay,
} from "@/lib/thread-work-status";
import {
  getThreadSecondaryPanel,
  getStoredThreadSecondaryPanel,
  setStoredThreadSecondaryPanel,
  withThreadSecondaryPanel,
  type ThreadSecondaryPanel,
} from "@/lib/thread-git-diff-panel";
import { supportsPrimaryCheckoutMetadata } from "@/lib/thread-primary-checkout";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import {
  isArchiveForceRequiredError,
  requiresArchiveConfirmation,
} from "@/lib/thread-archive";
import { ThreadFollowUpComposer } from "./ThreadFollowUpComposer";
import {
  type GitDiffSelectionOption,
  ThreadGitDiffPanel,
} from "./ThreadGitDiffPanel";
import {
  findLatestActivityRowId,
  isLastThreadRowShowingOngoingState,
  shouldPreferOngoingLabelsForRow,
} from "./threadDetailActivity";
import {
  doesGitDiffFileMatchPath,
  getGitDiffParseKey,
  getParsedGitDiffFileKey,
  parseGitDiffFiles,
  parseGitDiffPatchChunks,
  splitGitDiffIntoPatchChunks,
  summarizeGitDiff,
  type ParsedGitDiffFile,
} from "./threadDetailGitDiff";
import {
  extractThreadQueuedMessages,
  queuedInputToDraft,
} from "./threadQueuedMessages";
import { cn } from "@/lib/utils";
import {
  EventTitle,
  formatSummaryDuration,
  getEventHeaderToneClass,
} from "@/components/messages/rows/shared";
import { toast } from "sonner";

const SCROLL_THRESHOLD = 40;
const THREAD_HEADER_ACTION_BUTTON_CLASS =
  "h-7 rounded-md border-border/70 bg-background/70 px-2 text-xs font-medium text-foreground/85 shadow-none hover:bg-muted/45 hover:text-foreground";
const TIMELINE_PANEL_DEFAULT_SIZE_PERCENT = 50;
const CLOSED_TIMELINE_PANEL_SIZE_PERCENT = 100;
const GIT_DIFF_FILE_RENDER_SPINNER_MS = 150;
const GIT_DIFF_SPLIT_VIEW_MIN_WIDTH_PX = 760;
const GIT_DIFF_PARSE_BATCH_THRESHOLD = 24;
const GIT_DIFF_PARSE_INITIAL_BATCH_SIZE = 6;
const GIT_DIFF_PARSE_BATCH_SIZE = 18;
const GIT_DIFF_PARSE_BATCH_DELAY_MS = 24;
const GIT_DIFF_FILE_INITIAL_RENDER_COUNT = 4;
const GIT_DIFF_FILE_RENDER_BATCH_SIZE = 6;
const GIT_DIFF_FILE_INITIAL_DELAY_MS = 30;
const GIT_DIFF_FILE_RENDER_BATCH_DELAY_MS = 70;
const TIMELINE_ROW_SELECTOR = "[data-thread-row-id]";
const GIT_DIFF_VIEW_BASE_OPTIONS = {
  overflow: "scroll",
  diffStyle: "unified",
  disableFileHeader: false,
} as const;

interface TimelineScrollAnchor {
  rowId: string;
  offsetTop: number;
}

function isNearBottom(container: HTMLDivElement): boolean {
  const distanceFromBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  return distanceFromBottom <= DEFAULT_SCROLL_STICK_THRESHOLD_PX;
}

function captureTimelineScrollAnchor(
  container: HTMLDivElement,
): TimelineScrollAnchor | null {
  if (isNearBottom(container)) return null;

  const containerRect = container.getBoundingClientRect();
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>(TIMELINE_ROW_SELECTOR),
  );

  for (const row of rows) {
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom <= containerRect.top + 1) continue;
    const rowId = row.dataset.threadRowId;
    if (!rowId) continue;
    return {
      rowId,
      offsetTop: rowRect.top - containerRect.top,
    };
  }

  return null;
}

function findTimelineRowElement(
  container: HTMLDivElement,
  rowId: string,
): HTMLElement | null {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>(TIMELINE_ROW_SELECTOR),
  );
  return rows.find((row) => row.dataset.threadRowId === rowId) ?? null;
}

function ToolGroupEntry({
  projectId,
  entry,
  messages,
  isLoadingMessages,
  onLoadMessages,
  initialExpanded,
  preferOngoingLabels,
}: {
  projectId?: string;
  entry: ThreadDetailToolGroupRow;
  messages: ThreadDetailToolGroupRow["messages"];
  isLoadingMessages: boolean;
  onLoadMessages: () => void;
  initialExpanded: boolean;
  preferOngoingLabels: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const count = entry.summaryCount;
  const visibleDuration = formatSummaryDuration(entry.durationMs);
  const isWorking = entry.status === "pending";
  const summaryContent = visibleDuration ? (
    <EventTitle
      prefix={isWorking ? "Working for" : "Worked for"}
      emphasis={visibleDuration}
      suffix={count > 0 ? `${count} item${count === 1 ? "" : "s"}` : undefined}
      suffixClassName="truncate"
      shimmerPrefix={isWorking}
    />
  ) : (
    <EventTitle
      prefix={isWorking ? "Working on" : "Worked on"}
      emphasis={`${count} item${count === 1 ? "" : "s"}`}
      shimmerPrefix={isWorking}
    />
  );
  const headerToneClass = getEventHeaderToneClass(isExpanded);

  useEffect(() => {
    if (!isExpanded || isLoadingMessages || messages.length > 0) {
      return;
    }
    onLoadMessages();
  }, [isExpanded, isLoadingMessages, messages.length, onLoadMessages]);

  const handleToggle = () => {
    if (!isExpanded && messages.length === 0 && !isLoadingMessages) {
      onLoadMessages();
    }
    onToggle();
  };

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          onToggle={handleToggle}
          headerToneClass={headerToneClass}
          summaryContent={summaryContent}
          bodyClassName="duration-300"
          contentClassName="pb-1 duration-300"
        >
          <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
            {isLoadingMessages ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                <span className="animate-shine">Loading details...</span>
              </div>
            ) : null}
            {messages.map((message, messageIndex) => {
              const isLatestMessage = messageIndex === messages.length - 1;
              return (
                <ConversationEntry
                  key={message.id}
                  message={message}
                  projectId={projectId}
                  initialExpanded={isExpanded && isLatestMessage}
                  preferOngoingLabels={preferOngoingLabels && isLatestMessage}
                />
              );
            })}
          </div>
        </ExpandablePanel>
      </div>
    </div>
  );
}

export function ThreadDetailView() {
  const { projectId, threadId } = useParams<{
    projectId: string;
    threadId: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();
  const searchSecondaryPanel = useMemo(
    () => getThreadSecondaryPanel(location.search),
    [location.search],
  );
  const [persistedSecondaryPanel, setPersistedSecondaryPanel] =
    useState<ThreadSecondaryPanel | null>(() => getStoredThreadSecondaryPanel());
  const activeSecondaryPanel = searchSecondaryPanel ?? persistedSecondaryPanel;
  const isSecondaryPanelOpen = activeSecondaryPanel !== null;
  const isGitDiffPanelOpen = activeSecondaryPanel === "git-diff";
  const [shouldLoadMergeBaseBranchOptions, setShouldLoadMergeBaseBranchOptions] = useState(false);
  const [isMergeBaseBranchPickerOpen, setIsMergeBaseBranchPickerOpen] = useState(false);
  const [selectedGitDiffCommitSha, setSelectedGitDiffCommitSha] = useState<string | null>(
    null,
  );
  const { data: thread, isLoading, error } = useThread(threadId ?? "", {
    refetchOnMount: "always",
  });
  const {
    data: threadWorkStatus,
    error: threadWorkStatusError,
  } = useThreadWorkStatus(
    threadId ?? "",
    thread?.mergeBaseBranchOverride,
  );
  const {
    data: mergeBaseBranchOptions,
    isLoading: isLoadingMergeBaseBranchOptions,
  } = useThreadMergeBaseBranches(threadId ?? "", {
    enabled:
      Boolean(threadId) &&
      shouldLoadMergeBaseBranchOptions &&
      isMergeBaseBranchPickerOpen,
  });
  const resolvedThreadWorkStatus =
    threadWorkStatusError ? undefined : (threadWorkStatus ?? undefined);
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
  const [loadingToolGroupIds, setLoadingToolGroupIds] = useState<Set<string>>(new Set());
  const [toolGroupMessagesById, setToolGroupMessagesById] = useState<
    Record<string, UIMessage[]>
  >({});
  const [isChangeListExpanded, setIsChangeListExpanded] = useState(false);
  const [processingQueuedMessageId, setProcessingQueuedMessageId] = useState<string | null>(
    null,
  );
  const [threadRenameTarget, setThreadRenameTarget] = useState<ThreadRenameDialogTarget | null>(
    null,
  );
  const [threadGitActionTarget, setThreadGitActionTarget] =
    useState<ThreadGitActionDialogTarget | null>(null);
  const [gitDiffDisplayMode, setGitDiffDisplayMode] = useState<"unified" | "split">(
    "unified",
  );
  const [hasExplicitGitDiffDisplayMode, setHasExplicitGitDiffDisplayMode] = useState(false);
  const [isGitDiffPanelResizing, setIsGitDiffPanelResizing] = useState(false);
  const [gitDiffPanelWidth, setGitDiffPanelWidth] = useState<number | null>(null);
  const [collapsedGitDiffFileKeys, setCollapsedGitDiffFileKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [loadingGitDiffFileKeys, setLoadingGitDiffFileKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [parsedGitDiffFiles, setParsedGitDiffFiles] = useState<ParsedGitDiffFile[]>([]);
  const [isParsingGitDiffFiles, setIsParsingGitDiffFiles] = useState(false);
  const [lastParsedGitDiffKey, setLastParsedGitDiffKey] = useState("");
  const [pendingGitDiffScrollPath, setPendingGitDiffScrollPath] = useState<string | null>(
    null,
  );
  const gitDiffPanelRef = useRef<HTMLElement | null>(null);
  const gitDiffResizablePanelRef = useRef<ImperativePanelHandle | null>(null);
  const lastGitDiffPanelSizeRef = useRef(TIMELINE_PANEL_DEFAULT_SIZE_PERCENT);
  const lastGitDiffWideEnoughRef = useRef<boolean | null>(null);
  const gitDiffFileRenderTimersRef = useRef<Map<string, number>>(new Map());
  const queuedGitDiffFileRenderKeysRef = useRef<Set<string>>(new Set());
  const gitDiffFileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const markedReadKeysRef = useRef<Set<string>>(new Set());
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
    initialModel: defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialSandboxMode: defaultExecutionOptions?.sandboxMode,
    initialEnvironmentId: thread?.environmentId,
  });
  const preferredTheme = usePreferredTheme();
  const gitDiffViewOptions = useMemo(
    () => ({
      ...GIT_DIFF_VIEW_BASE_OPTIONS,
      diffStyle: gitDiffDisplayMode,
      themeType: preferredTheme,
    }),
    [gitDiffDisplayMode, preferredTheme],
  );

  useEffect(() => {
    if (searchSecondaryPanel === null) {
      return;
    }

    setPersistedSecondaryPanel((currentPanel) =>
      currentPanel === searchSecondaryPanel ? currentPanel : searchSecondaryPanel,
    );
    setStoredThreadSecondaryPanel(searchSecondaryPanel);
  }, [searchSecondaryPanel]);

  const threadDetailRows = useMemo(() => timeline?.rows ?? [], [timeline?.rows]);
  const contextWindowUsage = timeline?.contextWindowUsage ?? undefined;
  const latestActivityRowId = useMemo(
    () => findLatestActivityRowId(threadDetailRows),
    [threadDetailRows],
  );
  const isLastThreadRowShowingOngoingIndicator = useMemo(
    () => isLastThreadRowShowingOngoingState(threadDetailRows, latestActivityRowId),
    [latestActivityRowId, threadDetailRows],
  );

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
  const gitDiffSelection = useMemo(
    () =>
      selectedGitDiffCommitSha
        ? { type: "commit" as const, sha: selectedGitDiffCommitSha }
        : { type: "combined" as const },
    [selectedGitDiffCommitSha],
  );
  const {
    data: threadGitDiff,
    isLoading: isGitDiffLoading,
    error: gitDiffError,
  } = useThreadGitDiff(threadId ?? "", {
    enabled: Boolean(threadId) && isGitDiffPanelOpen,
    selection: gitDiffSelection,
    mergeBaseBranch: thread?.mergeBaseBranchOverride,
  });
  const parsedGitDiffFileEntries = useMemo(
    () =>
      parsedGitDiffFiles.map((fileDiff, index) => ({
        key: getParsedGitDiffFileKey(fileDiff, index),
        fileDiff,
      })),
    [parsedGitDiffFiles],
  );
  const isGitDiffPanelWideEnough =
    gitDiffPanelWidth !== null && gitDiffPanelWidth >= GIT_DIFF_SPLIT_VIEW_MIN_WIDTH_PX;

  useLayoutEffect(() => {
    const panel = gitDiffResizablePanelRef.current;
    if (!panel) {
      return;
    }

    if (isSecondaryPanelOpen) {
      panel.expand(lastGitDiffPanelSizeRef.current);
      return;
    }

    panel.collapse();
  }, [isSecondaryPanelOpen]);

  useLayoutEffect(() => {
    if (!isSecondaryPanelOpen) {
      return;
    }

    const panelElement = gitDiffPanelRef.current;
    if (!panelElement) {
      return;
    }

    const updateWidth = (nextWidth: number) => {
      const roundedWidth = Math.round(nextWidth);
      setGitDiffPanelWidth((currentWidth) =>
        currentWidth === roundedWidth ? currentWidth : roundedWidth,
      );
    };

    updateWidth(panelElement.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? panelElement.getBoundingClientRect().width;
      updateWidth(width);
    });
    observer.observe(panelElement);
    return () => {
      observer.disconnect();
    };
  }, [isSecondaryPanelOpen]);

  useEffect(() => {
    if (!isSecondaryPanelOpen) {
      setHasExplicitGitDiffDisplayMode(false);
      setGitDiffPanelWidth(null);
      lastGitDiffWideEnoughRef.current = null;
      return;
    }
    if (gitDiffPanelWidth === null) {
      return;
    }

    const previousWideEnough = lastGitDiffWideEnoughRef.current;
    const crossedBreakpoint =
      previousWideEnough !== null &&
      previousWideEnough !== isGitDiffPanelWideEnough;
    if (crossedBreakpoint && hasExplicitGitDiffDisplayMode) {
      setHasExplicitGitDiffDisplayMode(false);
    }

    if (!hasExplicitGitDiffDisplayMode || crossedBreakpoint) {
      const nextMode = isGitDiffPanelWideEnough ? "split" : "unified";
      setGitDiffDisplayMode((currentMode) =>
        currentMode === nextMode ? currentMode : nextMode,
      );
    }

    lastGitDiffWideEnoughRef.current = isGitDiffPanelWideEnough;
  }, [
    gitDiffPanelWidth,
    hasExplicitGitDiffDisplayMode,
    isSecondaryPanelOpen,
    isGitDiffPanelWideEnough,
  ]);

  useEffect(() => {
    const gitDiff = threadGitDiff?.diff ?? "";
    const gitDiffKey = getGitDiffParseKey(gitDiff);
    if (!isGitDiffPanelOpen || gitDiff.trim().length === 0) {
      setParsedGitDiffFiles([]);
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey("");
      return;
    }

    setParsedGitDiffFiles([]);
    const patchChunks = splitGitDiffIntoPatchChunks(gitDiff);
    if (patchChunks.length === 0) {
      setParsedGitDiffFiles([]);
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey(gitDiffKey);
      return;
    }

    if (patchChunks.length <= GIT_DIFF_PARSE_BATCH_THRESHOLD) {
      setParsedGitDiffFiles(parseGitDiffFiles(gitDiff));
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey(gitDiffKey);
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    let nextPatchIndex = 0;
    let appliedFirstBatch = false;

    const parseNextBatch = () => {
      if (cancelled) {
        return;
      }

      const batchSize =
        nextPatchIndex === 0
          ? GIT_DIFF_PARSE_INITIAL_BATCH_SIZE
          : GIT_DIFF_PARSE_BATCH_SIZE;
      const batchChunks = patchChunks.slice(nextPatchIndex, nextPatchIndex + batchSize);
      if (batchChunks.length === 0) {
        setIsParsingGitDiffFiles(false);
        setLastParsedGitDiffKey(gitDiffKey);
        return;
      }

      const parsedBatchFiles = parseGitDiffPatchChunks(batchChunks);
      if (cancelled) {
        return;
      }

      nextPatchIndex += batchChunks.length;
      setParsedGitDiffFiles((currentFiles) =>
        appliedFirstBatch ? [...currentFiles, ...parsedBatchFiles] : parsedBatchFiles,
      );
      appliedFirstBatch = true;

      if (nextPatchIndex >= patchChunks.length || cancelled) {
        setIsParsingGitDiffFiles(false);
        setLastParsedGitDiffKey(gitDiffKey);
        return;
      }

      timerId = window.setTimeout(parseNextBatch, GIT_DIFF_PARSE_BATCH_DELAY_MS);
    };

    setIsParsingGitDiffFiles(true);
    parseNextBatch();

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [isGitDiffPanelOpen, threadGitDiff?.diff]);

  useEffect(() => {
    setLoadingToolGroupIds(new Set());
    setToolGroupMessagesById({});
    setProcessingQueuedMessageId(null);
  }, [threadId]);

  useEffect(() => {
    timelineScrollAnchorRef.current = null;
    timelineContainerWidthRef.current = null;
  }, [threadId]);

  useEffect(() => {
    setShouldLoadMergeBaseBranchOptions(false);
    setIsMergeBaseBranchPickerOpen(false);
  }, [threadId]);

  useEffect(() => {
    setSelectedGitDiffCommitSha(null);
  }, [threadId]);

  useEffect(() => {
    for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    gitDiffFileRenderTimersRef.current.clear();
    setCollapsedGitDiffFileKeys(new Set());
    setLoadingGitDiffFileKeys(new Set());
  }, [threadId, threadGitDiff?.diff]);

  useEffect(() => {
    queuedGitDiffFileRenderKeysRef.current.clear();
  }, [threadId, threadGitDiff?.diff]);

  useEffect(() => {
    setPendingGitDiffScrollPath(null);
  }, [threadId]);

  useEffect(() => {
    if (!threadGitDiff) return;
    if (threadGitDiff.mode !== "worktree_commits") {
      if (selectedGitDiffCommitSha !== null) {
        setSelectedGitDiffCommitSha(null);
      }
      return;
    }
    if (
      selectedGitDiffCommitSha &&
      !threadGitDiff.commits.some((commit) => commit.sha === selectedGitDiffCommitSha)
    ) {
      setSelectedGitDiffCommitSha(null);
    }
  }, [selectedGitDiffCommitSha, threadGitDiff]);

  useEffect(
    () => () => {
      for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      gitDiffFileRenderTimersRef.current.clear();
      queuedGitDiffFileRenderKeysRef.current.clear();
    },
    [],
  );

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

  const handleGitDiffDisplayModeChange = useCallback((nextMode: "unified" | "split") => {
    setHasExplicitGitDiffDisplayMode(true);
    setGitDiffDisplayMode(nextMode);
  }, []);

  const handleGitDiffPanelDragging = useCallback((isDragging: boolean) => {
    setIsGitDiffPanelResizing(isDragging);
    if (isDragging) {
      // Treat panel resizing as opting back into responsive split/stacked mode.
      setHasExplicitGitDiffDisplayMode(false);
    }
  }, []);
  const handleGitDiffPanelResize = useCallback((size: number) => {
    if (size <= 0) {
      return;
    }

    lastGitDiffPanelSizeRef.current = size;
  }, []);

  const handleLoadToolGroupMessages = useCallback(
    (entry: ThreadDetailToolGroupRow) => {
      if (!threadId) return;
      if (entry.messages.length > 0 || toolGroupMessagesById[entry.id]) return;
      if (loadingToolGroupIds.has(entry.id)) return;
      setLoadingToolGroupIds((prev) => new Set(prev).add(entry.id));
      void threadToolGroupMessages
        .mutateAsync({
          id: threadId,
          turnId: entry.turnId,
          sourceSeqStart: entry.sourceSeqStart,
          sourceSeqEnd: entry.sourceSeqEnd,
        })
        .then((response) => {
          setToolGroupMessagesById((prev) => ({
            ...prev,
            [entry.id]: response.messages,
          }));
        })
        .finally(() => {
          setLoadingToolGroupIds((prev) => {
            const next = new Set(prev);
            next.delete(entry.id);
            return next;
          });
        });
    },
    [
      loadingToolGroupIds,
      threadId,
      threadToolGroupMessages,
      toolGroupMessagesById,
    ],
  );

  const scheduleGitDiffFileRender = useCallback(
    (
      fileKeys: readonly string[],
      options?: {
        initialBatchSize?: number;
        initialDelayMs?: number;
        batchSize?: number;
        batchDelayMs?: number;
      },
    ) => {
      if (fileKeys.length === 0) return;

      const initialBatchSize = Math.max(
        1,
        Math.min(options?.initialBatchSize ?? fileKeys.length, fileKeys.length),
      );
      const batchSize = Math.max(1, options?.batchSize ?? fileKeys.length);
      const initialDelayMs = Math.max(0, options?.initialDelayMs ?? GIT_DIFF_FILE_RENDER_SPINNER_MS);
      const batchDelayMs = Math.max(0, options?.batchDelayMs ?? GIT_DIFF_FILE_RENDER_SPINNER_MS);

      setLoadingGitDiffFileKeys((currentKeys) => {
        const nextKeys = new Set(currentKeys);
        for (const key of fileKeys) {
          nextKeys.add(key);
        }
        return nextKeys;
      });

      for (let index = 0; index < fileKeys.length; index += 1) {
        const key = fileKeys[index]!;
        const existingTimer = gitDiffFileRenderTimersRef.current.get(key);
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer);
        }
        const delay =
          index < initialBatchSize
            ? initialDelayMs
            : initialDelayMs + (Math.floor((index - initialBatchSize) / batchSize) + 1) * batchDelayMs;
        const timerId = window.setTimeout(() => {
          setLoadingGitDiffFileKeys((currentKeys) => {
            if (!currentKeys.has(key)) return currentKeys;
            const nextKeys = new Set(currentKeys);
            nextKeys.delete(key);
            return nextKeys;
          });
          gitDiffFileRenderTimersRef.current.delete(key);
        }, delay);
        gitDiffFileRenderTimersRef.current.set(key, timerId);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isGitDiffPanelOpen || parsedGitDiffFileEntries.length === 0) {
      return;
    }

    const newKeysToRender: string[] = [];
    for (const { key } of parsedGitDiffFileEntries) {
      if (queuedGitDiffFileRenderKeysRef.current.has(key)) {
        continue;
      }
      queuedGitDiffFileRenderKeysRef.current.add(key);
      if (!collapsedGitDiffFileKeys.has(key)) {
        newKeysToRender.push(key);
      }
    }

    if (newKeysToRender.length === 0) {
      return;
    }

    const shouldBatchRender =
      parsedGitDiffFileEntries.length > GIT_DIFF_PARSE_BATCH_THRESHOLD ||
      isParsingGitDiffFiles ||
      newKeysToRender.length > GIT_DIFF_FILE_INITIAL_RENDER_COUNT;
    scheduleGitDiffFileRender(
      newKeysToRender,
      shouldBatchRender
        ? {
            initialBatchSize: GIT_DIFF_FILE_INITIAL_RENDER_COUNT,
            initialDelayMs: GIT_DIFF_FILE_INITIAL_DELAY_MS,
            batchSize: GIT_DIFF_FILE_RENDER_BATCH_SIZE,
            batchDelayMs: GIT_DIFF_FILE_RENDER_BATCH_DELAY_MS,
          }
        : undefined,
    );
  }, [
    collapsedGitDiffFileKeys,
    isGitDiffPanelOpen,
    isParsingGitDiffFiles,
    parsedGitDiffFileEntries,
    scheduleGitDiffFileRender,
  ]);

  const toggleGitDiffFileCollapsed = useCallback((fileKey: string) => {
    const isExpandingFile = collapsedGitDiffFileKeys.has(fileKey);
    setCollapsedGitDiffFileKeys((currentKeys) => {
      const nextKeys = new Set(currentKeys);
      if (isExpandingFile) {
        nextKeys.delete(fileKey);
      } else {
        nextKeys.add(fileKey);
      }
      return nextKeys;
    });
    if (isExpandingFile) {
      scheduleGitDiffFileRender([fileKey]);
      return;
    }
    const existingTimer = gitDiffFileRenderTimersRef.current.get(fileKey);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      gitDiffFileRenderTimersRef.current.delete(fileKey);
    }
    setLoadingGitDiffFileKeys((currentKeys) => {
      if (!currentKeys.has(fileKey)) return currentKeys;
      const nextKeys = new Set(currentKeys);
      nextKeys.delete(fileKey);
      return nextKeys;
    });
  }, [collapsedGitDiffFileKeys, scheduleGitDiffFileRender]);

  const toggleAllGitDiffFilesCollapsed = useCallback(() => {
    if (parsedGitDiffFileEntries.length === 0) return;
    const allFileKeys = parsedGitDiffFileEntries.map(({ key }) => key);
    const areAllCollapsed = allFileKeys.every((key) => collapsedGitDiffFileKeys.has(key));
    if (areAllCollapsed) {
      setCollapsedGitDiffFileKeys(new Set());
      scheduleGitDiffFileRender(allFileKeys);
      return;
    }
    for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    gitDiffFileRenderTimersRef.current.clear();
    setCollapsedGitDiffFileKeys(new Set(allFileKeys));
    setLoadingGitDiffFileKeys(new Set());
  }, [collapsedGitDiffFileKeys, parsedGitDiffFileEntries, scheduleGitDiffFileRender]);
  const setGitDiffFileRef = useCallback((fileKey: string, element: HTMLDivElement | null) => {
    if (element) {
      gitDiffFileRefs.current.set(fileKey, element);
      return;
    }
    gitDiffFileRefs.current.delete(fileKey);
  }, []);
  const setThreadSecondaryPanel = useCallback(
    (panel: ThreadSecondaryPanel | null) => {
      setPersistedSecondaryPanel(panel);
      setStoredThreadSecondaryPanel(panel);
      const nextSearch = withThreadSecondaryPanel(location.search, panel);
      navigate(
        {
          pathname: location.pathname,
          search: nextSearch.length > 0 ? `?${nextSearch}` : "",
        },
        { replace: true },
      );
    },
    [location.pathname, location.search, navigate],
  );
  const openThreadSecondaryPanel = useCallback(
    (panel: ThreadSecondaryPanel) => {
      if (activeSecondaryPanel === panel) {
        return;
      }
      setThreadSecondaryPanel(panel);
    },
    [activeSecondaryPanel, setThreadSecondaryPanel],
  );
  const openThreadGitDiffPanel = useCallback(() => {
    openThreadSecondaryPanel("git-diff");
  }, [openThreadSecondaryPanel]);
  const toggleThreadSecondaryPanel = useCallback(() => {
    if (isSecondaryPanelOpen) {
      setThreadSecondaryPanel(null);
      return;
    }
    openThreadSecondaryPanel("thread-info");
  }, [isSecondaryPanelOpen, openThreadSecondaryPanel, setThreadSecondaryPanel]);
  const closeThreadSecondaryPanel = useCallback(() => {
    if (!isSecondaryPanelOpen) {
      return;
    }
    setThreadSecondaryPanel(null);
  }, [isSecondaryPanelOpen, setThreadSecondaryPanel]);
  const handlePromptGitStatsBannerClick = useCallback(() => {
    openThreadGitDiffPanel();
  }, [openThreadGitDiffPanel]);
  const handlePromptBannerFileClick = useCallback(
    (file: { path: string }) => {
      setSelectedGitDiffCommitSha(null);
      setPendingGitDiffScrollPath(file.path);
      openThreadGitDiffPanel();
    },
    [openThreadGitDiffPanel],
  );

  useEffect(() => {
    if (!pendingGitDiffScrollPath || !isGitDiffPanelOpen) {
      return;
    }

    const targetEntry = parsedGitDiffFileEntries.find(({ fileDiff }) => (
      doesGitDiffFileMatchPath(fileDiff, pendingGitDiffScrollPath)
    ));
    if (!targetEntry) {
      if (!isGitDiffLoading && !isParsingGitDiffFiles) {
        setPendingGitDiffScrollPath(null);
      }
      return;
    }

    if (collapsedGitDiffFileKeys.has(targetEntry.key)) {
      setCollapsedGitDiffFileKeys((currentKeys) => {
        if (!currentKeys.has(targetEntry.key)) {
          return currentKeys;
        }
        const nextKeys = new Set(currentKeys);
        nextKeys.delete(targetEntry.key);
        return nextKeys;
      });
      scheduleGitDiffFileRender([targetEntry.key]);
    }

    const scrollTarget = gitDiffFileRefs.current.get(targetEntry.key);
    if (scrollTarget) {
      scrollTarget.scrollIntoView({ block: "start", behavior: "smooth" });
      setPendingGitDiffScrollPath(null);
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const deferredTarget = gitDiffFileRefs.current.get(targetEntry.key);
      if (deferredTarget) {
        deferredTarget.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      setPendingGitDiffScrollPath(null);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    collapsedGitDiffFileKeys,
    isGitDiffLoading,
    isParsingGitDiffFiles,
    isGitDiffPanelOpen,
    parsedGitDiffFileEntries,
    pendingGitDiffScrollPath,
    scheduleGitDiffFileRender,
  ]);

  const {
    containerRef,
    containerElement,
    setContainerRef,
    handleScroll: baseHandleScroll,
    scrollToBottom: baseScrollToBottom,
    isStickingToBottom,
  } = useAutoScroll(
    threadDetailRows,
    threadId,
  );
  const promptComposerRef = useRef<HTMLDivElement>(null);
  const promptComposerHeightRef = useRef<number | null>(null);
  const timelineScrollAnchorRef = useRef<TimelineScrollAnchor | null>(null);
  const timelineContainerWidthRef = useRef<number | null>(null);
  const { showScrollToBottom, handleScroll, scrollToBottom } =
    useScrollToBottomIndicator({
      containerRef,
      containerElement,
      onBaseScroll: baseHandleScroll,
      onBaseScrollToBottom: baseScrollToBottom,
      resetDep: threadId,
    });
  const syncTimelineScrollAnchor = useCallback(() => {
    const scrollContainer = containerElement;
    if (!scrollContainer) return;
    timelineScrollAnchorRef.current = isStickingToBottom
      ? null
      : captureTimelineScrollAnchor(scrollContainer);
    timelineContainerWidthRef.current = scrollContainer.clientWidth;
  }, [containerElement, isStickingToBottom]);
  const handleTimelineScroll = useCallback(() => {
    handleScroll();
    syncTimelineScrollAnchor();
  }, [handleScroll, syncTimelineScrollAnchor]);

  useEffect(() => {
    if (typeof window === "undefined") {
      syncTimelineScrollAnchor();
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      syncTimelineScrollAnchor();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [syncTimelineScrollAnchor, threadDetailRows, isSecondaryPanelOpen]);

  useLayoutEffect(() => {
    const scrollContainer = containerElement;
    if (!scrollContainer || typeof ResizeObserver === "undefined") {
      return;
    }

    timelineContainerWidthRef.current = scrollContainer.clientWidth;

    let frameId: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const nextWidth =
        entries[0]?.contentRect.width ?? scrollContainer.getBoundingClientRect().width;
      const previousWidth = timelineContainerWidthRef.current;
      timelineContainerWidthRef.current = nextWidth;

      if (previousWidth === null || Math.abs(nextWidth - previousWidth) < 0.5) {
        return;
      }

      const anchor = timelineScrollAnchorRef.current;
      if (!anchor) {
        return;
      }

      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        const targetRow = findTimelineRowElement(scrollContainer, anchor.rowId);
        if (!targetRow) {
          syncTimelineScrollAnchor();
          return;
        }

        const containerRect = scrollContainer.getBoundingClientRect();
        const targetRect = targetRow.getBoundingClientRect();
        const offsetDelta = targetRect.top - containerRect.top - anchor.offsetTop;
        if (Math.abs(offsetDelta) >= 0.5) {
          scrollContainer.scrollTop += offsetDelta;
        }
        syncTimelineScrollAnchor();
      });
    });

    observer.observe(scrollContainer);
    return () => {
      observer.disconnect();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [containerElement, syncTimelineScrollAnchor]);

  useLayoutEffect(() => {
    const scrollContainer = containerElement;
    const promptComposer = promptComposerRef.current;
    if (!scrollContainer || !promptComposer || typeof ResizeObserver === "undefined") {
      return;
    }

    promptComposerHeightRef.current = promptComposer.getBoundingClientRect().height;
    const observer = new ResizeObserver((entries) => {
      const nextHeight =
        entries[0]?.contentRect.height ?? promptComposer.getBoundingClientRect().height;
      const previousHeight = promptComposerHeightRef.current;
      promptComposerHeightRef.current = nextHeight;
      if (previousHeight === null) return;
      const heightDelta = nextHeight - previousHeight;
      if (Math.abs(heightDelta) < 0.5) return;
      if (isStickingToBottom) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        return;
      }
      const maxScrollOffset = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const distanceFromBottom = maxScrollOffset - scrollContainer.scrollTop;
      if (distanceFromBottom <= SCROLL_THRESHOLD) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        return;
      }
      scrollContainer.scrollTop += heightDelta;
    });

    observer.observe(promptComposer);
    return () => {
      observer.disconnect();
      promptComposerHeightRef.current = null;
    };
  }, [containerElement, isStickingToBottom, threadId]);

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
  const queuedMessages = extractThreadQueuedMessages(thread);
  const isQueueMutationPending =
    enqueueThreadMessage.isPending ||
    sendQueuedThreadMessage.isPending ||
    deleteQueuedThreadMessage.isPending;
  const isFollowUpSubmitting =
    tellThread.isPending ||
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
  const threadMergeBaseBranch =
    thread.mergeBaseBranchOverride ??
    resolvedThreadWorkStatus?.mergeBaseBranch ??
    resolvedThreadWorkStatus?.mergeBaseBranches?.[0] ??
    resolvedThreadWorkStatus?.defaultBranch;
  const showBranchComparisonUi = Boolean(
    threadMergeBaseBranch || resolvedThreadWorkStatus?.defaultBranch,
  );
  const threadEnvironmentType =
    threadEnvironmentLabel ??
    thread.environmentRecord?.kind ??
    undefined;
  const threadBranchName = resolvedThreadWorkStatus?.currentBranch;
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
  const showPromptGitStatsBanner = Boolean(
    resolvedThreadWorkStatus &&
    (
      showBranchComparisonUi
        ? (
            resolvedThreadWorkStatus.changedFiles > 0 ||
            resolvedThreadWorkStatus.aheadCount > 0 ||
            resolvedThreadWorkStatus.behindCount > 0
          )
        : resolvedThreadWorkStatus.workspaceChangedFiles > 0
    ),
  );
  const showThreadWorkspaceStatus =
    (Boolean(resolvedThreadWorkStatus) || Boolean(threadWorkStatusError)) &&
    !(thread.archivedAt !== undefined && environmentInfo?.capabilities.isolated_workspace !== true);
  const showThreadChangedFiles = Boolean(
    resolvedThreadWorkStatus &&
      (resolvedThreadWorkStatus.files?.length ?? 0) > 0,
  );
  const showThreadMetadataCard = Boolean(
    parentThreadId ||
      threadEnvironmentType ||
      thread.archivedAt !== undefined,
  );
  const showThreadGitStatusSection = Boolean(
    showThreadWorkspaceStatus ||
      threadBranchName ||
      showThreadChangedFiles,
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
  const handleMergeBaseBranchChange = useCallback((branch: string) => {
    const normalizedBranch = branch.trim();
    if (!normalizedBranch) {
      return;
    }

    const defaultBranch = resolvedThreadWorkStatus?.defaultBranch;
    const nextMergeBaseBranchOverride =
      defaultBranch && normalizedBranch === defaultBranch
        ? null
        : normalizedBranch;
    const currentMergeBaseBranchOverride = thread.mergeBaseBranchOverride ?? null;
    if (nextMergeBaseBranchOverride === currentMergeBaseBranchOverride) {
      return;
    }

    updateThread.mutate(
      {
        id: thread.id,
        mergeBaseBranchOverride: nextMergeBaseBranchOverride,
      },
      {
        onError: (error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to update merge base branch.",
          );
        },
      },
    );
  }, [resolvedThreadWorkStatus?.defaultBranch, thread.id, thread.mergeBaseBranchOverride, updateThread]);
  const handleMergeBaseBranchPickerOpenChange = useCallback((open: boolean) => {
    if (open) {
      setShouldLoadMergeBaseBranchOptions(true);
    }
    setIsMergeBaseBranchPickerOpen(open);
  }, []);
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
  const threadGitStatusDetailsProps: ComponentProps<typeof ThreadGitStatusDetails> = {
    statusLabel: threadGitStatusDisplay.label,
    statusSummary: threadGitStatusDisplay.summary,
    statusLabelClassName: threadGitStatusLabelClass,
    currentBranch: threadBranchName,
    defaultBranch: resolvedThreadWorkStatus?.defaultBranch,
    mergeBaseBranch: showBranchComparisonUi ? threadMergeBaseBranch : undefined,
    mergeBaseBranchOptions:
      mergeBaseBranchOptions ?? resolvedThreadWorkStatus?.mergeBaseBranches,
    mergeBaseBranchOptionsLoading: isLoadingMergeBaseBranchOptions,
    onMergeBaseBranchChange:
      showBranchComparisonUi ? handleMergeBaseBranchChange : undefined,
    onMergeBaseBranchPickerOpenChange:
      showBranchComparisonUi ? handleMergeBaseBranchPickerOpenChange : undefined,
    pending: updateThread.isPending,
    changedFiles: resolvedThreadWorkStatus?.files,
    threadId: thread.id,
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
    </DetailCard>
  );
  const renderThreadGitStatusSection = (className?: string) => (
    <ThreadGitStatusDetails
      {...threadGitStatusDetailsProps}
      branchContent={
        threadBranchName ? (
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
        ) : undefined
      }
      className={className}
    />
  );
  const renderThreadMetadataContent = (className?: string) => (
    <div className={cn("space-y-3", className)}>
      {showThreadMetadataCard ? (
        renderThreadMetadataCard("rounded-none border-0 bg-transparent px-0 py-0")
      ) : null}
      {showThreadGitStatusSection ? (
        renderThreadGitStatusSection("rounded-none border-0 bg-transparent")
      ) : null}
    </div>
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

    const submittedDraft = {
      text: promptDraft.text,
      attachments: promptDraft.attachments,
    };

    // Match project-start behavior: clear immediately, then restore only if the
    // request fails and the user has not started a new draft in the meantime.
    promptDraft.clear();
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
      promptDraft.restoreIfEmpty(submittedDraft);
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

  const conversationMain = (
    <>
      {isTransientThreadLoadError ? (
        <div className="mb-2 rounded-md border border-border/80 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Daemon temporarily unavailable. Showing cached thread state while reconnecting.
        </div>
      ) : null}
      <ConversationTimeline>
        {isThreadTimelinePending ? (
          <ConversationWorkingIndicator
            label="Loading thread..."
            className="mt-6"
          />
        ) : threadDetailRows.length === 0 ? (
          <ConversationEmptyState message="No events yet" />
        ) : (
          threadDetailRows.map((entry, entryIndex) => {
            const isLastRow = entryIndex === threadDetailRows.length - 1;
            const preferOngoingLabels =
              thread.status === "active" &&
              isLastRow &&
              shouldPreferOngoingLabelsForRow(entry, latestActivityRowId);
            return (
              <div
                key={`${threadId}:${entry.id}`}
                data-thread-row-id={entry.id}
                style={{
                  contentVisibility: "auto",
                  containIntrinsicSize: "160px",
                }}
              >
                {entry.kind === "tool-group" ? (
                  <ToolGroupEntry
                    projectId={projectId}
                    entry={entry}
                    messages={toolGroupMessagesById[entry.id] ?? entry.messages}
                    isLoadingMessages={loadingToolGroupIds.has(entry.id)}
                    onLoadMessages={() => handleLoadToolGroupMessages(entry)}
                    initialExpanded={isLastRow}
                    preferOngoingLabels={preferOngoingLabels}
                  />
                ) : (
                  <ConversationEntry
                    message={entry.message}
                    projectId={projectId}
                    initialExpanded={isLastRow}
                    preferOngoingLabels={preferOngoingLabels}
                  />
                )}
              </div>
            );
          })
        )}
      </ConversationTimeline>
      {thread.status === "active" &&
      !isThreadTimelinePending &&
      !isLastThreadRowShowingOngoingIndicator ? (
        <ConversationWorkingIndicator isThinking={isReasoningBlockActive} />
      ) : null}
    </>
  );

  const conversationShell = (
    <PageShell
      key={threadId ?? "thread-detail"}
      scrollRef={setContainerRef}
      onScroll={handleTimelineScroll}
      shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
      contentClassName="gap-2 pt-0"
      footerUsesPromptPadding
      footer={
        <ThreadFollowUpComposer
          composerRef={promptComposerRef}
          provisioningStatusLabel={provisioningStatusLabel}
          showScrollToBottom={showScrollToBottom}
          onScrollToBottom={scrollToBottom}
          showPromptGitStatsBanner={showPromptGitStatsBanner}
          isGitDiffPanelOpen={isGitDiffPanelOpen}
          threadId={thread.id}
          isChangeListExpanded={isChangeListExpanded}
          onToggleChangeListExpanded={() => {
            setIsChangeListExpanded((prev) => !prev);
          }}
          gitStatusDetailsProps={{
            ...threadGitStatusDetailsProps,
            branchContent: threadBranchName ? (
              <span className="block truncate" title={threadBranchName}>
                {threadBranchName}
              </span>
            ) : undefined,
            onFileClick: handlePromptBannerFileClick,
          }}
          onPromptGitStatsBannerClick={handlePromptGitStatsBannerClick}
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
      }
    >
      {conversationMain}
    </PageShell>
  );

  const selectedDiffCommitSha =
    threadGitDiff?.selection.type === "commit"
      ? threadGitDiff.selection.sha
      : null;
  const gitDiffSelectValue = selectedDiffCommitSha ?? "combined";
  const gitDiffSelectOptions: GitDiffSelectionOption[] =
    threadGitDiff?.mode === "worktree_commits"
      ? [
          { value: "combined", label: "All changes combined" },
          ...threadGitDiff.commits.map((commit) => ({
            value: commit.sha,
            label: `${commit.shortSha} · ${commit.subject}`,
          })),
        ]
      : [{
          value: "combined",
          label: "Uncommitted changes",
        }];
  const currentGitDiff = threadGitDiff?.diff ?? "";
  const hasCurrentGitDiff = currentGitDiff.trim().length > 0;
  const currentGitDiffKey = getGitDiffParseKey(currentGitDiff);
  const gitDiffStats = summarizeGitDiff(
    isParsingGitDiffFiles ? [] : parsedGitDiffFiles,
    currentGitDiff,
  );
  const gitDiffStatsLabel =
    gitDiffStats.files === 0 && gitDiffStats.additions === 0 && gitDiffStats.deletions === 0
      ? "No changes"
      : `${gitDiffStats.files} ${gitDiffStats.files === 1 ? "file" : "files"} · +${gitDiffStats.additions} -${gitDiffStats.deletions}`;
  const hasParsedGitDiffFiles = parsedGitDiffFileEntries.length > 0;
  const isAwaitingCurrentGitDiffParse =
    hasCurrentGitDiff && lastParsedGitDiffKey !== currentGitDiffKey;
  const isPreparingGitDiff =
    !hasParsedGitDiffFiles &&
    (isGitDiffLoading || isParsingGitDiffFiles || isAwaitingCurrentGitDiffParse);
  const areAllGitDiffFilesCollapsed =
    hasParsedGitDiffFiles &&
    parsedGitDiffFileEntries.every(({ key }) => collapsedGitDiffFileKeys.has(key));

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
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
              {timelineHeader}
              {conversationShell}
            </div>
          </Panel>
          <ThreadGitDiffPanel
            activePanel={activeSecondaryPanel}
            metadataContent={
              showThreadMetadataCard || showThreadGitStatusSection ? (
                renderThreadMetadataContent()
              ) : (
                <div className="pt-1 text-sm text-muted-foreground">
                  No thread details available.
                </div>
              )
            }
            onPanelChange={openThreadSecondaryPanel}
            threadId={thread.id}
            panelRef={gitDiffPanelRef}
            resizablePanelRef={gitDiffResizablePanelRef}
            isOpen={isSecondaryPanelOpen}
            isResizing={isGitDiffPanelResizing}
            onCollapse={closeThreadSecondaryPanel}
            onClose={closeThreadSecondaryPanel}
            onDragging={handleGitDiffPanelDragging}
            onResize={handleGitDiffPanelResize}
            gitDiffSelectValue={gitDiffSelectValue}
            gitDiffSelectOptions={gitDiffSelectOptions}
            onGitDiffSelectionChange={(value) => {
              setSelectedGitDiffCommitSha(value === "combined" ? null : value);
            }}
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
            queuedGitDiffFileRenderKeys={queuedGitDiffFileRenderKeysRef.current}
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
        defaultBranch={resolvedThreadWorkStatus?.defaultBranch}
        gitStatusLabel={threadGitStatusDisplay.label}
        gitStatusSummary={threadGitStatusDisplay.summary}
        changedFiles={resolvedThreadWorkStatus?.files}
        threadId={thread.id}
        showMergeBaseDetails={showBranchComparisonUi}
        mergeBaseBranch={threadMergeBaseBranch}
        mergeBaseBranchOptions={
          mergeBaseBranchOptions ?? resolvedThreadWorkStatus?.mergeBaseBranches
        }
        mergeBaseBranchOptionsLoading={isLoadingMergeBaseBranchOptions}
        onMergeBaseBranchChange={
          showBranchComparisonUi ? handleMergeBaseBranchChange : undefined
        }
        onMergeBaseBranchPickerOpenChange={
          showBranchComparisonUi ? handleMergeBaseBranchPickerOpenChange : undefined
        }
        onOpenChange={(open) => {
          if (!open) {
            setThreadGitActionTarget(null);
            setIsMergeBaseBranchPickerOpen(false);
          }
        }}
        onCommit={handleCommitThread}
        onSquashMerge={handleSquashMergeThread}
      />
    </>
  );
}
