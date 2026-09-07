import { useState, type ReactNode } from "react";
import type { PromptTextMention, ThreadListEntry } from "@bb/domain";
import {
  NewThreadPromptBoxUI,
  type NewThreadBranchConfig,
  type NewThreadEnvironmentConfig,
  type NewThreadModeConfig,
  type NewThreadProjectConfig,
  type NewThreadWorktreeConfig,
} from "@/components/promptbox/NewThreadPromptBox";
import { ModelPickerStoryQueryProvider } from "../../.ladle/model-picker-query-provider";
import {
  HOST_IDS,
  PROJECT_IDS,
  PROJECT_NAMES,
  STORY_BRANCH_OPTIONS,
  STORY_CLAUDE_CODE_PROVIDER_ID,
  STORY_CURSOR_PROVIDER_ID,
  STORY_PROVIDERS_BY_ID,
  STORY_PROJECTS,
  STORY_PROJECT_SOURCES,
  STORY_WORKTREE_OPTIONS,
  makeAttachmentsConfig,
  makeExecutionControlsProps,
  makeHost,
  makeThreadListEntry,
  makeTypeaheadConfig,
} from "../../.ladle/story-fixtures";
import { RootComposeCompactHome } from "./RootComposeCompactHome";
import { RootComposeMobileRecents } from "./RootComposeMobileRecents";

export const projectNamesById = new Map<string, string>([
  [PROJECT_IDS.bb, PROJECT_NAMES.bb],
  [PROJECT_IDS.pierre, PROJECT_NAMES.pierre],
]);

export const HOME_THREADS: ThreadListEntry[] = [
  makeThreadListEntry({
    id: "thr_home_parent",
    title: "Rework folder model",
    titleFallback: "Rework folder model",
    latestAttentionAt: 900,
  }),
  makeThreadListEntry({
    id: "thr_home_child_a",
    parentThreadId: "thr_home_parent",
    providerId: STORY_CLAUDE_CODE_PROVIDER_ID,
    title: "Audit folder query paths",
    titleFallback: "Audit folder query paths",
    latestAttentionAt: 880,
  }),
  makeThreadListEntry({
    id: "thr_home_child_b",
    parentThreadId: "thr_home_parent",
    providerId: STORY_CURSOR_PROVIDER_ID,
    title: "Migrate folder fixtures",
    titleFallback: "Migrate folder fixtures",
    latestAttentionAt: 870,
  }),
  makeThreadListEntry({
    id: "thr_home_style",
    providerId: STORY_CLAUDE_CODE_PROVIDER_ID,
    title: "Reduce style recalculation",
    titleFallback: "Reduce style recalculation",
    status: "starting",
    latestAttentionAt: 860,
    runtime: { displayStatus: "starting", hostReconnectGraceExpiresAt: null },
  }),
  makeThreadListEntry({
    id: "thr_home_automations",
    title: "Wire up automations CLI",
    titleFallback: "Wire up automations CLI",
    latestAttentionAt: 850,
  }),
  makeThreadListEntry({
    id: "thr_home_daemon",
    projectId: PROJECT_IDS.pierre,
    providerId: STORY_CURSOR_PROVIDER_ID,
    title: "Debug host daemon reconnect",
    titleFallback: "Debug host daemon reconnect",
    latestAttentionAt: 840,
  }),
  makeThreadListEntry({
    id: "thr_home_theme",
    title: "Ship theme preview panel",
    titleFallback: "Ship theme preview panel",
    latestAttentionAt: 830,
  }),
  makeThreadListEntry({
    id: "thr_home_sidebar",
    providerId: STORY_CLAUDE_CODE_PROVIDER_ID,
    title: "Trim sidebar re-renders",
    titleFallback: "Trim sidebar re-renders",
    latestAttentionAt: 820,
  }),
  makeThreadListEntry({
    id: "thr_home_release",
    title: "Draft release notes",
    titleFallback: "Draft release notes",
    latestAttentionAt: 810,
  }),
  makeThreadListEntry({
    id: "thr_home_keyboard",
    projectId: PROJECT_IDS.pierre,
    title: "Fix mobile keyboard inset",
    titleFallback: "Fix mobile keyboard inset",
    latestAttentionAt: 800,
  }),
];

export const MOBILE_RECENTS_VISIBILITY_CLASS = "bb-mobile-story-stage";

const noop = () => {};

const storyEnvironment: NewThreadEnvironmentConfig = {
  value: `host:${HOST_IDS.local}:local`,
  onChange: noop,
  sources: STORY_PROJECT_SOURCES,
  host: makeHost({ id: HOST_IDS.local }),
  isLocal: true,
};

const storyBranch: NewThreadBranchConfig = {
  value: null,
  currentBranch: "main",
  isNew: false,
  options: STORY_BRANCH_OPTIONS,
  loading: false,
  currentOptionLabel: "Current: main",
  placeholder: "Current checkout",
  triggerLabel: "Current (main)",
  triggerTitle: "Current: main",
  onChange: noop,
  onClear: noop,
  onCreate: noop,
};

const storyWorktree: NewThreadWorktreeConfig = {
  options: STORY_WORKTREE_OPTIONS,
  value: null,
  onChange: noop,
};

const storyProject: NewThreadProjectConfig = {
  projects: STORY_PROJECTS,
  value: PROJECT_IDS.bb,
  onChange: noop,
};

const storyModeConfig = {
  environment: storyEnvironment,
  branch: storyBranch,
  worktree: storyWorktree,
  permission: {
    value: "auto",
    options: [
      { value: "accept-edits", label: "Accept Edits" },
      { value: "auto", label: "Approve for me" },
      { value: "full", label: "Full Access", tone: "warning" },
    ],
    onChange: noop,
    supported: true,
  },
} satisfies NewThreadModeConfig;

const storyExecution = makeExecutionControlsProps();

export function MobileRecentsVisibilityStyle() {
  return (
    <style>{`
      @media (min-width: 768px) {
        .${MOBILE_RECENTS_VISIBILITY_CLASS} [data-root-compose-mobile-recents] {
          display: block;
        }
      }
    `}</style>
  );
}

export function StoryComposer() {
  const [value, setValue] = useState("");
  const [mentionRanges, setMentionRanges] = useState<PromptTextMention[]>([]);
  return (
    <ModelPickerStoryQueryProvider>
      <NewThreadPromptBoxUI
        id="story-compact-home-composer"
        value={value}
        mentionRanges={mentionRanges}
        onChange={(nextValue, nextMentionRanges) => {
          setValue(nextValue);
          setMentionRanges(nextMentionRanges);
        }}
        onSubmit={noop}
        isSubmitting={false}
        disabled={false}
        history={{
          currentDraft: { text: "", mentions: [], attachments: [] },
          entries: [],
          onSelectEntry: noop,
        }}
        typeahead={makeTypeaheadConfig()}
        attachments={makeAttachmentsConfig()}
        modeConfig={storyModeConfig}
        project={storyProject}
        execution={storyExecution}
      />
    </ModelPickerStoryQueryProvider>
  );
}

export function HomeRecents({ threads }: { threads: ThreadListEntry[] }) {
  return (
    <RootComposeMobileRecents
      highlightedThreadId={null}
      projectNamesById={projectNamesById}
      providersById={STORY_PROVIDERS_BY_ID}
      showCreatingRow={false}
      threads={threads}
    />
  );
}

export function CompactHomePage({
  threads = HOME_THREADS,
}: {
  threads?: ThreadListEntry[];
}) {
  return (
    <RootComposeCompactHome composer={<StoryComposer />}>
      <HomeRecents threads={threads} />
    </RootComposeCompactHome>
  );
}

export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${MOBILE_RECENTS_VISIBILITY_CLASS} flex h-[852px] w-[393px] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background`}
    >
      <MobileRecentsVisibilityStyle />
      {children}
    </div>
  );
}
