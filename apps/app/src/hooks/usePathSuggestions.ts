import { useMemo } from "react";
import type { WorkspacePathEntry } from "@bb/server-contract";
import { useDebounceValue } from "usehooks-ts";
import { useEnvironmentPathSuggestions } from "./queries/environment-queries";
import { useProjectPathSuggestions } from "./queries/project-queries";
import { useThreadStoragePaths } from "./queries/thread-queries";
import { isProjectlessProjectId } from "@/lib/route-paths";
import type { PathListOptions } from "@/lib/path-list-options";

export const PATH_SUGGESTION_DEBOUNCE_MS = 120;

const DEFAULT_PATH_SUGGESTION_LIMIT = 8;
const SOURCE_OVERSAMPLE_MULTIPLIER = 2;

export type PathSuggestionSource = "workspace" | "thread-storage";
type PathSuggestionEntryKind = "file" | "directory";

type WorkspaceSource = "environment" | "project" | "none";

export interface PathSuggestion {
  source: PathSuggestionSource;
  entryKind: PathSuggestionEntryKind;
  path: string;
  name: string;
  score: number;
  positions: number[];
}

interface UsePathSuggestionsArgs {
  projectId: string | undefined;
  query: string | null;
  limit?: number;
  environmentId: string | null;
  hostId?: string | null;
  currentThreadId?: string;
  includeDirectories: boolean;
}

interface UsePathSuggestionsResult {
  suggestions: PathSuggestion[];
  isLoading: boolean;
  isError: boolean;
  isDebouncing: boolean;
}

interface RankedPathSuggestion extends PathSuggestion {
  sourceRank: number;
  sourceOrder: number;
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
  if (left.sourceOrder !== right.sourceOrder) {
    return left.sourceOrder - right.sourceOrder;
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

interface ToRankedPathSuggestionArgs {
  pathEntry: WorkspacePathEntry;
  source: PathSuggestionSource;
  sourceOrder: number;
}

interface BuildPathSuggestionsArgs {
  workspacePaths: readonly WorkspacePathEntry[];
  threadStoragePaths: readonly WorkspacePathEntry[];
  limit: number;
}

function toRankedPathSuggestion(
  args: ToRankedPathSuggestionArgs,
): RankedPathSuggestion {
  return {
    source: args.source,
    sourceRank: getSourceRank(args.source),
    sourceOrder: args.sourceOrder,
    entryKind: args.pathEntry.kind,
    path: args.pathEntry.path,
    name: args.pathEntry.name,
    score: args.pathEntry.score,
    positions: args.pathEntry.positions,
  };
}

export function buildPathSuggestions(
  args: BuildPathSuggestionsArgs,
): PathSuggestion[] {
  const rankedSuggestions: RankedPathSuggestion[] = [];

  for (const [sourceOrder, pathEntry] of args.workspacePaths.entries()) {
    rankedSuggestions.push(
      toRankedPathSuggestion({
        pathEntry,
        source: "workspace",
        sourceOrder,
      }),
    );
  }
  for (const [sourceOrder, pathEntry] of args.threadStoragePaths.entries()) {
    rankedSuggestions.push(
      toRankedPathSuggestion({
        pathEntry,
        source: "thread-storage",
        sourceOrder,
      }),
    );
  }

  return rankedSuggestions
    .sort(comparePathSuggestions)
    .slice(0, args.limit)
    .map(toPathSuggestion);
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
  const hasDebouncedQuery = debouncedTrimmedQuery.length > 0;
  const workspaceSource: WorkspaceSource = args.environmentId
    ? "environment"
    : args.projectId && !isProjectlessProjectId(args.projectId)
      ? "project"
      : "none";
  const includeWorkspace = workspaceSource !== "none";
  const includeThreadStorage = Boolean(args.currentThreadId);
  const isWorkspaceQueryEnabled = includeWorkspace && hasDebouncedQuery;
  const isThreadStorageQueryEnabled = includeThreadStorage && hasDebouncedQuery;

  const threadStorageOptions = useMemo<PathListOptions>(
    () => ({
      limit: oversampleLimit,
      query: debouncedQuery,
      includeFiles: true,
      includeDirectories: args.includeDirectories,
    }),
    [args.includeDirectories, debouncedQuery, oversampleLimit],
  );

  const projectWorkspaceQuery = useProjectPathSuggestions({
    projectId: workspaceSource === "project" ? args.projectId : undefined,
    environmentId: null,
    hostId: args.hostId ?? null,
    query: debouncedQuery,
    limit: oversampleLimit,
    includeFiles: true,
    includeDirectories: args.includeDirectories,
  });
  const environmentWorkspaceQuery = useEnvironmentPathSuggestions({
    environmentId:
      workspaceSource === "environment" ? args.environmentId : undefined,
    query: debouncedQuery,
    limit: oversampleLimit,
    includeFiles: true,
    includeDirectories: args.includeDirectories,
  });
  const workspaceQuery =
    workspaceSource === "environment"
      ? environmentWorkspaceQuery
      : projectWorkspaceQuery;
  const threadStorageQuery = useThreadStoragePaths(
    args.currentThreadId ?? "",
    threadStorageOptions,
    {
      enabled: isThreadStorageQueryEnabled,
    },
  );

  const suggestions = useMemo<PathSuggestion[]>(() => {
    if (!hasQuery) {
      return [];
    }

    return buildPathSuggestions({
      workspacePaths: includeWorkspace
        ? (workspaceQuery.data?.paths ?? [])
        : [],
      threadStoragePaths: includeThreadStorage
        ? (threadStorageQuery.data?.paths ?? [])
        : [],
      limit,
    });
  }, [
    hasQuery,
    includeThreadStorage,
    includeWorkspace,
    limit,
    threadStorageQuery.data?.paths,
    workspaceQuery.data?.paths,
  ]);

  const isFetching =
    (isWorkspaceQueryEnabled && workspaceQuery.isFetching) ||
    (isThreadStorageQueryEnabled && threadStorageQuery.isFetching);
  const isPending =
    (isWorkspaceQueryEnabled && workspaceQuery.isPending) ||
    (isThreadStorageQueryEnabled && threadStorageQuery.isPending);
  const isLoading =
    hasQuery &&
    suggestions.length === 0 &&
    (isDebouncing || isPending || isFetching);
  const isError =
    hasQuery &&
    ((isWorkspaceQueryEnabled && workspaceQuery.isError) ||
      (isThreadStorageQueryEnabled && threadStorageQuery.isError));

  return {
    suggestions,
    isLoading,
    isError,
    isDebouncing,
  };
}
