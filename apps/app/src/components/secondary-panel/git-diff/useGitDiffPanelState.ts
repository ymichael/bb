import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { useQueryClient } from "@tanstack/react-query";
import type { FileContents } from "@pierre/diffs";
import type { WorkspaceDiffTarget } from "@bb/domain";
import {
  useEnvironmentGitDiff,
  useEnvironmentWorkStatus,
} from "../../../hooks/queries/environment-queries";
import { environmentDiffFileQueryKey } from "../../../hooks/queries/query-keys";
import { getEnvironmentDiffFile, type DiffFileTarget } from "../../../lib/api";
import type { RequestDiffFileContents } from "../../git-diff/GitDiffCard";
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
} from "../../git-diff/git-diff-parsing";
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

  const queryClient = useQueryClient();
  const diffMergeBaseRef = threadGitDiff?.mergeBaseRef ?? null;
  const fileTarget = useMemo<DiffFileTarget | undefined>(
    () => buildDiffFileTarget(gitDiffTarget, diffMergeBaseRef),
    [gitDiffTarget, diffMergeBaseRef],
  );
  const onRequestFileContents = useMemo<RequestDiffFileContents | undefined>(
    () => {
      if (!environmentId || fileTarget === undefined) return undefined;
      const envId = environmentId;
      const target = fileTarget;
      const targetKey = fileTargetKey(target);
      return async (path, side) => {
        const result = await queryClient.fetchQuery({
          queryKey: environmentDiffFileQueryKey(
            envId,
            target.type,
            targetKey,
            path,
            side,
          ),
          queryFn: () => getEnvironmentDiffFile(envId, target, path, side),
          staleTime: 5_000,
        });
        return toFileContents(
          path,
          result.content,
          result.contentEncoding,
        );
      };
    },
    [environmentId, fileTarget, queryClient],
  );

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
    onRequestFileContents,
    parsedGitDiffFileEntries,
    queuedGitDiffFileRenderKeys,
    setGitDiffFileRef,
    threadGitDiff,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
  };
}

function fileTargetKey(target: DiffFileTarget): string | null {
  switch (target.type) {
    case "uncommitted":
      return null;
    case "branch_committed":
    case "all":
      return target.mergeBaseRef;
    case "commit":
      return target.sha;
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

/**
 * Lift a `WorkspaceDiffTarget` (branch-name-shaped) into a `DiffFileTarget`
 * (SHA-shaped) once the diff response has surfaced the resolved merge base.
 * Returns `undefined` when we don't yet have a SHA for the merge-base side —
 * either the diff hasn't loaded yet, or the branch has no merge base with
 * HEAD (in which case the diff itself was empty and there's nothing for
 * context expansion to reach).
 */
function buildDiffFileTarget(
  target: WorkspaceDiffTarget | undefined,
  mergeBaseRef: string | null,
): DiffFileTarget | undefined {
  if (!target) return undefined;
  switch (target.type) {
    case "uncommitted":
      return { type: "uncommitted" };
    case "branch_committed":
      return mergeBaseRef
        ? { type: "branch_committed", mergeBaseRef }
        : undefined;
    case "all":
      return mergeBaseRef ? { type: "all", mergeBaseRef } : undefined;
    case "commit":
      return { type: "commit", sha: target.sha };
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function toFileContents(
  path: string,
  content: string,
  contentEncoding: "utf8" | "base64",
): FileContents | null {
  // `@pierre/diffs` wants a UTF-8 string; binary blobs come back base64. Skip
  // those — the diff-rendering library can't show context for binaries
  // (parsePatchFiles doesn't produce hunks for them anyway).
  if (contentEncoding !== "utf8") return null;
  return { name: path, contents: content };
}
