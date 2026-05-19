import { useMemo } from "react";
import type { ThreadType } from "@bb/domain";
import { useDebounceValue } from "usehooks-ts";
import { useProjectPathSuggestions } from "./queries/project-queries";
import { useThreadStoragePaths } from "./queries/thread-queries";
import type { PathListOptions } from "@/lib/path-list-options";

export const PATH_SUGGESTION_DEBOUNCE_MS = 120;

const DEFAULT_PATH_SUGGESTION_LIMIT = 8;
const SOURCE_OVERSAMPLE_MULTIPLIER = 2;

export type PathSuggestionSource = "workspace" | "thread-storage";
export type PathSuggestionEntryKind = "file" | "directory";

export interface PathSuggestion {
  source: PathSuggestionSource;
  entryKind: PathSuggestionEntryKind;
  path: string;
  name: string;
  score: number;
  positions: number[];
}

export interface UsePathSuggestionsArgs {
  projectId: string | undefined;
  query: string | null;
  limit?: number;
  environmentId: string | null;
  currentThreadId?: string;
  currentThreadType?: ThreadType;
  includeDirectories: boolean;
}

export interface UsePathSuggestionsResult {
  suggestions: PathSuggestion[];
  isLoading: boolean;
  isError: boolean;
  isDebouncing: boolean;
}

interface RankedPathSuggestion extends PathSuggestion {
  sourceRank: number;
}

function getSourceRank(source: PathSuggestionSource): number {
  return source === "workspace" ? 0 : 1;
}

function comparePathSuggestions(
  left: RankedPathSuggestion,
  right: RankedPathSuggestion,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.sourceRank !== right.sourceRank) {
    return left.sourceRank - right.sourceRank;
  }
  if (left.entryKind !== right.entryKind) {
    return left.entryKind === "directory" ? -1 : 1;
  }
  return left.path.localeCompare(right.path);
}

function toPathSuggestion(
  rankedSuggestion: RankedPathSuggestion,
): PathSuggestion {
  return {
    source: rankedSuggestion.source,
    entryKind: rankedSuggestion.entryKind,
    path: rankedSuggestion.path,
    name: rankedSuggestion.name,
    score: rankedSuggestion.score,
    positions: rankedSuggestion.positions,
  };
}

export function usePathSuggestions(
  args: UsePathSuggestionsArgs,
): UsePathSuggestionsResult {
  const limit = args.limit ?? DEFAULT_PATH_SUGGESTION_LIMIT;
  const oversampleLimit = limit * SOURCE_OVERSAMPLE_MULTIPLIER;
  const [debouncedNonNullQuery] = useDebounceValue(
    args.query,
    PATH_SUGGESTION_DEBOUNCE_MS,
  );
  const debouncedQuery = args.query === null ? null : debouncedNonNullQuery;
  const trimmedQuery = args.query?.trim() ?? "";
  const hasQuery = trimmedQuery.length > 0;
  const debouncedTrimmedQuery = debouncedQuery?.trim() ?? "";
  const isDebouncing = hasQuery && trimmedQuery !== debouncedTrimmedQuery;
  const includeThreadStorage =
    args.currentThreadType === "manager" && Boolean(args.currentThreadId);

  const threadStorageOptions = useMemo<PathListOptions>(
    () => ({
      limit: oversampleLimit,
      query: debouncedQuery,
      includeFiles: true,
      includeDirectories: args.includeDirectories,
    }),
    [args.includeDirectories, debouncedQuery, oversampleLimit],
  );

  const workspaceQuery = useProjectPathSuggestions({
    projectId: args.projectId,
    query: debouncedQuery,
    limit: oversampleLimit,
    environmentId: args.environmentId,
    includeFiles: true,
    includeDirectories: args.includeDirectories,
  });
  const threadStorageQuery = useThreadStoragePaths(
    args.currentThreadId ?? "",
    threadStorageOptions,
    {
      enabled: includeThreadStorage,
    },
  );

  const suggestions = useMemo<PathSuggestion[]>(() => {
    if (!hasQuery) {
      return [];
    }

    const rankedSuggestions: RankedPathSuggestion[] = [];
    for (const pathEntry of workspaceQuery.data?.paths ?? []) {
      rankedSuggestions.push({
        source: "workspace",
        sourceRank: getSourceRank("workspace"),
        entryKind: pathEntry.kind,
        path: pathEntry.path,
        name: pathEntry.name,
        score: pathEntry.score,
        positions: pathEntry.positions,
      });
    }
    for (const pathEntry of threadStorageQuery.data?.paths ?? []) {
      rankedSuggestions.push({
        source: "thread-storage",
        sourceRank: getSourceRank("thread-storage"),
        entryKind: pathEntry.kind,
        path: pathEntry.path,
        name: pathEntry.name,
        score: pathEntry.score,
        positions: pathEntry.positions,
      });
    }

    return rankedSuggestions
      .sort(comparePathSuggestions)
      .slice(0, limit)
      .map(toPathSuggestion);
  }, [
    hasQuery,
    limit,
    threadStorageQuery.data?.paths,
    workspaceQuery.data?.paths,
  ]);

  const isFetching =
    workspaceQuery.isFetching ||
    (includeThreadStorage && threadStorageQuery.isFetching);
  const isPending =
    workspaceQuery.isPending ||
    (includeThreadStorage && threadStorageQuery.isPending);
  const isLoading =
    hasQuery &&
    suggestions.length === 0 &&
    (isDebouncing || isPending || isFetching);
  const isError =
    workspaceQuery.isError ||
    (includeThreadStorage && threadStorageQuery.isError);

  return {
    suggestions,
    isLoading,
    isError,
    isDebouncing,
  };
}
