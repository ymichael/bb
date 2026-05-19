import { fuzzyMatchText } from "@bb/fuzzy-match";
import type { Thread } from "@bb/domain";
import type {
  PromptMentionSuggestion,
  ThreadMentionSectionMode,
} from "@/components/promptbox/mentions/types";

export type ThreadSuggestionMode = "none" | "managers" | "all";
export type ThreadMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "thread" }
>;

export interface BuildThreadMentionSuggestionsArgs {
  threads: readonly Thread[];
  query: string;
  mode: ThreadSuggestionMode;
  currentThreadId?: string;
  limit: number;
}

export function getThreadMentionSectionMode(
  mode: ThreadSuggestionMode,
): ThreadMentionSectionMode {
  return mode === "none" ? "threads" : mode;
}

interface RankedThreadMentionSuggestion {
  suggestion: ThreadMentionSuggestion;
  score: number;
}

function getThreadDisplayTitle(thread: Thread): string | undefined {
  const title = thread.title?.trim();
  if (title) {
    return title;
  }

  const titleFallback = thread.titleFallback?.trim();
  return titleFallback || undefined;
}

function getThreadSearchTexts(thread: Thread): readonly string[] {
  const title = getThreadDisplayTitle(thread);
  return title ? [title, thread.id] : [thread.id];
}

function canSuggestThread(
  thread: Thread,
  args: BuildThreadMentionSuggestionsArgs,
): boolean {
  if (thread.id === args.currentThreadId) {
    return false;
  }
  return args.mode === "managers" ? thread.type === "manager" : true;
}

function toThreadMentionSuggestion(thread: Thread): ThreadMentionSuggestion {
  return {
    kind: "thread",
    path: `thread:${thread.id}`,
    replacement: `thread:${thread.id}`,
    threadId: thread.id,
    title: getThreadDisplayTitle(thread),
    threadType: thread.type,
  };
}

function compareRankedThreadMentionSuggestions(
  left: RankedThreadMentionSuggestion,
  right: RankedThreadMentionSuggestion,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.suggestion.threadType !== right.suggestion.threadType) {
    return left.suggestion.threadType === "manager" ? -1 : 1;
  }
  const leftTitle = left.suggestion.title ?? "";
  const rightTitle = right.suggestion.title ?? "";
  return (
    leftTitle.localeCompare(rightTitle) ||
    left.suggestion.threadId.localeCompare(right.suggestion.threadId)
  );
}

export function buildThreadMentionSuggestions(
  args: BuildThreadMentionSuggestionsArgs,
): ThreadMentionSuggestion[] {
  const trimmedQuery = args.query.trim();
  if (args.mode === "none" || trimmedQuery.length === 0 || args.limit <= 0) {
    return [];
  }

  const candidateThreads = args.threads.filter((thread) =>
    canSuggestThread(thread, args),
  );
  const matches = fuzzyMatchText({
    items: candidateThreads,
    query: trimmedQuery,
    getText: getThreadSearchTexts,
    limit: candidateThreads.length,
  });

  return matches
    .map<RankedThreadMentionSuggestion>((match) => ({
      suggestion: toThreadMentionSuggestion(match.item),
      score: match.score,
    }))
    .sort(compareRankedThreadMentionSuggestions)
    .slice(0, args.limit)
    .map((match) => match.suggestion);
}
