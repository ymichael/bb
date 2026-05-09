import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import {
  useEnvironmentGitDiff,
  useEnvironmentWorkStatus,
} from "../../../hooks/queries/environment-queries";
import {
  gitDiffCollapsedFileKeysAtom,
  pendingGitDiffScrollPathAtom,
  selectedMergeBaseBranchAtom,
} from "../threadSecondaryPanelAtoms";
import {
  doesGitDiffFileMatchPath,
  getParsedGitDiffFileKey,
  parseGitDiffFiles,
  parseGitDiffPatchChunks,
  summarizeGitDiff,
  type ParsedGitDiffFile,
} from "./git-diff-parsing";
import { type GitDiffSelectionOption } from "../ThreadSecondaryPanel";
import {
  buildGitDiffParsePlan,
  buildGitDiffSelectionOptions,
  buildGitDiffTarget,
  GIT_DIFF_PARSE_BATCH_DELAY_MS,
  GIT_DIFF_PARSE_BATCH_SIZE,
  GIT_DIFF_PARSE_INITIAL_BATCH_SIZE,
  resolveGitDiffPreparationState,
  shouldResetSelectedGitDiffCommit,
} from "./gitDiffPanelHelpers";
import { useGitDiffFileRenderQueue } from "./useGitDiffFileRenderQueue";

interface UseGitDiffPanelStateParams {
  environmentId?: string;
  isDiffPanelActive: boolean;
  defaultMergeBaseBranch?: string;
}

export function useGitDiffPanelState({
  environmentId,
  isDiffPanelActive,
  defaultMergeBaseBranch,
}: UseGitDiffPanelStateParams) {
  const getCollapsedFileKeys = useAtomCallback(
    useCallback((get) => get(gitDiffCollapsedFileKeysAtom), []),
  );
  const selectedMergeBaseBranch = useAtomValue(selectedMergeBaseBranchAtom);
  const pendingGitDiffScrollPath = useAtomValue(pendingGitDiffScrollPathAtom);
  const setPendingGitDiffScrollPath = useSetAtom(pendingGitDiffScrollPathAtom);
  const [selectedGitDiffCommitSha, setSelectedGitDiffCommitSha] = useState<
    string | null
  >(null);
  const [parsedGitDiffFiles, setParsedGitDiffFiles] = useState<
    ParsedGitDiffFile[]
  >([]);
  const [isParsingGitDiffFiles, setIsParsingGitDiffFiles] = useState(false);
  const [lastParsedGitDiffKey, setLastParsedGitDiffKey] = useState("");

  const effectiveMergeBaseBranch =
    selectedMergeBaseBranch ?? defaultMergeBaseBranch;
  const gitDiffTarget = useMemo(
    () =>
      buildGitDiffTarget(selectedGitDiffCommitSha, effectiveMergeBaseBranch),
    [effectiveMergeBaseBranch, selectedGitDiffCommitSha],
  );
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
    enabled:
      Boolean(environmentId) &&
      isDiffPanelActive &&
      gitDiffTarget !== undefined,
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
    expandGitDiffFile,
    gitDiffFileRefs,
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

  // --- Parsing pipeline ---

  useEffect(() => {
    const gitDiff = threadGitDiff?.diff ?? "";
    const parsePlan = buildGitDiffParsePlan({ gitDiff, isDiffPanelActive });

    if (parsePlan.kind === "reset") {
      setParsedGitDiffFiles([]);
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey("");
      return;
    }

    setParsedGitDiffFiles([]);
    if (parsePlan.kind === "empty") {
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
      if (cancelled) return;

      const batchSize =
        nextPatchIndex === 0
          ? GIT_DIFF_PARSE_INITIAL_BATCH_SIZE
          : GIT_DIFF_PARSE_BATCH_SIZE;
      const batchChunks = patchChunks.slice(
        nextPatchIndex,
        nextPatchIndex + batchSize,
      );
      if (batchChunks.length === 0) {
        setIsParsingGitDiffFiles(false);
        setLastParsedGitDiffKey(parsePlan.gitDiffKey);
        return;
      }

      const parsedBatchFiles = parseGitDiffPatchChunks(batchChunks);
      if (cancelled) return;

      nextPatchIndex += batchChunks.length;
      setParsedGitDiffFiles((currentFiles) =>
        appliedFirstBatch
          ? [...currentFiles, ...parsedBatchFiles]
          : parsedBatchFiles,
      );
      appliedFirstBatch = true;

      if (nextPatchIndex >= patchChunks.length || cancelled) {
        setIsParsingGitDiffFiles(false);
        setLastParsedGitDiffKey(parsePlan.gitDiffKey);
        return;
      }

      timerId = window.setTimeout(
        parseNextBatch,
        GIT_DIFF_PARSE_BATCH_DELAY_MS,
      );
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

  // --- Reset on environment change ---

  useEffect(() => {
    setSelectedGitDiffCommitSha(null);
  }, [environmentId]);

  useEffect(() => {
    setPendingGitDiffScrollPath(null);
  }, [environmentId, setPendingGitDiffScrollPath]);

  // --- Reset selected commit when pendingGitDiffScrollPath arrives (from openDiffFile) ---

  useEffect(() => {
    if (pendingGitDiffScrollPath) {
      setSelectedGitDiffCommitSha(null);
    }
  }, [pendingGitDiffScrollPath]);

  const hasUncommittedChanges =
    (gitDiffWorkspaceStatus?.workingTree.files.length ?? 0) > 0;

  useEffect(() => {
    if (
      shouldResetSelectedGitDiffCommit(
        selectedGitDiffCommitSha,
        gitDiffWorkspaceStatus?.mergeBase?.commits ?? [],
        { hasUncommittedChanges },
      )
    ) {
      setSelectedGitDiffCommitSha(null);
    }
  }, [
    gitDiffWorkspaceStatus?.mergeBase?.commits,
    hasUncommittedChanges,
    selectedGitDiffCommitSha,
  ]);

  // --- Scroll-to-file effect ---

  useEffect(() => {
    if (!pendingGitDiffScrollPath || !isDiffPanelActive) {
      return;
    }

    const targetEntry = parsedGitDiffFileEntries.find(({ fileDiff }) =>
      doesGitDiffFileMatchPath(fileDiff, pendingGitDiffScrollPath),
    );
    if (!targetEntry) {
      if (!isGitDiffLoading && !isParsingGitDiffFiles) {
        setPendingGitDiffScrollPath(null);
      }
      return;
    }

    if (getCollapsedFileKeys().has(targetEntry.key)) {
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
    expandGitDiffFile,
    gitDiffFileRefs,
    isGitDiffLoading,
    isParsingGitDiffFiles,
    isDiffPanelActive,
    parsedGitDiffFileEntries,
    pendingGitDiffScrollPath,
    setPendingGitDiffScrollPath,
    getCollapsedFileKeys,
  ]);

  // --- Derived values ---

  const diffCommits = gitDiffWorkspaceStatus?.mergeBase?.commits ?? [];
  const gitDiffSelectValue = selectedGitDiffCommitSha ?? "all";
  const gitDiffSelectOptions: GitDiffSelectionOption[] =
    buildGitDiffSelectionOptions(diffCommits, { hasUncommittedChanges });
  const currentGitDiff = threadGitDiff?.diff ?? "";
  const gitDiffStats = summarizeGitDiff(
    isParsingGitDiffFiles ? [] : parsedGitDiffFiles,
    currentGitDiff,
  );
  const { hasParsedGitDiffFiles, isPreparingGitDiff } =
    resolveGitDiffPreparationState({
      currentGitDiff,
      isGitDiffLoading,
      isParsingGitDiffFiles,
      lastParsedGitDiffKey,
      parsedGitDiffFileCount: parsedGitDiffFileEntries.length,
    });

  const onGitDiffSelectionChange = useCallback((value: string) => {
    setSelectedGitDiffCommitSha(value === "all" ? null : value);
  }, []);

  return {
    currentGitDiff,
    gitDiffError,
    gitDiffSelectOptions,
    gitDiffSelectValue,
    gitDiffStats,
    hasParsedGitDiffFiles,
    isGitDiffLoading,
    isParsingGitDiffFiles,
    isPreparingGitDiff,
    onGitDiffSelectionChange,
    parsedGitDiffFileEntries,
    queuedGitDiffFileRenderKeys,
    setGitDiffFileRef,
    threadGitDiff,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
  };
}
