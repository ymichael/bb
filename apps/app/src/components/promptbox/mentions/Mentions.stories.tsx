import { MentionMenu } from "@/components/promptbox/mentions/MentionMenu";
import type {
  MentionMenuState,
  PromptMentionSuggestion,
  ThreadMentionSectionMode,
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
// Realistic suggestion fixtures — bb-flavored paths + thread refs.
// ---------------------------------------------------------------------------

function getPathName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function workspaceFile(path: string): PromptMentionSuggestion {
  return {
    kind: "path",
    source: "workspace",
    entryKind: "file",
    path,
    name: getPathName(path),
    replacement: path,
  };
}

function workspaceFolder(path: string): PromptMentionSuggestion {
  return {
    kind: "path",
    source: "workspace",
    entryKind: "directory",
    path,
    name: getPathName(path),
    replacement: `${path}/`,
  };
}

function storageFile(path: string): PromptMentionSuggestion {
  return {
    kind: "path",
    source: "thread-storage",
    entryKind: "file",
    path,
    name: getPathName(path),
    replacement: `thread-storage:${path}`,
  };
}

function storageFolder(path: string): PromptMentionSuggestion {
  return {
    kind: "path",
    source: "thread-storage",
    entryKind: "directory",
    path,
    name: getPathName(path),
    replacement: `thread-storage:${path}/`,
  };
}

const pathSuggestions: PromptMentionSuggestion[] = [
  workspaceFile("apps/app/src/components/promptbox/PromptBoxInternal.tsx"),
  workspaceFile("apps/app/src/components/promptbox/banner/ContextBanner.tsx"),
  workspaceFolder("apps/app/src/components/promptbox/mentions"),
  storageFile("notes/status.md"),
  storageFolder("scratch/reports"),
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
  workspaceFile(
    "apps/server/src/routes/internal/long/path/that/keeps/going/and/going/threads.ts",
  ),
  workspaceFile(
    "packages/agent-providers/src/codex/internal/long/nested/module/streaming/event-decoder.ts",
  ),
];

const mixedSuggestions: PromptMentionSuggestion[] = [
  ...threadSuggestions.slice(0, 2),
  ...pathSuggestions.slice(0, 4),
];

// ---------------------------------------------------------------------------
// Per-row helper.
// ---------------------------------------------------------------------------

interface RowConfig {
  state: MentionMenuState;
  selectedIndex?: number;
}

interface ResultsStateConfig {
  suggestions: readonly PromptMentionSuggestion[];
  threadSectionMode?: ThreadMentionSectionMode;
}

function makeResultsState(args: ResultsStateConfig): MentionMenuState {
  return {
    kind: "results",
    suggestions: args.suggestions,
    threadSectionMode: args.threadSectionMode ?? "all",
  };
}

function Row({ state, selectedIndex = 0 }: RowConfig) {
  return (
    <PromptStage>
      <MentionMenu state={state} selectedIndex={selectedIndex} onApply={noop} />
    </PromptStage>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="hint" hint='@ typed alone — "Type to search mentions"'>
        <Row state={{ kind: "hint" }} />
      </StoryRow>
      <StoryRow label="loading" hint="suggestions fetching">
        <Row state={{ kind: "loading" }} />
      </StoryRow>
      <StoryRow label="error" hint="suggestion query failed">
        <Row state={{ kind: "error" }} />
      </StoryRow>
      <StoryRow label="no matches" hint="query returned zero results">
        <Row state={makeResultsState({ suggestions: [] })} />
      </StoryRow>
      <StoryRow label="path matches" hint="workspace and manager storage paths">
        <Row state={makeResultsState({ suggestions: pathSuggestions })} />
      </StoryRow>
      <StoryRow
        label="path matches (selected index)"
        hint="third item highlighted (keyboard arrow nav)"
      >
        <Row
          state={makeResultsState({ suggestions: pathSuggestions })}
          selectedIndex={2}
        />
      </StoryRow>
      <StoryRow
        label="thread matches"
        hint="manager + standard threads with leading row icons"
      >
        <Row state={makeResultsState({ suggestions: threadSuggestions })} />
      </StoryRow>
      <StoryRow
        label="mixed path + thread"
        hint="threads first (production order: usePromptMentions prepends threads)"
      >
        <Row state={makeResultsState({ suggestions: mixedSuggestions })} />
      </StoryRow>
      <StoryRow
        label="long path truncation"
        hint="TruncateStart on directory; basename stays visible"
      >
        <Row state={makeResultsState({ suggestions: longPathSuggestions })} />
      </StoryRow>
    </StoryCard>
  );
}
