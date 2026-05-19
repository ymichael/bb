import type { ThreadType } from "@bb/domain";

export type PromptPathMentionSource = "workspace" | "thread-storage";
export type PromptPathMentionEntryKind = "file" | "directory";
export type ThreadMentionSectionMode = "all" | "managers" | "threads";

/**
 * One row in the mention menu. The `replacement` field is the literal text
 * inserted into the prompt after the user picks the suggestion (e.g.
 * `apps/app/src/foo.ts` for workspace files,
 * `thread-storage:notes/foo.md` for thread-storage files, or
 * `thread:thr_abc` for threads).
 */
export type PromptMentionSuggestion =
  | {
      kind: "path";
      source: PromptPathMentionSource;
      entryKind: PromptPathMentionEntryKind;
      path: string;
      name: string;
      replacement: string;
    }
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
 * empty state).
 */
export type MentionMenuState =
  /** User typed `@` but no query yet. */
  | { kind: "hint" }
  /** Suggestions request in flight. */
  | { kind: "loading" }
  /** Suggestions request failed. */
  | { kind: "error" }
  /** Suggestions resolved (possibly empty). */
  | {
      kind: "results";
      suggestions: readonly PromptMentionSuggestion[];
      threadSectionMode: ThreadMentionSectionMode;
    };
