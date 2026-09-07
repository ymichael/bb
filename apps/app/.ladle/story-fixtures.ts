import type {
  Host,
  ProjectSource,
  ProviderInfo,
  ReasoningLevel,
  Thread,
  WorkspaceStatus,
} from "@bb/domain";
import type {
  ProviderCliKey,
  ProviderCliStatus,
} from "@bb/host-daemon-contract";
import type { ProjectResponse } from "@bb/server-contract";
import { EMPTY_ORDERED_MENTION_SUGGESTIONS } from "@bb/client-core";
import {
  makeEnvironment as makeEnvironmentFixture,
  makeHost as makeHostFixture,
  makeProviderInfo,
  makeThread as makeThreadFixture,
  makeThreadListEntry as makeThreadListEntryFixture,
} from "@bb/test-helpers/domain-fixtures";
import { makeProjectResponse } from "../src/test/fixtures/projects";
import { getProviderIconInfo } from "../src/lib/provider-icon";
import type { PickerOption } from "../src/components/pickers/OptionPicker";
import type { ModelPickerOption } from "../src/components/pickers/model-picker-option";
import type { ProjectSelectorOption } from "../src/components/pickers/ProjectSelector";
import type { ReuseThreadOption } from "../src/components/pickers/WorktreePicker";
import type { ExecutionControlsProps } from "../src/components/promptbox/ExecutionControls";
import {
  INERT_TYPEAHEAD_COMMAND_CONFIG,
  type AttachmentsConfig,
  type TypeaheadCommandConfig,
  type TypeaheadConfig,
  type TypeaheadMentionConfig,
} from "../src/components/promptbox/PromptBoxInternal";

const noop = () => {};

export const HOST_IDS = {
  local: "host_local",
  remote: "host_remote",
} as const;

export const HOST_NAMES = {
  local: "Michael's MacBook Pro",
  remote: "michael-build-box",
} as const;

export const PROJECT_IDS = {
  bb: "proj_bb",
  pierre: "proj_pierre",
  ingest: "proj_ingest_pipeline",
} as const;

export const PROJECT_NAMES = {
  bb: "bb",
  pierre: "pierre",
  ingest: "ingest-pipeline",
} as const;

export const BRANCH_NAMES = {
  default: "main",
  feature: "feat/sidebar-rail",
} as const;

export function makeTypeaheadConfig(
  mentionOverrides: Partial<TypeaheadMentionConfig> = {},
  commandOverrides: Partial<TypeaheadCommandConfig> = {},
): TypeaheadConfig {
  const mention: TypeaheadMentionConfig = {
    results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
    isLoading: false,
    isError: false,
    onQueryChange: noop,
    ...mentionOverrides,
  };
  return {
    mention,
    command: {
      ...INERT_TYPEAHEAD_COMMAND_CONFIG,
      ...commandOverrides,
    },
  };
}

export function makeAttachmentsConfig(
  overrides: Partial<AttachmentsConfig> = {},
): AttachmentsConfig {
  const base: AttachmentsConfig = {
    items: [],
    projectId: PROJECT_IDS.bb,
    onAttachFiles: noop,
    onRemove: noop,
    isAttaching: false,
    error: null,
  };
  return { ...base, ...overrides };
}

function storyProviderIcon(providerId: string, glyph: string) {
  return getProviderIconInfo(providerId, { logoUrl: null, icon: { glyph } })
    ?.icon;
}

function makeStoryProvider(
  id: string,
  displayName: string,
  glyph: string,
): ProviderInfo {
  return makeProviderInfo({
    id,
    displayName,
    logoUrl: null,
    icon: { glyph },
  });
}

const storyCodexProvider = makeStoryProvider("codex", "Codex", "Code");
const storyClaudeCodeProvider = makeStoryProvider(
  "claude-code",
  "Claude Code",
  "Brain",
);
const storyCursorProvider = makeStoryProvider("acp-cursor", "Cursor", "Zap");
export const STORY_CLAUDE_CODE_PROVIDER_ID = storyClaudeCodeProvider.id;
export const STORY_CURSOR_PROVIDER_ID = storyCursorProvider.id;

export const STORY_PROVIDERS_BY_ID: ReadonlyMap<string, ProviderInfo> = new Map(
  [storyCodexProvider, storyClaudeCodeProvider, storyCursorProvider].map(
    (provider) => [provider.id, provider],
  ),
);

export const STORY_PROVIDER_OPTIONS: readonly PickerOption<string>[] = [
  { value: "codex", label: "Codex", icon: storyProviderIcon("codex", "Code") },
  {
    value: "claude-code",
    label: "Claude Code",
    icon: storyProviderIcon("claude-code", "Sparkles"),
  },
  { value: "pi", label: "Pi", icon: storyProviderIcon("pi", "Zap") },
];

export const STORY_CODEX_MODELS: readonly PickerOption<string>[] = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { value: "gpt-5.2", label: "GPT-5.2" },
];

export const STORY_CLAUDE_CODE_MODELS: readonly PickerOption<string>[] = [
  { value: "claude-fable-5", label: "Claude Fable 5" },
  { value: "claude-opus-4-8[1m]", label: "Claude Opus 4.8 (1M)" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
];

export const STORY_CLAUDE_CODE_MORE_MODELS: readonly PickerOption<string>[] = [
  { value: "claude-sonnet-4-6[1m]", label: "Claude Sonnet 4.6 (1M)" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export const STORY_PI_MODELS: readonly ModelPickerOption[] = [
  {
    value: "openai-codex/gpt-5.5",
    label: "GPT-5.5",
    routeProviderId: "openai-codex",
  },
  {
    value: "openai-codex/gpt-5.4",
    label: "GPT-5.4",
    routeProviderId: "openai-codex",
  },
  {
    value: "openai-codex/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    routeProviderId: "openai-codex",
  },
  {
    value: "openai-codex/gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    routeProviderId: "openai-codex",
  },
  {
    value: "openai/gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    routeProviderId: "openai",
  },
  {
    value: "openai-codex/gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    routeProviderId: "openai-codex",
  },
  {
    value: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    routeProviderId: "anthropic",
  },
  {
    value: "anthropic/claude-opus-4-8",
    label: "Claude Opus 4.8",
    routeProviderId: "anthropic",
  },
  {
    value: "anthropic/claude-opus-4-7",
    label: "Claude Opus 4.7",
    routeProviderId: "anthropic",
  },
];

export const STORY_CODEX_REASONING: readonly PickerOption<ReasoningLevel>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

export const STORY_CLAUDE_REASONING: readonly PickerOption<ReasoningLevel>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
];

export const STORY_SERVICE_TIER_SUPPORT: Record<string, boolean> = {
  codex: true,
  "claude-code": false,
  pi: false,
};

export const STORY_PROJECT_SOURCES: readonly ProjectSource[] = [
  {
    id: "src_local",
    projectId: PROJECT_IDS.bb,
    type: "local_path",
    hostId: HOST_IDS.local,
    path: "/Users/michael/Projects/bb",
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "src_remote",
    projectId: PROJECT_IDS.bb,
    type: "local_path",
    hostId: HOST_IDS.remote,
    path: "/home/michael/bb",
    isDefault: false,
    createdAt: 0,
    updatedAt: 0,
  },
];

export const STORY_BRANCH_OPTIONS: readonly string[] = [
  "main",
  "release/1.2",
  "feat/sidebar-rail",
  "fix/timeline-pagination",
  "bb/refactor-project-creation-thr_jj65bdsiwa",
];

export const STORY_WORKTREE_OPTIONS: readonly ReuseThreadOption[] = [
  {
    environmentId: "env_review_flow",
    branchName: "bb/review-flow-thr_4hge9xn14m",
    name: null,
    threads: [
      { id: "thr_review", title: "Review flow cleanup" },
      { id: "thr_tests", title: "Backfill promptbox tests" },
    ],
  },
  {
    environmentId: "env_timeline",
    branchName: "bb/timeline-pagination-thr_qfk8ksbxkk",
    name: "Timeline workspace",
    threads: [{ id: "thr_timeline", title: "Timeline pagination" }],
  },
];

export const STORY_PROJECTS: readonly ProjectSelectorOption[] = [
  { id: PROJECT_IDS.bb, name: PROJECT_NAMES.bb },
  { id: PROJECT_IDS.pierre, name: PROJECT_NAMES.pierre },
];

export function makeExecutionControlsProps(
  overrides: Partial<ExecutionControlsProps> = {},
): ExecutionControlsProps {
  const base: ExecutionControlsProps = {
    provider: {
      options: STORY_PROVIDER_OPTIONS,
      selectedId: "codex",
      onChange: noop,
      hasMultiple: true,
    },
    model: {
      active: { model: "gpt-5.5" },
      selected: "gpt-5.5",
      options: STORY_CODEX_MODELS,
      moreOptions: [],
      isLoading: false,
      loadFailed: false,
      onChange: noop,
    },
    serviceTier: {
      value: undefined,
      onChange: noop,
      supported: true,
      supportByProvider: STORY_SERVICE_TIER_SUPPORT,
    },
    reasoning: {
      value: "medium",
      options: STORY_CODEX_REASONING,
      onChange: noop,
    },
  };
  return { ...base, ...overrides };
}

export function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: "thr_demo",
    projectId: PROJECT_IDS.bb,
    environmentId: "env_demo",
    title: "Audit recurring permission failures",
    titleFallback: "Audit recurring permission failures",
    ...overrides,
  });
}

export function makeThreadListEntry(
  overrides: Parameters<typeof makeThreadListEntryFixture>[0] = {},
) {
  return makeThreadListEntryFixture({
    id: "thr_demo",
    projectId: PROJECT_IDS.bb,
    title: "Audit recurring permission failures",
    titleFallback: "Audit recurring permission failures",
    ...overrides,
  });
}

export function makeProject(
  overrides: Partial<ProjectResponse> = {},
): ProjectResponse {
  return makeProjectResponse({
    id: PROJECT_IDS.bb,
    name: PROJECT_NAMES.bb,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

export function makeHost(overrides: Partial<Host> = {}): Host {
  return makeHostFixture({
    id: HOST_IDS.local,
    name: HOST_NAMES.local,
    lastSeenAt: 100,
    updatedAt: 100,
    ...overrides,
  });
}

export function makeProviderCliStatus(
  provider: ProviderCliKey,
  overrides: Partial<ProviderCliStatus> = {},
): ProviderCliStatus {
  const identity =
    provider === "codex"
      ? { displayName: "Codex", executableName: "codex" }
      : provider === "claude-code"
        ? { displayName: "Claude Code", executableName: "claude" }
        : { displayName: "Cursor", executableName: "agent" };
  return {
    displayName: identity.displayName,
    executableName: identity.executableName,
    executablePath: `/usr/local/bin/${identity.executableName}`,
    installed: true,
    installSource: "npmGlobal",
    currentVersion: "1.0.0",
    latestVersion: "1.0.0",
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
    ...overrides,
  };
}

export function makeEnvironment(
  overrides: Parameters<typeof makeEnvironmentFixture>[0] = {},
) {
  return makeEnvironmentFixture({
    id: "env_demo",
    projectId: PROJECT_IDS.bb,
    hostId: HOST_IDS.local,
    path: "/Users/michael/Projects/bb",
    branchName: BRANCH_NAMES.feature,
    baseBranch: BRANCH_NAMES.default,
    defaultBranch: BRANCH_NAMES.default,
    updatedAt: 100,
    ...overrides,
  });
}

export function makeWorkspaceStatus(
  overrides: Partial<WorkspaceStatus> = {},
): WorkspaceStatus {
  const base: WorkspaceStatus = {
    workingTree: {
      hasUncommittedChanges: false,
      state: "clean",
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
      files: [],
    },
    branch: {
      currentBranch: BRANCH_NAMES.feature,
      defaultBranch: BRANCH_NAMES.default,
    },
    checkout: {
      kind: "branch",
      branchName: BRANCH_NAMES.feature,
      headSha: null,
    },
    mergeBase: {
      mergeBaseBranch: BRANCH_NAMES.default,
      baseRef: null,
      aheadCount: 0,
      behindCount: 0,
      hasCommittedUnmergedChanges: false,
      commits: [],
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
      files: [],
    },
  };
  return { ...base, ...overrides };
}
