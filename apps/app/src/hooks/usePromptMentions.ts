import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ThreadType } from "@bb/domain";
import { buildPathMentionSuggestions } from "./pathMentionSuggestions";
import { useThreads, type UseThreadsFilters } from "./queries/thread-queries";
import {
  buildThreadMentionSuggestions,
  getThreadMentionSectionMode,
  type ThreadSuggestionMode,
} from "./threadMentionSuggestions";
import { usePathSuggestions } from "./usePathSuggestions";
import type {
  PromptMentionSuggestion,
  ThreadMentionSectionMode,
} from "@/components/promptbox/mentions/types";

const PROMPT_MENTION_LIMIT = 8;

export interface UsePromptMentionsOptions {
  threadSuggestionMode?: ThreadSuggestionMode;
  currentThreadId?: string;
  currentThreadType?: ThreadType;
  environmentId: string | null;
}

export interface UsePromptMentionsResult {
  query: string | null;
  setQuery: Dispatch<SetStateAction<string | null>>;
  suggestions: PromptMentionSuggestion[];
  threadSectionMode: ThreadMentionSectionMode;
  isLoading: boolean;
  isError: boolean;
}

export function usePromptMentions(
  projectId: string | undefined,
  options: UsePromptMentionsOptions,
): UsePromptMentionsResult {
  const [query, setQuery] = useState<string | null>(null);

  const pathSearch = usePathSuggestions({
    projectId,
    query,
    limit: PROMPT_MENTION_LIMIT,
    environmentId: options.environmentId,
    currentThreadId: options.currentThreadId,
    currentThreadType: options.currentThreadType,
    includeDirectories: true,
  });
  const threadSuggestionMode = options.threadSuggestionMode ?? "none";
  const threadSectionMode = getThreadMentionSectionMode(threadSuggestionMode);
  const threadFilters: UseThreadsFilters =
    threadSuggestionMode === "managers"
      ? { archived: false, projectId, type: "manager" }
      : { archived: false, projectId };
  const threadsQuery = useThreads(threadFilters, {
    enabled: threadSuggestionMode !== "none",
  });

  const hasQuery = (query?.trim().length ?? 0) > 0;
  const trimmedQuery = query?.trim() ?? "";
  const currentThreadId = options.currentThreadId;
  const pathSuggestions = useMemo(
    () =>
      buildPathMentionSuggestions({
        paths: pathSearch.suggestions,
      }),
    [pathSearch.suggestions],
  );
  const threadSuggestions = useMemo(() => {
    return buildThreadMentionSuggestions({
      threads: threadsQuery.data ?? [],
      query: trimmedQuery,
      mode: threadSuggestionMode,
      currentThreadId,
      limit: PROMPT_MENTION_LIMIT,
    });
  }, [currentThreadId, threadSuggestionMode, threadsQuery.data, trimmedQuery]);
  const suggestions = useMemo(
    () =>
      hasQuery
        ? [...threadSuggestions, ...pathSuggestions].slice(
            0,
            PROMPT_MENTION_LIMIT,
          )
        : [],
    [hasQuery, pathSuggestions, threadSuggestions],
  );

  // Loading flips on only when there are zero suggestions to show. Once the
  // first fetch returns (or placeholderData carries prior results across a
  // refetch), suggestions stay populated and the menu never collapses back
  // to the loading state mid-typing.
  const isLoading =
    hasQuery &&
    suggestions.length === 0 &&
    (pathSearch.isDebouncing || pathSearch.isLoading);
  const isError = pathSearch.isError;

  return {
    query,
    setQuery,
    suggestions,
    threadSectionMode,
    isLoading,
    isError,
  };
}
