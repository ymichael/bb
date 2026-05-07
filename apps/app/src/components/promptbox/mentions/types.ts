import type { ThreadType } from "@bb/domain";

/**
 * One row in the mention menu. The `replacement` field is the literal text
 * inserted into the prompt after the user picks the suggestion (e.g.
 * `apps/app/src/foo.ts` for files, `thread:thr_abc` for threads).
 */
export type PromptMentionSuggestion =
  | { kind: "file"; path: string; replacement: string }
  | {
      kind: "thread";
      path: string;
      replacement: string;
      threadId: string;
      title?: string;
      threadType: ThreadType;
    };

/**
 * Mutually-exclusive states the mention menu can render. Replaces the prior
 * 4-boolean flag soup (showQueryHint / mentionLoading / mentionError /
 * mentionSuggestions). The "results" state's empty-vs-populated rendering is
 * a single decision inside the menu (`suggestions.length === 0` shows the
 * "No matching files" empty state).
 */
export type MentionMenuState =
  /** User typed `@` but no query yet — show the "Type to search files" hint. */
  | { kind: "hint" }
  /** Suggestions request in flight. */
  | { kind: "loading" }
  /** Suggestions request failed. */
  | { kind: "error" }
  /** Suggestions resolved (possibly empty). */
  | { kind: "results"; suggestions: readonly PromptMentionSuggestion[] };
