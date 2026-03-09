import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Panel, PanelGroup } from "react-resizable-panels";
import {
  useThread,
  useThreadWorkStatus,
  useThreadTimeline,
  useThreadGitDiff,
  useThreadToolGroupMessages,
  useTellThread,
  useEnqueueThreadMessage,
  useSendQueuedThreadMessage,
  useDeleteQueuedThreadMessage,
  useRequestThreadOperation,
  usePromoteThread,
  useDemotePrimaryCheckout,
  useStopThread,
  useMarkThreadRead,
  useSystemEnvironments,
  useUnarchiveThread,
  useThreadDefaultExecutionOptions,
  useUploadPromptAttachment,
} from "../hooks/useApi";
import {
  ConversationEntry,
} from "@/components/messages/ConversationEntry";
import {
  getCollapsibleHeaderToneClass,
} from "@/components/messages/CollapsibleHeader";
import { ConversationWorkingIndicator } from "@/components/messages/ConversationWorkingIndicator";
import { Button } from "@/components/ui/button";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useScrollToBottomIndicator } from "@/hooks/useScrollToBottomIndicator";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { usePreferredTheme } from "@/hooks/useTheme";
import { PageShell } from "@/components/layout/PageShell";
import { DetailCard, DetailRow } from "@/components/shared/DetailCard";
import {
  DEFAULT_SCROLL_STICK_THRESHOLD_PX,
  ConversationEmptyState,
  ConversationTimeline,
  ExpandablePanel,
} from "@beanbag/ui-core";
import {
  formatEnvironmentDisplayName,
  type PromptInput,
  type ServiceTier,
  type UIMessage,
} from "@beanbag/agent-core";
import { type ThreadDetailToolGroupRow } from "./threadDetailRows";
import {
  findLatestActivityMessageId,
  findLatestActivityRowId,
  shouldHighlightLatestActivity,
} from "./threadDetailActivity";
import {
  createLatestInitialExpandedState,
  reduceLatestInitialExpandedState,
} from "@/lib/latestInitialExpanded";
import {
  promptDraftToInput,
} from "@/lib/prompt-draft";
import { HttpError } from "@/lib/api";
import { getAutoArchivePreferences } from "@/lib/auto-archive-preferences";
import { StatusPillCommitPopover } from "@/components/shared/StatusPillCommitPopover";
import { StatusPill, type StatusPillVariant } from "@/components/shared/StatusPill";
import { ArchiveTimestampAction } from "@/components/shared/ArchiveTimestampAction";
import {
  threadWorktreeCleanLabel,
  threadWorkStatusLabel,
  threadWorkStatusVariant,
} from "@/lib/thread-work-status";
import {
  formatChangeSummary,
  formatWorkspaceChangeSummary,
} from "@/lib/workspace-change-summary";
import {
  isThreadGitDiffPanelOpen,
  withThreadGitDiffPanelOpen,
} from "@/lib/thread-git-diff-panel";
import { supportsPrimaryCheckoutMetadata } from "@/lib/thread-primary-checkout";
import { ThreadFollowUpComposer } from "./ThreadFollowUpComposer";
import {
  type GitDiffSelectionOption,
  ThreadGitDiffPanel,
} from "./ThreadGitDiffPanel";
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

const SCROLL_THRESHOLD = 40;
const TIMELINE_PANEL_DEFAULT_SIZE_PERCENT = 50;
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

function useLatestInitialExpanded(initialExpanded: boolean): {
  isExpanded: boolean;
  onToggle: () => void;
} {
  const [state, dispatch] = useReducer(
    reduceLatestInitialExpandedState,
    initialExpanded,
    createLatestInitialExpandedState,
  );

  useEffect(() => {
    dispatch({ type: "sync", initialExpanded });
  }, [initialExpanded]);

  const onToggle = () => {
    dispatch({ type: "toggle" });
  };

  return { isExpanded: state.isExpanded, onToggle };
}

function ToolGroupEntry({
  projectId,
  entry,
  messages,
  isLoadingMessages,
  onLoadMessages,
  isLatestActivity,
}: {
  projectId?: string;
  entry: ThreadDetailToolGroupRow;
  messages: ThreadDetailToolGroupRow["messages"];
  isLoadingMessages: boolean;
  onLoadMessages: () => void;
  isLatestActivity: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(isLatestActivity);
  const latestActivityMessageId = useMemo(
    () => findLatestActivityMessageId(messages),
    [messages],
  );
  const count = entry.summaryCount;
  const summaryContent = `${count} tools and changes`;
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);
  const handleToggle = () => {
    if (!isExpanded) {
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
            {messages.map((message) => {
              const isLatestMessage =
                isLatestActivity &&
                message.id === latestActivityMessageId;
              return (
                <ConversationEntry
                  key={message.id}
                  message={message}
                  projectId={projectId}
                  initialExpanded={isLatestMessage}
                  preferOngoingLabels={isLatestMessage}
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
  const isGitDiffPanelOpen = useMemo(
    () => isThreadGitDiffPanelOpen(location.search),
    [location.search],
  );
  const [selectedMergeBaseBranch, setSelectedMergeBaseBranch] = useState<string | undefined>(
    undefined,
  );
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
    selectedMergeBaseBranch,
  );
  const resolvedThreadWorkStatus =
    threadWorkStatusError ? undefined : (threadWorkStatus ?? undefined);
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const { data: timeline, isLoading: timelineLoading } = useThreadTimeline(
    threadId ?? "",
    { refetchOnMount: "always" },
  );
  const threadToolGroupMessages = useThreadToolGroupMessages();
  const { data: defaultExecutionOptions } = useThreadDefaultExecutionOptions(
    threadId ?? "",
  );
  const tellThread = useTellThread();
  const enqueueThreadMessage = useEnqueueThreadMessage();
  const sendQueuedThreadMessage = useSendQueuedThreadMessage();
  const deleteQueuedThreadMessage = useDeleteQueuedThreadMessage();
  const requestThreadCommitOperation = useRequestThreadOperation();
  const requestThreadSquashOperation = useRequestThreadOperation();
  const promoteThread = usePromoteThread();
  const demotePrimaryCheckout = useDemotePrimaryCheckout();
  const stopThread = useStopThread();
  const unarchiveThread = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
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

  const threadDetailRows = useMemo(() => timeline?.rows ?? [], [timeline?.rows]);
  const contextWindowUsage = timeline?.contextWindowUsage ?? undefined;
  const latestActivityRowId = useMemo(
    () => findLatestActivityRowId(threadDetailRows),
    [threadDetailRows],
  );
  const shouldHighlightLatest = useMemo(
    () => shouldHighlightLatestActivity(threadDetailRows, latestActivityRowId),
    [latestActivityRowId, threadDetailRows],
  );

  const isReasoningBlockActive = false;
  const isTimelineLoading = timelineLoading;
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
    mergeBaseBranch: selectedMergeBaseBranch,
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
    if (!isGitDiffPanelOpen) {
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
  }, [isGitDiffPanelOpen]);

  useEffect(() => {
    if (!isGitDiffPanelOpen) {
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
    isGitDiffPanelOpen,
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
    setSelectedMergeBaseBranch(undefined);
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
    if (!resolvedThreadWorkStatus) return;
    const mergeBaseBranches = resolvedThreadWorkStatus.mergeBaseBranches ?? [];
    const fallbackBranch =
      resolvedThreadWorkStatus.mergeBaseBranch ?? mergeBaseBranches[0];
    if (!fallbackBranch) return;
    if (
      selectedMergeBaseBranch &&
      (
        selectedMergeBaseBranch === resolvedThreadWorkStatus.mergeBaseBranch ||
        mergeBaseBranches.includes(selectedMergeBaseBranch)
      )
    ) {
      return;
    }
    setSelectedMergeBaseBranch(fallbackBranch);
  }, [selectedMergeBaseBranch, resolvedThreadWorkStatus]);

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
  const openThreadGitDiffPanel = useCallback(() => {
    if (isGitDiffPanelOpen) {
      return;
    }
    const nextSearch = withThreadGitDiffPanelOpen(location.search, true);
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch.length > 0 ? `?${nextSearch}` : "",
      },
      { replace: true },
    );
  }, [isGitDiffPanelOpen, location.pathname, location.search, navigate]);
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
    timelineScrollAnchorRef.current = captureTimelineScrollAnchor(scrollContainer);
    timelineContainerWidthRef.current = scrollContainer.clientWidth;
  }, [containerElement]);
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
  }, [syncTimelineScrollAnchor, threadDetailRows, isGitDiffPanelOpen]);

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
  }, [containerElement, threadId]);

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
  const primaryCheckoutStatusLabel = isPrimaryCheckoutActive ? "Active" : "Not active";
  const primaryCheckoutStatusVariant: StatusPillVariant = isPrimaryCheckoutActive
    ? "emphasis"
    : "outline";
  const isPrimaryCheckoutMutationPending = promoteThread.isPending || demotePrimaryCheckout.isPending;
  const primaryCheckoutActionLabel = isPrimaryCheckoutActive
    ? demotePrimaryCheckout.isPending
      ? "Demoting..."
      : "Demote"
    : promoteThread.isPending
    ? "Promoting..."
    : "Promote";
  const isArchivedThread = thread.archivedAt !== undefined;
  const showPrimaryCheckoutMetadata = supportsPrimaryCheckout && !isArchivedThread;
  const showWorkspaceStatus =
    (Boolean(resolvedThreadWorkStatus) || Boolean(threadWorkStatusError)) &&
    !(thread.archivedAt !== undefined && environmentInfo?.capabilities.isolated_workspace !== true);
  const showThreadMetadata = Boolean(
    parentThreadId ||
      thread.archivedAt !== undefined ||
      thread.environmentId ||
      showPrimaryCheckoutMetadata ||
      showWorkspaceStatus,
  );
  const provisioningStatusLabel =
    isCreated
      ? "Created..."
      : isProvisioning
      ? "Provisioning..."
      : undefined;
  const showBranchComparisonUi = Boolean(
    resolvedThreadWorkStatus?.mergeBaseBranch ||
      resolvedThreadWorkStatus?.defaultBranch ||
      (resolvedThreadWorkStatus?.mergeBaseBranches?.length ?? 0) > 0,
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
  const promptBannerMergeBaseBranch =
    selectedMergeBaseBranch ??
    resolvedThreadWorkStatus?.mergeBaseBranch ??
    resolvedThreadWorkStatus?.defaultBranch;

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

    try {
      await sendFollowUpInput({
        input: promptInput,
        model: activeModel?.model ?? selectedModel,
        ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
        ...(supportsReasoningLevels ? { reasoningLevel } : {}),
        sandboxMode,
      });
      promptDraft.clear();
      setAttachmentError(null);
    } catch (err) {
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

  const conversationMain = (
    <>
      {isTransientThreadLoadError ? (
        <div className="mb-2 rounded-md border border-border/80 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Daemon temporarily unavailable. Showing cached thread state while reconnecting.
        </div>
      ) : null}
      {showThreadMetadata ? (
        <section className="sticky top-0 z-10 shrink-0 bg-background pt-2">
          <DetailCard>
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
            {thread.environmentId ? (
              <DetailRow
                label="Environment"
                valueClassName="min-w-0 truncate"
              >
                <span>
                  {formatEnvironmentDisplayName({
                    id: thread.environmentId,
                    displayName: environmentInfo?.displayName,
                  }) ?? thread.environmentId}
                </span>
              </DetailRow>
            ) : null}
            {showPrimaryCheckoutMetadata ? (
              <DetailRow
                label="Primary checkout"
                valueClassName="min-w-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StatusPill
                    variant={primaryCheckoutStatusVariant}
                  >
                    {primaryCheckoutStatusLabel}
                  </StatusPill>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto px-0 py-0 ui-text-xs underline"
                    disabled={
                      thread.archivedAt !== undefined ||
                      isPrimaryCheckoutMutationPending ||
                      (isPrimaryCheckoutActive
                        ? demoteAction?.available === false
                        : promoteAction?.available === false)
                    }
                    onClick={() => {
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
                    }}
                  >
                    {primaryCheckoutActionLabel}
                  </Button>
                </div>
              </DetailRow>
            ) : null}
            {showWorkspaceStatus ? (
              <DetailRow
                label="Workspace status"
                valueClassName="min-w-0"
              >
                <StatusPillCommitPopover
                  threadId={thread.id}
                  status={resolvedThreadWorkStatus}
                  label={threadWorkStatusLabel(resolvedThreadWorkStatus, {
                    cleanLabel:
                      showBranchComparisonUi
                        ? threadWorktreeCleanLabel(resolvedThreadWorkStatus)
                        : undefined,
                  })}
                  variant={threadWorkStatusVariant(resolvedThreadWorkStatus, {
                    isArchivedThread: thread.archivedAt !== undefined,
                  })}
                  cleanTitle={
                    showBranchComparisonUi
                      ? threadWorktreeCleanLabel(resolvedThreadWorkStatus)
                      : undefined
                  }
                  showMergeBaseDetails={showBranchComparisonUi}
                  mergeBaseBranch={
                    selectedMergeBaseBranch ?? resolvedThreadWorkStatus?.mergeBaseBranch
                  }
                  mergeBaseBranchOptions={resolvedThreadWorkStatus?.mergeBaseBranches}
                  onMergeBaseBranchChange={
                    showBranchComparisonUi
                      ? setSelectedMergeBaseBranch
                      : undefined
                  }
                  canCommit={Boolean(resolvedThreadWorkStatus?.hasUncommittedChanges)}
                  canSquashMerge={
                    squashMergeAction?.available === true &&
                    (
                      Boolean(resolvedThreadWorkStatus?.hasCommittedUnmergedChanges) ||
                      Boolean(resolvedThreadWorkStatus?.hasUncommittedChanges)
                    )
                  }
                  isCommitting={requestThreadCommitOperation.isPending}
                  isSquashMerging={requestThreadSquashOperation.isPending}
                  onCommit={async ({ includeUnstaged, message }) => {
                    if (!threadId) return;
                    const autoArchiveOnSuccess = getAutoArchivePreferences().autoArchiveThreadOnCommit;
                    await requestThreadCommitOperation.mutateAsync({
                      id: threadId,
                      operation: "commit",
                      options: {
                        includeUnstaged,
                        ...(message ? { message } : {}),
                        autoArchiveOnSuccess,
                      },
                    });
                  }}
                  onSquashMerge={async ({
                    commitIfNeeded,
                    includeUnstaged,
                    commitMessage,
                    mergeBaseBranch,
                  }) => {
                    if (!threadId) return;
                    const autoArchiveOnSuccess = getAutoArchivePreferences().autoArchiveThreadOnCommit;
                    await requestThreadSquashOperation.mutateAsync({
                      id: threadId,
                      operation: "squash_merge",
                      options: {
                        commitIfNeeded,
                        includeUnstaged,
                        ...(commitMessage ? { commitMessage } : {}),
                        ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
                        autoArchiveOnSuccess,
                      },
                    });
                  }}
                />
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
          </DetailCard>
        </section>
      ) : null}
      <ConversationTimeline>
        {isTimelineLoading && threadDetailRows.length === 0 ? (
          <ConversationEmptyState
            message="Loading thread..."
            spacing="compact"
            alignment="left"
            className="w-full rounded-md px-2"
          />
        ) : threadDetailRows.length === 0 ? (
          <ConversationEmptyState message="No events yet" />
        ) : (
          threadDetailRows.map((entry) => {
            const isLatestActivity =
              shouldHighlightLatest && entry.id === latestActivityRowId;
            return (
              <div key={`${threadId}:${entry.id}`} data-thread-row-id={entry.id}>
                {entry.kind === "tool-group" ? (
                  <ToolGroupEntry
                    projectId={projectId}
                    entry={entry}
                    messages={toolGroupMessagesById[entry.id] ?? entry.messages}
                    isLoadingMessages={loadingToolGroupIds.has(entry.id)}
                    onLoadMessages={() => handleLoadToolGroupMessages(entry)}
                    isLatestActivity={isLatestActivity}
                  />
                ) : (
                  <ConversationEntry
                    message={entry.message}
                    projectId={projectId}
                    initialExpanded={isLatestActivity}
                    preferOngoingLabels={isLatestActivity}
                  />
                )}
              </div>
            );
          })
        )}
      </ConversationTimeline>
      {thread.status === "active" ? (
        <ConversationWorkingIndicator isThinking={isReasoningBlockActive} />
      ) : null}
    </>
  );

  const conversationShell = (
    <PageShell
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
          canExpandPromptChangeList={canExpandPromptChangeList}
          isChangeListExpanded={isChangeListExpanded}
          onToggleChangeListExpanded={() => {
            setIsChangeListExpanded((prev) => !prev);
          }}
          promptBannerSummary={promptBannerSummary}
          showBranchComparisonUi={showBranchComparisonUi}
          promptBannerMergeBaseBranch={promptBannerMergeBaseBranch}
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
    <div className="-mx-4 -mb-4 -mt-4 flex h-full min-h-0 min-w-0 flex-1 overflow-hidden md:-mx-5 md:-mb-5 md:-mt-5">
      <PanelGroup direction="horizontal" className="h-full w-full min-w-0">
        <Panel
          defaultSize={TIMELINE_PANEL_DEFAULT_SIZE_PERCENT}
          minSize={30}
          className="min-w-0 overflow-hidden"
        >
          {conversationShell}
        </Panel>
        {isGitDiffPanelOpen ? (
          <ThreadGitDiffPanel
            threadId={thread.id}
            panelRef={gitDiffPanelRef}
            isResizing={isGitDiffPanelResizing}
            onDragging={handleGitDiffPanelDragging}
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
        ) : null}
      </PanelGroup>
    </div>
  );
}
