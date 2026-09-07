import { useState } from "react";
import type { PromptMentionResource, PromptTextMention } from "@bb/domain";
import type { UploadedPromptAttachment } from "@bb/server-contract";
import { ExecutionControls } from "@/components/promptbox/ExecutionControls";
import type {
  PromptMentionSuggestion,
  ProviderCommandSuggestion,
} from "@bb/client-core";
import {
  PromptBoxInternal,
  type HistoryConfig,
  type PromptBoxAction,
  type PromptBoxSubmissionConfig,
  type PromptVoiceConfig,
} from "@/components/promptbox/PromptBoxInternal";
import {
  AUTOMATION_PROMPT_ACTION,
  CREATE_PLUGIN_PROMPT_ACTION,
} from "@/components/promptbox/PromptBoxActionsMenu";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  makeAttachmentsConfig as makeAttachments,
  makeExecutionControlsProps,
  makeTypeaheadConfig as makeTypeahead,
} from "../../../.ladle/story-fixtures";
import { orderPromptMentionSuggestions } from "@/hooks/promptMentionCandidates";

export default {
  title: "promptbox/Prompt Box Internal",
};

const noop = () => {};

const mockExecution = makeExecutionControlsProps();
const promptActions: readonly PromptBoxAction[] = [
  { kind: "skills", text: "/" },
  {
    kind: "plan",
    command: { trigger: "/", name: "plan", trailingText: " " },
    text: "/plan ",
  },
  {
    kind: "goal",
    command: { trigger: "/", name: "goal", trailingText: " " },
    text: "/goal ",
  },
  AUTOMATION_PROMPT_ACTION,
  CREATE_PLUGIN_PROMPT_ACTION,
];

const idleVoice: PromptVoiceConfig = {
  state: "idle",
  isSupported: true,
  stream: null,
  start: noop,
  stop: noop,
  cancel: noop,
};

const recordingVoice: PromptVoiceConfig = {
  ...idleVoice,
  state: "recording",
};

const transcribingVoice: PromptVoiceConfig = {
  ...idleVoice,
  state: "transcribing",
};

const mockAttachments: UploadedPromptAttachment[] = [
  {
    type: "localImage",
    path: "https://placecats.com/300/200",
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 124_000,
  },
  {
    type: "localImage",
    path: "https://placecats.com/320/180",
    name: "design-mock.png",
    mimeType: "image/png",
    sizeBytes: 96_000,
  },
  {
    type: "localFile",
    path: "/uploads/diff.patch",
    name: "diff.patch",
    mimeType: "text/x-patch",
    sizeBytes: 8_400,
  },
];

const historyEntries = [
  {
    text: "fix the timeline pagination bug",
    mentions: [],
    attachments: [],
  },
  { text: "review thread workspace", mentions: [], attachments: [] },
];

const baseHistory: HistoryConfig = {
  currentDraft: { text: "", mentions: [], attachments: [] },
  entries: historyEntries,
  onSelectEntry: noop,
};

const PROMPT_MENTION_LIMIT = 8;

function workspaceFile(path: string): PromptMentionSuggestion {
  return {
    kind: "path",
    source: "workspace",
    entryKind: "file",
    path,
    name: path.split("/").at(-1) ?? path,
    replacement: path,
  };
}

function workspaceFolder(path: string): PromptMentionSuggestion {
  return {
    kind: "path",
    source: "workspace",
    entryKind: "directory",
    path,
    name: path.split("/").at(-1) ?? path,
    replacement: `${path}/`,
  };
}

function storageFile(path: string): PromptMentionSuggestion {
  return {
    kind: "path",
    source: "thread-storage",
    entryKind: "file",
    path,
    name: path.split("/").at(-1) ?? path,
    replacement: `thread-storage:${path}`,
  };
}

const liveMentionThreads: PromptMentionSuggestion[] = [
  {
    kind: "thread",
    path: "thread:thr_qfk8ksbxkk",
    replacement: "thread:thr_qfk8ksbxkk",
    projectId: "proj_promptbox",
    threadId: "thr_qfk8ksbxkk",
    title: "Wire up promptbox stories",
  },
  {
    kind: "thread",
    path: "thread:thr_mgr_kj4n2x",
    replacement: "thread:thr_mgr_kj4n2x",
    projectId: "proj_promptbox",
    threadId: "thr_mgr_kj4n2x",
    title: "Parent: app/timeline cleanup sprint",
  },
  {
    kind: "thread",
    path: "thread:thr_4hge9xn14m",
    replacement: "thread:thr_4hge9xn14m",
    projectId: "proj_promptbox",
    threadId: "thr_4hge9xn14m",
    title: "Review flow cleanup",
  },
];

const liveMentionPaths: PromptMentionSuggestion[] = [
  workspaceFile("apps/app/src/components/promptbox/PromptBoxInternal.tsx"),
  workspaceFile("apps/app/src/components/promptbox/FollowUpPromptBox.tsx"),
  workspaceFile("apps/app/src/components/promptbox/NewThreadPromptBox.tsx"),
  workspaceFile("apps/app/src/hooks/usePromptMentions.ts"),
  workspaceFolder("apps/app/src/components/promptbox/mentions"),
  storageFile("notes/status.md"),
];

const liveCommandSuggestions: ProviderCommandSuggestion[] = [
  {
    kind: "command",
    name: "moss-hardening-review",
    source: "skill",
    origin: "user",
    description: "Run a hardening review for Moss persistence paths",
    argumentHint: "[branch | staged] [base=<ref>]",
  },
  {
    kind: "command",
    name: "github:gh-fix-ci",
    source: "skill",
    origin: "user",
    description: "Debug failing GitHub Actions checks",
    argumentHint: null,
  },
  {
    kind: "command",
    name: "browser:control-in-app-browser",
    source: "skill",
    origin: "user",
    description: "Open and inspect local web targets",
    argumentHint: null,
  },
  {
    kind: "command",
    name: "frontend:component",
    source: "command",
    origin: "project",
    description: "Create or update a project component",
    argumentHint: "$ARGUMENTS",
  },
  {
    kind: "command",
    name: "review",
    source: "command",
    origin: "user",
    description: "Review local changes",
    argumentHint: "[target]",
  },
];

function suggestionHaystack(suggestion: PromptMentionSuggestion): string {
  if (suggestion.kind === "thread") {
    return `${suggestion.title ?? ""} ${suggestion.threadId}`.toLowerCase();
  }
  if (suggestion.kind === "plugin") {
    return `${suggestion.title} ${suggestion.subtitle ?? ""}`.toLowerCase();
  }
  return `${suggestion.path} ${suggestion.name}`.toLowerCase();
}

function filterLiveMentions(query: string): PromptMentionSuggestion[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const matches = (suggestion: PromptMentionSuggestion) =>
    suggestionHaystack(suggestion).includes(needle);
  return [
    ...liveMentionThreads.filter(matches),
    ...liveMentionPaths.filter(matches),
  ].slice(0, PROMPT_MENTION_LIMIT);
}

function commandHaystack(suggestion: ProviderCommandSuggestion): string {
  return [
    suggestion.name,
    suggestion.description ?? "",
    suggestion.argumentHint ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

function filterLiveCommands(query: string): ProviderCommandSuggestion[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return liveCommandSuggestions;
  return liveCommandSuggestions.filter((suggestion) =>
    commandHaystack(suggestion).includes(needle),
  );
}

interface StoryMentionArgs {
  resource: PromptMentionResource;
  text: string;
  token: string;
}

interface StoryMentionSpec {
  token: string;
  resource: PromptMentionResource;
}

interface PromptPillsFixture {
  text: string;
  mentions: PromptTextMention[];
}

function storyMention({
  resource,
  text,
  token,
}: StoryMentionArgs): PromptTextMention {
  const start = text.indexOf(token);
  if (start < 0) {
    throw new Error(`Missing story mention token: ${token}`);
  }
  return {
    start,
    end: start + token.length,
    resource,
  };
}

function buildPromptPillsFixture(
  text: string,
  mentionSpecs: readonly StoryMentionSpec[],
): PromptPillsFixture {
  return {
    text,
    mentions: mentionSpecs.map((spec) =>
      storyMention({ resource: spec.resource, text, token: spec.token }),
    ),
  };
}

function useControlledValue(
  initial: string,
  initialMentions: PromptTextMention[] = [],
) {
  const [value, setValue] = useState(initial);
  const [mentionRanges, setMentionRanges] = useState(initialMentions);
  const onChange = (nextValue: string, nextMentions: PromptTextMention[]) => {
    setValue(nextValue);
    setMentionRanges(nextMentions);
  };
  return { value, mentionRanges, onChange };
}

function PromptBoxStoryInstance({
  fixture,
  placeholder = "Review the prompt pills",
}: {
  fixture: PromptPillsFixture;
  placeholder?: string;
}) {
  const { value, mentionRanges, onChange } = useControlledValue(
    fixture.text,
    fixture.mentions,
  );
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      placeholder={placeholder}
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function makeSubmission(
  overrides?: Partial<PromptBoxSubmissionConfig>,
): PromptBoxSubmissionConfig {
  return {
    isSubmitting: false,
    disabled: false,
    title: "Submit (Enter)",
    ...overrides,
  };
}

const mixedPromptPillsFixture = buildPromptPillsFixture(
  [
    "Use @apps/app/src/components/promptbox/PromptBoxInternal.tsx with",
    "@apps/app/src/components/promptbox/mentions/ and @thread-storage:notes/status.md;",
    "then ask @thread:thr_prompt_pills before running /github:gh-fix-ci or /frontend:component.",
  ].join(" "),
  [
    {
      token: "@apps/app/src/components/promptbox/PromptBoxInternal.tsx",
      resource: {
        kind: "path",
        source: "workspace",
        entryKind: "file",
        path: "apps/app/src/components/promptbox/PromptBoxInternal.tsx",
        label: "PromptBoxInternal.tsx",
      },
    },
    {
      token: "@apps/app/src/components/promptbox/mentions/",
      resource: {
        kind: "path",
        source: "workspace",
        entryKind: "directory",
        path: "apps/app/src/components/promptbox/mentions",
        label: "mentions",
      },
    },
    {
      token: "@thread-storage:notes/status.md",
      resource: {
        kind: "path",
        source: "thread-storage",
        entryKind: "file",
        path: "notes/status.md",
        label: "status.md",
      },
    },
    {
      token: "@thread:thr_prompt_pills",
      resource: {
        kind: "thread",
        projectId: "proj_promptbox",
        threadId: "thr_prompt_pills",
        label: "Prompt pills QA",
      },
    },
    {
      token: "/github:gh-fix-ci",
      resource: {
        kind: "command",
        trigger: "/",
        name: "github:gh-fix-ci",
        source: "skill",
        origin: "user",
        label: "github:gh-fix-ci",
        argumentHint: null,
      },
    },
    {
      token: "/frontend:component",
      resource: {
        kind: "command",
        trigger: "/",
        name: "frontend:component",
        source: "command",
        origin: "project",
        label: "frontend:component",
        argumentHint: "$ARGUMENTS",
      },
    },
  ],
);

const pathPromptPillsFixture = buildPromptPillsFixture(
  [
    "Workspace file @apps/app/src/components/promptbox/PromptBoxInternal.tsx",
    "workspace folder @apps/app/src/components/promptbox/mentions/",
    "and thread storage @thread-storage:runtime-attachments/summary.json.",
  ].join(" "),
  [
    {
      token: "@apps/app/src/components/promptbox/PromptBoxInternal.tsx",
      resource: {
        kind: "path",
        source: "workspace",
        entryKind: "file",
        path: "apps/app/src/components/promptbox/PromptBoxInternal.tsx",
        label: "PromptBoxInternal.tsx",
      },
    },
    {
      token: "@apps/app/src/components/promptbox/mentions/",
      resource: {
        kind: "path",
        source: "workspace",
        entryKind: "directory",
        path: "apps/app/src/components/promptbox/mentions",
        label: "mentions",
      },
    },
    {
      token: "@thread-storage:runtime-attachments/summary.json",
      resource: {
        kind: "path",
        source: "thread-storage",
        entryKind: "file",
        path: "runtime-attachments/summary.json",
        label: "summary.json",
      },
    },
  ],
);

const threadPromptPillsFixture = buildPromptPillsFixture(
  "Compare @thread:thr_prompt_pills with @thread:thr_parent_review.",
  [
    {
      token: "@thread:thr_prompt_pills",
      resource: {
        kind: "thread",
        projectId: "proj_promptbox",
        threadId: "thr_prompt_pills",
        label: "Prompt pills QA",
      },
    },
    {
      token: "@thread:thr_parent_review",
      resource: {
        kind: "thread",
        threadId: "thr_parent_review",
        label: "Parent review thread with a longer title",
      },
    },
  ],
);

const commandPromptPillsFixture = buildPromptPillsFixture(
  "Try /github:gh-fix-ci /browser:control-in-app-browser /frontend:component and /review.",
  [
    {
      token: "/github:gh-fix-ci",
      resource: {
        kind: "command",
        trigger: "/",
        name: "github:gh-fix-ci",
        source: "skill",
        origin: "user",
        label: "github:gh-fix-ci",
        argumentHint: null,
      },
    },
    {
      token: "/browser:control-in-app-browser",
      resource: {
        kind: "command",
        trigger: "/",
        name: "browser:control-in-app-browser",
        source: "skill",
        origin: "user",
        label: "browser:control-in-app-browser",
        argumentHint: null,
      },
    },
    {
      token: "/frontend:component",
      resource: {
        kind: "command",
        trigger: "/",
        name: "frontend:component",
        source: "command",
        origin: "project",
        label: "frontend:component",
        argumentHint: "$ARGUMENTS",
      },
    },
    {
      token: "/review",
      resource: {
        kind: "command",
        trigger: "/",
        name: "review",
        source: "command",
        origin: "user",
        label: "review",
        argumentHint: "[target]",
      },
    },
  ],
);

const skillArgumentHintFixture = buildPromptPillsFixture(
  "/moss-hardening-review ",
  [
    {
      token: "/moss-hardening-review",
      resource: {
        kind: "command",
        trigger: "/",
        name: "moss-hardening-review",
        source: "skill",
        origin: "user",
        label: "moss-hardening-review",
        argumentHint: "[branch | staged] [base=<ref>]",
      },
    },
  ],
);

const projectCommandArgumentHintFixture = buildPromptPillsFixture(
  "/frontend:component ",
  [
    {
      token: "/frontend:component",
      resource: {
        kind: "command",
        trigger: "/",
        name: "frontend:component",
        source: "command",
        origin: "project",
        label: "frontend:component",
        argumentHint: "$ARGUMENTS",
      },
    },
  ],
);

const planGoalCommandPillsFixture = buildPromptPillsFixture(
  "/plan clean up unused worktrees and /goal keep the review focused.",
  [
    {
      token: "/plan",
      resource: {
        kind: "command",
        trigger: "/",
        name: "plan",
        source: "command",
        origin: "user",
        label: "plan",
        argumentHint: null,
      },
    },
    {
      token: "/goal",
      resource: {
        kind: "command",
        trigger: "/",
        name: "goal",
        source: "command",
        origin: "user",
        label: "goal",
        argumentHint: null,
      },
    },
  ],
);

function DefaultRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function WithAttachmentsRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "Take a look at this screenshot and the diff.",
  );
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments({ items: mockAttachments })}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function WithBlockquoteRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "> First we backfill the new column with a default value at the server\n> boundary, then flip reads once every row is populated.\nWhich phase is safe to deploy on a Friday?",
  );
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function WithMentionsRow() {
  const initialValue =
    "Ask @thread:thr_parent to inspect @apps/app/src/components/promptbox/PromptBoxInternal.tsx.";
  const { value, mentionRanges, onChange } = useControlledValue(initialValue, [
    storyMention({
      text: initialValue,
      token: "@thread:thr_parent",
      resource: {
        kind: "thread",
        threadId: "thr_parent",
        label: "Prompt UX thread",
      },
    }),
    storyMention({
      text: initialValue,
      token: "@apps/app/src/components/promptbox/PromptBoxInternal.tsx",
      resource: {
        kind: "path",
        source: "workspace",
        entryKind: "file",
        path: "apps/app/src/components/promptbox/PromptBoxInternal.tsx",
        label: "PromptBoxInternal.tsx",
      },
    }),
  ]);
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function WithSkillPillRow() {
  const argumentHint = "[branch | staged] [base=<ref>]";
  const initialValue = "/moss-hardening-review ";
  const { value, mentionRanges, onChange } = useControlledValue(initialValue, [
    storyMention({
      text: initialValue,
      token: "/moss-hardening-review",
      resource: {
        kind: "command",
        trigger: "/",
        name: "moss-hardening-review",
        source: "skill",
        origin: "user",
        label: "moss-hardening-review",
        argumentHint,
      },
    }),
  ]);
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function WithLiveSkillsRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  const [query, setQuery] = useState<string | null>(null);
  const suggestions =
    query === null ? [] : filterLiveCommands(query).slice(0, 4);
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      placeholder="Type / to insert a skill or command"
      typeahead={makeTypeahead(
        {},
        {
          trigger: "/",
          suggestions,
          isLoading: false,
          isError: false,
          hasMore: query !== null && filterLiveCommands(query).length > 4,
          isLoadingMore: false,
          loadMore: noop,
          onQueryChange: setQuery,
        },
      )}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function WithPromptActionsRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      placeholder="Use the prompt actions button"
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      promptActions={promptActions}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function WithLiveMentionsRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  const [query, setQuery] = useState<string | null>(null);
  const suggestions = filterLiveMentions(query ?? "");
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      placeholder="Type @ to mention a file, folder, section, or thread"
      typeahead={makeTypeahead({
        results: orderPromptMentionSuggestions({
          query: query ?? "",
          suggestions,
        }),
        onQueryChange: setQuery,
      })}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function SubmittingRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "Review thread workspace.",
  );
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission({
        isSubmitting: true,
        disabled: true,
        title: "Submitting...",
      })}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function RunningWithStopRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      placeholder="Ask for a follow-up. @ to mention files, folders, sections, or threads"
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission({
        isRunning: true,
        onStop: noop,
        title: "Queue follow-up (Enter)",
      })}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function RecordingActiveRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={recordingVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function RecordingWithExistingDraftRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "Keep this existing prompt visible while I dictate the rest of the request.",
  );
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={recordingVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function RecordingProcessingRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentionRanges}
      onChange={onChange}
      onSubmit={noop}
      typeahead={makeTypeahead()}
      mentionMenuPlacement="bottom"
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={transcribingVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

export function AllPromptPills() {
  return (
    <StoryCard>
      <StoryRow
        label="mixed pills"
        hint="file, folder, section, thread storage, thread, skill, and project command in one prompt"
      >
        <PromptBoxStoryInstance fixture={mixedPromptPillsFixture} />
      </StoryRow>
      <StoryRow
        label="path pills"
        hint="workspace file, workspace folder, and thread-storage file"
      >
        <PromptBoxStoryInstance fixture={pathPromptPillsFixture} />
      </StoryRow>
      <StoryRow
        label="thread pills"
        hint="thread mention pills with short and long labels"
      >
        <PromptBoxStoryInstance fixture={threadPromptPillsFixture} />
      </StoryRow>
      <StoryRow
        label="command pills"
        hint="skill commands, project commands, and user commands"
      >
        <PromptBoxStoryInstance fixture={commandPromptPillsFixture} />
      </StoryRow>
      <StoryRow
        label="skill arg metadata"
        hint="skill pill with argument hint metadata but no prompt placeholder text"
      >
        <PromptBoxStoryInstance fixture={skillArgumentHintFixture} />
      </StoryRow>
      <StoryRow
        label="project arg metadata"
        hint="project command pill with argument hint metadata but no prompt placeholder text"
      >
        <PromptBoxStoryInstance fixture={projectCommandArgumentHintFixture} />
      </StoryRow>
    </StoryCard>
  );
}

export function PromptActions() {
  return (
    <StoryCard>
      <StoryRow
        label="action menu"
        hint="click the + button at the far-left of the prompt controls"
      >
        <WithPromptActionsRow />
      </StoryRow>
      <StoryRow
        label="plan and goal pills"
        hint="/plan and /goal render as command pills after insertion"
      >
        <PromptBoxStoryInstance
          fixture={planGoalCommandPillsFixture}
          placeholder="Plan or goal command pill"
        />
      </StoryRow>
    </StoryCard>
  );
}

export function VoiceActionRowRecommendation() {
  return (
    <StoryCard>
      <StoryRow
        label="recording with existing draft"
        hint="The editor stays visible while the bottom action row becomes cancel, waveform, and confirm."
      >
        <div className="w-full max-w-4xl">
          <RecordingWithExistingDraftRow />
        </div>
      </StoryRow>
    </StoryCard>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="default" hint="empty draft, no in-flight state">
        <DefaultRow />
      </StoryRow>
      <StoryRow
        label="with attachments"
        hint="image + file attached to the draft"
      >
        <WithAttachmentsRow />
      </StoryRow>
      <StoryRow
        label="with mentions"
        hint="thread and file mentions render as editor pills"
      >
        <WithMentionsRow />
      </StoryRow>
      <StoryRow
        label="with blockquote"
        hint="'Add to chat' inserts a > quote block; reply goes on the line below"
      >
        <WithBlockquoteRow />
      </StoryRow>
      <StoryRow
        label="selected skill"
        hint="skill command pill without SKILL.md argument hint placeholder text"
      >
        <WithSkillPillRow />
      </StoryRow>
      <StoryRow
        label="live skills"
        hint="type / then select a skill; argument hints stay out of the prompt text"
      >
        <WithLiveSkillsRow />
      </StoryRow>
      <StoryRow
        label="prompt actions"
        hint="the + action menu sits at the far-left of the prompt controls"
      >
        <WithPromptActionsRow />
      </StoryRow>
      <StoryRow
        label="live mentions"
        hint="type @ then a query (e.g. @prompt, @timeline) — menu filters live"
      >
        <WithLiveMentionsRow />
      </StoryRow>
      <StoryRow label="submitting" hint="mutation in flight">
        <SubmittingRow />
      </StoryRow>
      <StoryRow
        label="running with stop"
        hint="isRunning=true → stop button shown"
      >
        <RunningWithStopRow />
      </StoryRow>
      <StoryRow
        label="recording active"
        hint="voice.state === 'recording' → live waveform + cancel"
      >
        <RecordingActiveRow />
      </StoryRow>
      <StoryRow
        label="recording processing"
        hint="voice.state === 'transcribing' → spinner + cancel"
      >
        <RecordingProcessingRow />
      </StoryRow>
    </StoryCard>
  );
}
