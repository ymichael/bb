import { MentionMenu } from "@/components/promptbox/mentions/MentionMenu";
import type {
  MentionMenuState,
  PromptMentionSuggestion,
} from "@/components/promptbox/mentions/types";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "promptbox/Mentions",
};

const noop = () => {};

// Match the production prompt box width (PageShell footer caps content at
// 760px). The MentionMenu floats inside PromptBoxInternal in production;
// PromptStage gives it the same horizontal envelope here.
function PromptStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

// ---------------------------------------------------------------------------
// Realistic suggestion fixtures — bb-flavored file paths + thread refs.
// ---------------------------------------------------------------------------

const fileSuggestions: PromptMentionSuggestion[] = [
  {
    kind: "file",
    path: "apps/app/src/components/promptbox/PromptBoxInternal.tsx",
    replacement: "apps/app/src/components/promptbox/PromptBoxInternal.tsx",
  },
  {
    kind: "file",
    path: "apps/app/src/components/promptbox/banner/ContextBanner.tsx",
    replacement: "apps/app/src/components/promptbox/banner/ContextBanner.tsx",
  },
  {
    kind: "file",
    path: "apps/app/src/components/promptbox/mentions/MentionMenu.tsx",
    replacement: "apps/app/src/components/promptbox/mentions/MentionMenu.tsx",
  },
  {
    kind: "file",
    path: "packages/domain/src/thread.ts",
    replacement: "packages/domain/src/thread.ts",
  },
  {
    kind: "file",
    path: "packages/server-contract/src/api-types.ts",
    replacement: "packages/server-contract/src/api-types.ts",
  },
];

const threadSuggestions: PromptMentionSuggestion[] = [
  {
    kind: "thread",
    path: "thread:thr_qfk8ksbxkk",
    replacement: "thread:thr_qfk8ksbxkk",
    threadId: "thr_qfk8ksbxkk",
    title: "Wire up promptbox stories and trim FollowUp API",
    threadType: "standard",
  },
  {
    kind: "thread",
    path: "thread:thr_mgr_kj4n2x",
    replacement: "thread:thr_mgr_kj4n2x",
    threadId: "thr_mgr_kj4n2x",
    title: "Manager: app/timeline cleanup sprint",
    threadType: "manager",
  },
  {
    kind: "thread",
    path: "thread:thr_untitled_3",
    replacement: "thread:thr_untitled_3",
    threadId: "thr_untitled_3",
    title: undefined,
    threadType: "standard",
  },
];

const longPathSuggestions: PromptMentionSuggestion[] = [
  {
    kind: "file",
    path: "apps/server/src/routes/internal/long/path/that/keeps/going/and/going/threads.ts",
    replacement:
      "apps/server/src/routes/internal/long/path/that/keeps/going/and/going/threads.ts",
  },
  {
    kind: "file",
    path: "packages/agent-providers/src/codex/internal/long/nested/module/streaming/event-decoder.ts",
    replacement:
      "packages/agent-providers/src/codex/internal/long/nested/module/streaming/event-decoder.ts",
  },
];

const mixedSuggestions: PromptMentionSuggestion[] = [
  ...threadSuggestions.slice(0, 2),
  ...fileSuggestions.slice(0, 3),
];

// ---------------------------------------------------------------------------
// Per-row helper.
// ---------------------------------------------------------------------------

interface RowConfig {
  state: MentionMenuState;
  selectedIndex?: number;
}

function Row({ state, selectedIndex = 0 }: RowConfig) {
  return (
    <PromptStage>
      <MentionMenu
        state={state}
        selectedIndex={selectedIndex}
        onApply={noop}
      />
    </PromptStage>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="hint"
        hint='@ typed alone — "Type to search files"'
      >
        <Row state={{ kind: "hint" }} />
      </StoryRow>
      <StoryRow label="loading" hint="suggestions fetching">
        <Row state={{ kind: "loading" }} />
      </StoryRow>
      <StoryRow label="error" hint="suggestion query failed">
        <Row state={{ kind: "error" }} />
      </StoryRow>
      <StoryRow label="no matches" hint="query returned zero results">
        <Row state={{ kind: "results", suggestions: [] }} />
      </StoryRow>
      <StoryRow label="file matches" hint="five real bb files">
        <Row state={{ kind: "results", suggestions: fileSuggestions }} />
      </StoryRow>
      <StoryRow
        label="file matches (selected index)"
        hint="third item highlighted (keyboard arrow nav)"
      >
        <Row
          state={{ kind: "results", suggestions: fileSuggestions }}
          selectedIndex={2}
        />
      </StoryRow>
      <StoryRow
        label="thread matches"
        hint='manager + standard threads — type label badge ("Manager"/"Thread")'
      >
        <Row state={{ kind: "results", suggestions: threadSuggestions }} />
      </StoryRow>
      <StoryRow
        label="mixed file + thread"
        hint="threads first (production order: usePromptMentions prepends threads)"
      >
        <Row state={{ kind: "results", suggestions: mixedSuggestions }} />
      </StoryRow>
      <StoryRow
        label="long path truncation"
        hint="TruncateStart on directory; basename stays visible"
      >
        <Row state={{ kind: "results", suggestions: longPathSuggestions }} />
      </StoryRow>
    </StoryCard>
  );
}
