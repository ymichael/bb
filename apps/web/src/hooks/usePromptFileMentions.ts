import { useEffect, useState } from "react";
import type { ProjectFileSuggestion } from "@beanbag/agent-core";
import { useProjectFileSuggestions } from "./useApi";

const FILE_MENTION_DEBOUNCE_MS = 120;
const FILE_MENTION_LIMIT = 8;

export function usePromptFileMentions(projectId: string | undefined) {
  const [query, setQuery] = useState<string | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState<string | null>(null);
  const [staleSuggestions, setStaleSuggestions] = useState<ProjectFileSuggestion[]>([]);

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

  const hasQuery = (query?.trim().length ?? 0) > 0;
  const isDebouncing = hasQuery && query !== debouncedQuery;
  const suggestions = hasQuery ? (search.data ?? staleSuggestions) : [];

  useEffect(() => {
    if (!hasQuery) {
      setStaleSuggestions([]);
      return;
    }
    if (search.data) {
      setStaleSuggestions(search.data);
    }
  }, [hasQuery, search.data]);

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
