import type { WorkspaceCommitSummary } from "@bb/domain";
import {
  getGitDiffParseKey,
  splitGitDiffIntoPatchChunks,
} from "./git-diff-parsing";
import type { GitDiffSelectionOption } from "../ThreadSecondaryPanel";

export const GIT_DIFF_PARSE_BATCH_THRESHOLD = 24;
export const GIT_DIFF_PARSE_INITIAL_BATCH_SIZE = 6;
export const GIT_DIFF_PARSE_BATCH_SIZE = 18;
export const GIT_DIFF_PARSE_BATCH_DELAY_MS = 24;

export const UNCOMMITTED_GIT_DIFF_SELECTION = "uncommitted";

export type GitDiffTarget =
  | { type: "commit"; sha: string }
  | { type: "uncommitted" }
  | { type: "all"; mergeBaseBranch: string }
  | undefined;

export interface GitDiffPreparationState {
  currentGitDiffKey: string;
  hasCurrentGitDiff: boolean;
  hasParsedGitDiffFiles: boolean;
  isAwaitingCurrentGitDiffParse: boolean;
  isPreparingGitDiff: boolean;
}

export type GitDiffParsePlan =
  | { kind: "reset"; gitDiffKey: string; patchChunks: [] }
  | { kind: "empty"; gitDiffKey: string; patchChunks: [] }
  | { kind: "immediate"; gitDiffKey: string; patchChunks: string[] }
  | { kind: "batched"; gitDiffKey: string; patchChunks: string[] };

interface GitDiffPreparationStateParams {
  currentGitDiff: string;
  isGitDiffLoading: boolean;
  isParsingGitDiffFiles: boolean;
  lastParsedGitDiffKey: string;
  parsedGitDiffFileCount: number;
}

export function buildGitDiffTarget(
  selectedGitDiffCommitSha: string | null,
  effectiveMergeBaseBranch: string | undefined,
): GitDiffTarget {
  if (selectedGitDiffCommitSha === UNCOMMITTED_GIT_DIFF_SELECTION) {
    return { type: "uncommitted" };
  }

  if (selectedGitDiffCommitSha) {
    return { type: "commit", sha: selectedGitDiffCommitSha };
  }

  if (effectiveMergeBaseBranch) {
    return {
      type: "all",
      mergeBaseBranch: effectiveMergeBaseBranch,
    };
  }

  return undefined;
}

export function buildGitDiffSelectionOptions(
  diffCommits: readonly WorkspaceCommitSummary[],
  options: { hasUncommittedChanges: boolean } = {
    hasUncommittedChanges: false,
  },
): GitDiffSelectionOption[] {
  const allChangesOption = { value: "all", label: "All changes" };
  const uncommittedOption = {
    value: UNCOMMITTED_GIT_DIFF_SELECTION,
    label: "Uncommitted changes",
  };
  const commitOptions = diffCommits.map((commit) => ({
    value: commit.sha,
    label: commit.subject,
    monoPrefix: commit.shortSha,
  }));

  const hasMergeBaseContext =
    diffCommits.length > 0 || options.hasUncommittedChanges;
  if (!hasMergeBaseContext) {
    return [allChangesOption];
  }

  return [
    allChangesOption,
    ...(options.hasUncommittedChanges ? [uncommittedOption] : []),
    ...commitOptions,
  ];
}

export function shouldResetSelectedGitDiffCommit(
  selectedGitDiffCommitSha: string | null,
  diffCommits: readonly WorkspaceCommitSummary[],
  options: { hasUncommittedChanges: boolean } = {
    hasUncommittedChanges: false,
  },
): boolean {
  if (!selectedGitDiffCommitSha) {
    return false;
  }
  if (selectedGitDiffCommitSha === UNCOMMITTED_GIT_DIFF_SELECTION) {
    return !options.hasUncommittedChanges;
  }
  return !diffCommits.some((commit) => commit.sha === selectedGitDiffCommitSha);
}

export function resolveGitDiffPreparationState(
  params: GitDiffPreparationStateParams,
): GitDiffPreparationState {
  const hasCurrentGitDiff = params.currentGitDiff.trim().length > 0;
  const currentGitDiffKey = getGitDiffParseKey(params.currentGitDiff);
  const hasParsedGitDiffFiles = params.parsedGitDiffFileCount > 0;
  const isAwaitingCurrentGitDiffParse =
    hasCurrentGitDiff && params.lastParsedGitDiffKey !== currentGitDiffKey;
  const isPreparingGitDiff =
    !hasParsedGitDiffFiles &&
    (params.isGitDiffLoading ||
      params.isParsingGitDiffFiles ||
      isAwaitingCurrentGitDiffParse);

  return {
    currentGitDiffKey,
    hasCurrentGitDiff,
    hasParsedGitDiffFiles,
    isAwaitingCurrentGitDiffParse,
    isPreparingGitDiff,
  };
}

export function buildGitDiffParsePlan(args: {
  gitDiff: string;
  isDiffPanelActive: boolean;
}): GitDiffParsePlan {
  const gitDiffKey = getGitDiffParseKey(args.gitDiff);

  if (!args.isDiffPanelActive || args.gitDiff.trim().length === 0) {
    return {
      kind: "reset",
      gitDiffKey,
      patchChunks: [],
    };
  }

  const patchChunks = splitGitDiffIntoPatchChunks(args.gitDiff);
  if (patchChunks.length === 0) {
    return {
      kind: "empty",
      gitDiffKey,
      patchChunks: [],
    };
  }

  if (patchChunks.length <= GIT_DIFF_PARSE_BATCH_THRESHOLD) {
    return {
      kind: "immediate",
      gitDiffKey,
      patchChunks,
    };
  }

  return {
    kind: "batched",
    gitDiffKey,
    patchChunks,
  };
}
