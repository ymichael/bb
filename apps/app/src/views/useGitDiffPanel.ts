import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Location, NavigateFunction } from "react-router-dom";
import { useThreadGitDiff, useThreadMergeBaseBranches } from "../hooks/useApi";
import {
  getThreadSecondaryPanel,
  getStoredThreadSecondaryPanel,
  setStoredThreadSecondaryPanel,
  withThreadSecondaryPanel,
  type ThreadSecondaryPanel as ThreadSecondaryPanelTab,
} from "@/lib/thread-secondary-panel";
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
import { type GitDiffSelectionOption } from "./ThreadSecondaryPanel";
import { useResponsiveGitDiffPanelDisplay } from "./useResponsiveGitDiffPanelDisplay";

const GIT_DIFF_FILE_RENDER_SPINNER_MS = 150;
const GIT_DIFF_PARSE_BATCH_THRESHOLD = 24;
const GIT_DIFF_PARSE_INITIAL_BATCH_SIZE = 6;
const GIT_DIFF_PARSE_BATCH_SIZE = 18;
const GIT_DIFF_PARSE_BATCH_DELAY_MS = 24;
const GIT_DIFF_FILE_INITIAL_RENDER_COUNT = 4;
const GIT_DIFF_FILE_RENDER_BATCH_SIZE = 6;
const GIT_DIFF_FILE_INITIAL_DELAY_MS = 30;
const GIT_DIFF_FILE_RENDER_BATCH_DELAY_MS = 70;

interface UseGitDiffPanelParams {
  location: Location;
  navigate: NavigateFunction;
  onBeforePanelChange?: () => void;
  preferredTheme: string;
  threadId?: string;
}

export function useGitDiffPanel({
  location,
  navigate,
  onBeforePanelChange,
  preferredTheme,
  threadId,
}: UseGitDiffPanelParams) {
  const searchSecondaryPanel = useMemo(
    () => getThreadSecondaryPanel(location.search),
    [location.search],
  );
  const [persistedSecondaryPanel, setPersistedSecondaryPanel] =
    useState<ThreadSecondaryPanelTab | null>(() => getStoredThreadSecondaryPanel());
  const activeSecondaryPanel = searchSecondaryPanel ?? persistedSecondaryPanel;
  const isSecondaryPanelOpen = activeSecondaryPanel !== null;
  const isDiffPanelActive = activeSecondaryPanel === "git-diff";
  const [selectedMergeBaseBranch, setSelectedMergeBaseBranch] = useState<string | undefined>(
    undefined,
  );
  const [shouldLoadMergeBaseBranchOptions, setShouldLoadMergeBaseBranchOptions] =
    useState(false);
  const [isMergeBaseBranchPickerOpen, setIsMergeBaseBranchPickerOpen] = useState(false);
  const [selectedGitDiffCommitSha, setSelectedGitDiffCommitSha] = useState<string | null>(null);
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
  const gitDiffFileRenderTimersRef = useRef<Map<string, number>>(new Map());
  const queuedGitDiffFileRenderKeysRef = useRef<Set<string>>(new Set());
  const gitDiffFileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const {
    gitDiffDisplayMode,
    gitDiffViewOptions,
    handleGitDiffDisplayModeChange,
    handleSecondaryPanelDragging,
    handleSecondaryPanelResize,
    isSecondaryPanelResizing,
    secondaryPanelRef,
    secondaryResizablePanelRef,
  } = useResponsiveGitDiffPanelDisplay({
    isSecondaryPanelOpen,
    preferredTheme,
  });

  const gitDiffSelection = useMemo(
    () =>
      selectedGitDiffCommitSha
        ? { type: "commit" as const, sha: selectedGitDiffCommitSha }
        : { type: "combined" as const },
    [selectedGitDiffCommitSha],
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
  const {
    data: threadGitDiff,
    isLoading: isGitDiffLoading,
    error: gitDiffError,
  } = useThreadGitDiff(threadId ?? "", {
    enabled: Boolean(threadId) && isDiffPanelActive,
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

  useEffect(() => {
    if (searchSecondaryPanel === null) {
      return;
    }

    setPersistedSecondaryPanel((currentPanel) =>
      currentPanel === searchSecondaryPanel ? currentPanel : searchSecondaryPanel,
    );
    setStoredThreadSecondaryPanel(searchSecondaryPanel);
  }, [searchSecondaryPanel]);

  useEffect(() => {
    const gitDiff = threadGitDiff?.diff ?? "";
    const gitDiffKey = getGitDiffParseKey(gitDiff);
    if (!isDiffPanelActive || gitDiff.trim().length === 0) {
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
  }, [isDiffPanelActive, threadGitDiff?.diff]);

  useEffect(() => {
    setSelectedMergeBaseBranch(undefined);
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
    if (!isDiffPanelActive || parsedGitDiffFileEntries.length === 0) {
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
    isDiffPanelActive,
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
    (panel: ThreadSecondaryPanelTab | null) => {
      onBeforePanelChange?.();
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
    [location.pathname, location.search, navigate, onBeforePanelChange],
  );

  const openThreadSecondaryPanel = useCallback(
    (panel: ThreadSecondaryPanelTab) => {
      if (activeSecondaryPanel === panel) {
        return;
      }
      setThreadSecondaryPanel(panel);
    },
    [activeSecondaryPanel, setThreadSecondaryPanel],
  );

  const openThreadDiffPanel = useCallback(() => {
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

  const openDiffFile = useCallback(
    (path: string) => {
      setSelectedGitDiffCommitSha(null);
      setPendingGitDiffScrollPath(path);
      openThreadDiffPanel();
    },
    [openThreadDiffPanel],
  );

  useEffect(() => {
    if (!pendingGitDiffScrollPath || !isDiffPanelActive) {
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
    isDiffPanelActive,
    parsedGitDiffFileEntries,
    pendingGitDiffScrollPath,
    scheduleGitDiffFileRender,
  ]);

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

  return {
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
    isMergeBaseBranchPickerOpen,
    isParsingGitDiffFiles,
    isPreparingGitDiff,
    isSecondaryPanelOpen,
    isSecondaryPanelResizing,
    loadingGitDiffFileKeys,
    mergeBaseBranchOptions,
    onGitDiffSelectionChange: (value: string) => {
      setSelectedGitDiffCommitSha(value === "combined" ? null : value);
    },
    onMergeBaseBranchPickerOpenChange: (open: boolean) => {
      if (open) {
        setShouldLoadMergeBaseBranchOptions(true);
      }
      setIsMergeBaseBranchPickerOpen(open);
    },
    openDiffFile,
    openThreadDiffPanel,
    openThreadSecondaryPanel,
    parsedGitDiffFileEntries,
    queuedGitDiffFileRenderKeys: queuedGitDiffFileRenderKeysRef.current,
    secondaryPanelRef,
    secondaryResizablePanelRef,
    selectedMergeBaseBranch,
    setGitDiffFileRef,
    setSelectedMergeBaseBranch,
    threadGitDiff,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
    toggleThreadSecondaryPanel,
  };
}
