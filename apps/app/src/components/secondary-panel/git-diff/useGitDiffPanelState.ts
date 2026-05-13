import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
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
  pendingGitDiffScrollPathAtom,
  selectedMergeBaseBranchAtom,
} from "../threadSecondaryPanelAtoms";
import {
  buildParsedGitDiffFileEntries,
  doesGitDiffFileMatchPath,
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

interface GitDiffIdentityParams {
  environmentId?: string;
  mergeBaseRef: string | null;
  target: WorkspaceDiffTarget | undefined;
}

export function useGitDiffPanelState({
  environmentId,
  isDiffPanelActive,
  defaultMergeBaseBranch,
}: UseGitDiffPanelStateParams) {
  const selectedMergeBaseBranch = useAtomValue(selectedMergeBaseBranchAtom);
  const pendingGitDiffScrollPath = useAtomValue(pendingGitDiffScrollPathAtom);
  const setPendingGitDiffScrollPath = useSetAtom(pendingGitDiffScrollPathAtom);
  const [selectedGitDiffCommitSha, setSelectedGitDiffCommitSha] = useState<
    string | null
  >(null);
  const [parsedGitDiffFiles, setParsedGitDiffFiles] = useState<
    ParsedGitDiffFile[]
  >([]);
  const [expectedGitDiffFileCount, setExpectedGitDiffFileCount] = useState(0);
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
  const diffMergeBaseRef = threadGitDiff?.mergeBaseRef ?? null;
  const gitDiffIdentity = useMemo(
    () =>
      buildGitDiffIdentity({
        environmentId,
        mergeBaseRef: diffMergeBaseRef,
        target: gitDiffTarget,
      }),
    [diffMergeBaseRef, environmentId, gitDiffTarget],
  );
  const currentGitDiff = threadGitDiff?.diff ?? "";
  const parsedGitDiffFileEntries = useMemo(
    () => buildParsedGitDiffFileEntries(parsedGitDiffFiles),
    [parsedGitDiffFiles],
  );
  const {
    focusGitDiffFile,
    gitDiffFileRefs,
    queuedGitDiffFileRenderKeys,
    setGitDiffFileRef,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
  } = useGitDiffFileRenderQueue({
    environmentId,
    gitDiffIdentity,
    expectedGitDiffFileCount,
    parsedGitDiffFileEntries,
    isDiffPanelActive,
    isParsingGitDiffFiles,
  });
  const isAwaitingPrerequisites =
    isDiffPanelActive && Boolean(environmentId) && gitDiffTarget === undefined;
  const gitDiffPreparationState = resolveGitDiffPreparationState({
    currentGitDiff,
    isAwaitingPrerequisites,
    isGitDiffLoading,
    isParsingGitDiffFiles,
    lastParsedGitDiffKey,
    parsedGitDiffFileCount: parsedGitDiffFileEntries.length,
  });

  // --- Parsing pipeline ---

  useEffect(() => {
    const parsePlan = buildGitDiffParsePlan({
      gitDiff: currentGitDiff,
      isDiffPanelActive,
    });

    if (parsePlan.kind === "reset") {
      setParsedGitDiffFiles([]);
      setExpectedGitDiffFileCount(0);
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey("");
      return;
    }

    setParsedGitDiffFiles([]);
    setExpectedGitDiffFileCount(parsePlan.patchChunks.length);
    if (parsePlan.kind === "empty") {
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey(parsePlan.gitDiffKey);
      return;
    }

    if (parsePlan.kind === "immediate") {
      setParsedGitDiffFiles(parseGitDiffFiles(currentGitDiff));
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
  }, [currentGitDiff, isDiffPanelActive]);

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
      if (
        !isGitDiffLoading &&
        !isParsingGitDiffFiles &&
        !gitDiffPreparationState.isAwaitingCurrentGitDiffParse
      ) {
        setPendingGitDiffScrollPath(null);
      }
      return;
    }

    focusGitDiffFile(targetEntry.key);

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
    focusGitDiffFile,
    gitDiffFileRefs,
    gitDiffPreparationState.isAwaitingCurrentGitDiffParse,
    isGitDiffLoading,
    isParsingGitDiffFiles,
    isDiffPanelActive,
    parsedGitDiffFileEntries,
    pendingGitDiffScrollPath,
    setPendingGitDiffScrollPath,
  ]);

  // --- Derived values ---

  const diffCommits = useMemo(
    () => gitDiffWorkspaceStatus?.mergeBase?.commits ?? [],
    [gitDiffWorkspaceStatus?.mergeBase?.commits],
  );
  const gitDiffSelectValue = selectedGitDiffCommitSha ?? "all";
  const gitDiffSelectOptions: GitDiffSelectionOption[] = useMemo(
    () => buildGitDiffSelectionOptions(diffCommits, { hasUncommittedChanges }),
    [diffCommits, hasUncommittedChanges],
  );
  const gitDiffStats = useMemo(
    () =>
      summarizeGitDiff(
        isParsingGitDiffFiles ? [] : parsedGitDiffFiles,
        currentGitDiff,
      ),
    [currentGitDiff, isParsingGitDiffFiles, parsedGitDiffFiles],
  );
  const { hasParsedGitDiffFiles, isPreparingGitDiff } =
    gitDiffPreparationState;

  const onGitDiffSelectionChange = useCallback((value: string) => {
    setSelectedGitDiffCommitSha(value === "all" ? null : value);
  }, []);

  const queryClient = useQueryClient();
  const fileTarget = useMemo<DiffFileTarget | undefined>(
    () => buildDiffFileTarget(gitDiffTarget, diffMergeBaseRef),
    [gitDiffTarget, diffMergeBaseRef],
  );
  const onRequestFileContents = useMemo<
    RequestDiffFileContents | undefined
  >(() => {
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
      return toFileContents(path, result.content, result.contentEncoding);
    };
  }, [environmentId, fileTarget, queryClient]);

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

function buildGitDiffIdentity({
  environmentId,
  mergeBaseRef,
  target,
}: GitDiffIdentityParams): string {
  const environmentKey = environmentId ?? "none";
  if (!target) return `${environmentKey}:none`;

  switch (target.type) {
    case "uncommitted":
      return `${environmentKey}:uncommitted`;
    case "branch_committed":
      return [
        environmentKey,
        "branch_committed",
        target.mergeBaseBranch,
        mergeBaseRef ?? "pending",
      ].join(":");
    case "all":
      return [
        environmentKey,
        "all",
        target.mergeBaseBranch,
        mergeBaseRef ?? "pending",
      ].join(":");
    case "commit":
      return `${environmentKey}:commit:${target.sha}`;
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
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
