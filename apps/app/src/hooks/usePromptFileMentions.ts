import { useEffect, useMemo, useState } from "react";
import type { PromptMentionSuggestion } from "@bb/core";
import { useProjectFileSuggestions, useThreads } from "./useApi";

const FILE_MENTION_DEBOUNCE_MS = 120;
const FILE_MENTION_LIMIT = 8;

function areSuggestionsEqual(
  left: PromptMentionSuggestion[],
  right: PromptMentionSuggestion[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem.kind !== rightItem.kind ||
      leftItem.path !== rightItem.path ||
      leftItem.replacement !== rightItem.replacement
    ) {
      return false;
    }
    if (leftItem.kind === "thread" && rightItem.kind === "thread") {
      if (
        leftItem.threadId !== rightItem.threadId ||
        leftItem.title !== rightItem.title ||
        leftItem.threadType !== rightItem.threadType
      ) {
        return false;
      }
    }
  }
  return true;
}

export function usePromptFileMentions(
  projectId: string | undefined,
  options?: {
    includeThreads?: boolean;
    currentThreadId?: string;
  },
) {
  const [query, setQuery] = useState<string | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState<string | null>(null);
  const [staleSuggestions, setStaleSuggestions] = useState<PromptMentionSuggestion[]>([]);

  useEffect(() => {
    if (query === null) {
      setDebouncedQuery(null);
      return;
    }

    const timeout = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, FILE_MENTION_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [query]);

  const search = useProjectFileSuggestions(
    projectId,
    debouncedQuery,
    FILE_MENTION_LIMIT,
  );
  const threadsQuery = useThreads(
    { projectId, includeArchived: false },
    {
      enabled: Boolean(projectId) && Boolean(options?.includeThreads),
    },
  );

  const hasQuery = (query?.trim().length ?? 0) > 0;
  const isDebouncing = hasQuery && query !== debouncedQuery;
  const trimmedQuery = query?.trim().toLowerCase() ?? "";
  const fileSuggestions = useMemo(
    () =>
      (search.data ?? []).map<PromptMentionSuggestion>((item) => ({
        kind: "file",
        path: item.path,
        replacement: item.path,
      })),
    [search.data],
  );
  const threadSuggestions = useMemo(() => {
    if (!options?.includeThreads || trimmedQuery.length === 0) {
      return [];
    }
    return (threadsQuery.data ?? [])
      .filter((thread) => thread.archivedAt === undefined)
      .filter((thread) => thread.id !== options.currentThreadId)
      .filter((thread) => {
        const title = thread.title?.trim().toLowerCase() ?? "";
        return (
          thread.id.toLowerCase().includes(trimmedQuery) ||
          title.includes(trimmedQuery)
        );
      })
      .slice(0, FILE_MENTION_LIMIT)
      .map<PromptMentionSuggestion>((thread) => ({
        kind: "thread",
        path: `thread:${thread.id}`,
        replacement: `thread:${thread.id}`,
        threadId: thread.id,
        title: thread.title,
        threadType: thread.type,
      }));
  }, [
    options?.currentThreadId,
    options?.includeThreads,
    threadsQuery.data,
    trimmedQuery,
  ]);
  const nextSuggestions = useMemo(
    () =>
      [...threadSuggestions, ...fileSuggestions].slice(
        0,
        FILE_MENTION_LIMIT,
      ),
    [fileSuggestions, threadSuggestions],
  );
  const suggestions = hasQuery ? (nextSuggestions.length > 0 ? nextSuggestions : staleSuggestions) : [];

  useEffect(() => {
    if (!hasQuery) {
      setStaleSuggestions((previous) => (previous.length === 0 ? previous : []));
      return;
    }
    if (search.data) {
      setStaleSuggestions((previous) =>
        areSuggestionsEqual(previous, nextSuggestions) ? previous : nextSuggestions,
      );
    }
  }, [hasQuery, nextSuggestions, search.data]);

  return {
    query,
    setQuery,
    suggestions,
    isLoading:
      hasQuery &&
      suggestions.length === 0 &&
      (isDebouncing || search.isPending || search.isFetching),
    isError: search.isError,
  };
}
