import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Location, NavigateFunction } from "react-router-dom";
import { useEnvironmentGitDiff, useEnvironmentMergeBaseBranches } from "../hooks/useApi";
import {
  getThreadSecondaryPanel,
  useStoredThreadSecondaryPanel,
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
import { useGitDiffFileRenderQueue } from "./useGitDiffFileRenderQueue";

const GIT_DIFF_PARSE_BATCH_THRESHOLD = 24;
const GIT_DIFF_PARSE_INITIAL_BATCH_SIZE = 6;
const GIT_DIFF_PARSE_BATCH_SIZE = 18;
const GIT_DIFF_PARSE_BATCH_DELAY_MS = 24;

interface UseGitDiffPanelParams {
  location: Location;
  navigate: NavigateFunction;
  onBeforePanelChange?: () => void;
  preferredTheme: string;
  environmentId?: string;
}

export function useGitDiffPanel({
  location,
  navigate,
  onBeforePanelChange,
  preferredTheme,
  environmentId,
}: UseGitDiffPanelParams) {
  const searchSecondaryPanel = useMemo(
    () => getThreadSecondaryPanel(location.search),
    [location.search],
  );
  const [persistedSecondaryPanel, setPersistedSecondaryPanel] =
    useStoredThreadSecondaryPanel();
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
  const [parsedGitDiffFiles, setParsedGitDiffFiles] = useState<ParsedGitDiffFile[]>([]);
  const [isParsingGitDiffFiles, setIsParsingGitDiffFiles] = useState(false);
  const [lastParsedGitDiffKey, setLastParsedGitDiffKey] = useState("");
  const [pendingGitDiffScrollPath, setPendingGitDiffScrollPath] = useState<string | null>(
    null,
  );
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
  } = useEnvironmentMergeBaseBranches(environmentId ?? "", {
    enabled:
      Boolean(environmentId) &&
      shouldLoadMergeBaseBranchOptions &&
      isMergeBaseBranchPickerOpen,
  });
  const {
    data: threadGitDiff,
    isLoading: isGitDiffLoading,
    error: gitDiffError,
  } = useEnvironmentGitDiff(environmentId ?? "", {
    enabled: Boolean(environmentId) && isDiffPanelActive,
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
  const {
    collapsedGitDiffFileKeys,
    expandGitDiffFile,
    gitDiffFileRefs,
    loadingGitDiffFileKeys,
    queuedGitDiffFileRenderKeys,
    setGitDiffFileRef,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
  } = useGitDiffFileRenderQueue({
    environmentId,
    gitDiff: threadGitDiff?.diff,
    parsedGitDiffFileEntries,
    isDiffPanelActive,
    isParsingGitDiffFiles,
  });

  useEffect(() => {
    if (searchSecondaryPanel === null) {
      return;
    }

    setPersistedSecondaryPanel((currentPanel) =>
      currentPanel === searchSecondaryPanel ? currentPanel : searchSecondaryPanel,
    );
  }, [searchSecondaryPanel, setPersistedSecondaryPanel]);

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
  }, [environmentId]);

  useEffect(() => {
    setSelectedGitDiffCommitSha(null);
  }, [environmentId]);

  useEffect(() => {
    setPendingGitDiffScrollPath(null);
  }, [environmentId]);

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

  const setThreadSecondaryPanel = useCallback(
    (panel: ThreadSecondaryPanelTab | null) => {
      onBeforePanelChange?.();
      setPersistedSecondaryPanel(panel);
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
      expandGitDiffFile(targetEntry.key);
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
    expandGitDiffFile,
    gitDiffFileRefs,
    isGitDiffLoading,
    isParsingGitDiffFiles,
    isDiffPanelActive,
    parsedGitDiffFileEntries,
    pendingGitDiffScrollPath,
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
  };
}
