import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Location, NavigateFunction } from "react-router-dom";
import {
  useEnvironmentGitDiff,
  useEnvironmentMergeBaseBranches,
  useEnvironmentWorkStatus,
} from "../hooks/queries/environment-queries";
import {
  getThreadSecondaryPanel,
  useStoredThreadSecondaryPanel,
  withThreadSecondaryPanel,
  type ThreadSecondaryPanel as ThreadSecondaryPanelTab,
} from "@/lib/thread-secondary-panel";
import {
  doesGitDiffFileMatchPath,
  getParsedGitDiffFileKey,
  parseGitDiffFiles,
  parseGitDiffPatchChunks,
  summarizeGitDiff,
  type ParsedGitDiffFile,
} from "./threadDetailGitDiff";
import { type GitDiffSelectionOption } from "./ThreadSecondaryPanel";
import {
  buildGitDiffParsePlan,
  buildGitDiffSelectionOptions,
  buildGitDiffStatsLabel,
  buildGitDiffTarget,
  GIT_DIFF_PARSE_BATCH_DELAY_MS,
  GIT_DIFF_PARSE_BATCH_SIZE,
  GIT_DIFF_PARSE_INITIAL_BATCH_SIZE,
  resolveGitDiffPreparationState,
  shouldResetSelectedGitDiffCommit,
} from "./gitDiffPanelHelpers";
import { useResponsiveGitDiffPanelDisplay } from "./useResponsiveGitDiffPanelDisplay";
import { useGitDiffFileRenderQueue } from "./useGitDiffFileRenderQueue";

interface UseGitDiffPanelParams {
  location: Location;
  navigate: NavigateFunction;
  onBeforePanelChange?: () => void;
  preferredTheme: string;
  defaultMergeBaseBranch?: string;
  environmentId?: string;
}

export function useGitDiffPanel({
  location,
  navigate,
  onBeforePanelChange,
  preferredTheme,
  defaultMergeBaseBranch,
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

  const effectiveMergeBaseBranch = selectedMergeBaseBranch ?? defaultMergeBaseBranch;
  const gitDiffTarget = useMemo(
    () => buildGitDiffTarget(selectedGitDiffCommitSha, effectiveMergeBaseBranch),
    [effectiveMergeBaseBranch, selectedGitDiffCommitSha],
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
  const { data: gitDiffWorkspaceStatus } = useEnvironmentWorkStatus(
    environmentId ?? "",
    effectiveMergeBaseBranch,
    {
      enabled:
        Boolean(environmentId) &&
        Boolean(effectiveMergeBaseBranch) &&
        isDiffPanelActive,
    },
  );
  const {
    data: threadGitDiff,
    isLoading: isGitDiffLoading,
    error: gitDiffError,
  } = useEnvironmentGitDiff(environmentId ?? "", {
    enabled: Boolean(environmentId) && isDiffPanelActive && gitDiffTarget !== undefined,
    target: gitDiffTarget,
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
    const parsePlan = buildGitDiffParsePlan({
      gitDiff,
      isDiffPanelActive,
    });

    if (parsePlan.kind === "reset") {
      setParsedGitDiffFiles([]);
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey("");
      return;
    }

    setParsedGitDiffFiles([]);
    if (parsePlan.kind === "empty") {
      setParsedGitDiffFiles([]);
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey(parsePlan.gitDiffKey);
      return;
    }

    if (parsePlan.kind === "immediate") {
      setParsedGitDiffFiles(parseGitDiffFiles(gitDiff));
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey(parsePlan.gitDiffKey);
      return;
    }

    const patchChunks = parsePlan.patchChunks;
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
        setLastParsedGitDiffKey(parsePlan.gitDiffKey);
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
        setLastParsedGitDiffKey(parsePlan.gitDiffKey);
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
    if (
      shouldResetSelectedGitDiffCommit(
        selectedGitDiffCommitSha,
        gitDiffWorkspaceStatus?.mergeBase?.commits ?? [],
      )
    ) {
      setSelectedGitDiffCommitSha(null);
    }
  }, [gitDiffWorkspaceStatus?.mergeBase?.commits, selectedGitDiffCommitSha]);

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

  const diffCommits = gitDiffWorkspaceStatus?.mergeBase?.commits ?? [];
  const gitDiffSelectValue = selectedGitDiffCommitSha ?? "all";
  const gitDiffSelectOptions: GitDiffSelectionOption[] = buildGitDiffSelectionOptions(
    diffCommits,
  );
  const currentGitDiff = threadGitDiff?.diff ?? "";
  const gitDiffStats = summarizeGitDiff(
    isParsingGitDiffFiles ? [] : parsedGitDiffFiles,
    currentGitDiff,
  );
  const gitDiffStatsLabel = buildGitDiffStatsLabel(gitDiffStats);
  const {
    hasParsedGitDiffFiles,
    isPreparingGitDiff,
  } = resolveGitDiffPreparationState({
    currentGitDiff,
    isGitDiffLoading,
    isParsingGitDiffFiles,
    lastParsedGitDiffKey,
    parsedGitDiffFileCount: parsedGitDiffFileEntries.length,
  });
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
      setSelectedGitDiffCommitSha(value === "all" ? null : value);
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
