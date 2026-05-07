import { useMemo, useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { useProjectFileSuggestions } from "./queries/project-queries";
import {
  useThreads,
  type UseThreadsFilters,
} from "./queries/thread-queries";
import type { PromptMentionSuggestion } from "@/components/promptbox/mentions/types";

const FILE_MENTION_DEBOUNCE_MS = 120;
const FILE_MENTION_LIMIT = 8;

export function usePromptMentions(
  projectId: string | undefined,
  options: {
    threadSuggestionMode?: "none" | "managers" | "all";
    currentThreadId?: string;
    environmentId: string | null;
  },
) {
  const [query, setQuery] = useState<string | null>(null);
  const [debouncedNonNull] = useDebounceValue(query, FILE_MENTION_DEBOUNCE_MS);
  const debouncedQuery = query === null ? null : debouncedNonNull;

  // useProjectFileSuggestions uses placeholderData to keep the previous
  // query's results visible while a new query is fetching, so the menu does
  // not flicker through "loading" between every keystroke.
  const search = useProjectFileSuggestions({
    projectId,
    query: debouncedQuery,
    limit: FILE_MENTION_LIMIT,
    environmentId: options.environmentId,
  });
  const threadSuggestionMode = options.threadSuggestionMode ?? "none";
  const threadFilters: UseThreadsFilters =
    threadSuggestionMode === "managers"
      ? { archived: false, projectId, type: "manager" }
      : { archived: false, projectId };
  const threadsQuery = useThreads(threadFilters, {
    enabled: threadSuggestionMode !== "none",
  });

  const hasQuery = (query?.trim().length ?? 0) > 0;
  const isDebouncing = hasQuery && query !== debouncedQuery;
  const trimmedQuery = query?.trim().toLowerCase() ?? "";
  const currentThreadId = options.currentThreadId;
  const fileSuggestions = useMemo(
    () =>
      (search.data?.files ?? []).map<PromptMentionSuggestion>((item) => ({
        kind: "file",
        path: item.path,
        replacement: item.path,
      })),
    [search.data?.files],
  );
  const threadSuggestions = useMemo(() => {
    if (threadSuggestionMode === "none" || trimmedQuery.length === 0) {
      return [];
    }
    return (threadsQuery.data ?? [])
      .filter((thread) => thread.id !== currentThreadId)
      .filter((thread) =>
        threadSuggestionMode === "managers" ? thread.type === "manager" : true,
      )
      .filter((thread) => {
        const title = thread.title?.trim().toLowerCase() ?? "";
        return (
          thread.id.toLowerCase().includes(trimmedQuery) ||
          title.includes(trimmedQuery)
        );
      })
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === "manager" ? -1 : 1;
        }

        const leftTitle = left.title?.trim().toLowerCase() ?? "";
        const rightTitle = right.title?.trim().toLowerCase() ?? "";
        return (
          leftTitle.localeCompare(rightTitle) || left.id.localeCompare(right.id)
        );
      })
      .slice(0, FILE_MENTION_LIMIT)
      .map<PromptMentionSuggestion>((thread) => ({
        kind: "thread",
        path: `thread:${thread.id}`,
        replacement: `thread:${thread.id}`,
        threadId: thread.id,
        title: thread.title ?? thread.titleFallback ?? undefined,
        threadType: thread.type,
      }));
  }, [currentThreadId, threadSuggestionMode, threadsQuery.data, trimmedQuery]);
  const suggestions = useMemo(
    () =>
      hasQuery
        ? [...threadSuggestions, ...fileSuggestions].slice(
            0,
            FILE_MENTION_LIMIT,
          )
        : [],
    [hasQuery, fileSuggestions, threadSuggestions],
  );

  // Loading flips on only when there are zero suggestions to show. Once the
  // first fetch returns (or placeholderData carries prior results across a
  // refetch), suggestions stay populated and the menu never collapses back
  // to the loading state mid-typing.
  const isLoading =
    hasQuery &&
    suggestions.length === 0 &&
    (isDebouncing || search.isPending || search.isFetching);
  const isError = search.isError;

  return {
    query,
    setQuery,
    suggestions,
    isLoading,
    isError,
  };
}
