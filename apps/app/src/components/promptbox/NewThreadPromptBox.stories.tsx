import { useState } from "react";
import type { PermissionMode, PromptTextMention } from "@bb/domain";
import type { SystemExecutionOptionsModelLoadError } from "@bb/server-contract";
import {
  NewThreadPromptBoxUI,
  type NewThreadBranchConfig,
  type NewThreadEnvironmentConfig,
  type NewThreadModeConfig,
  type NewThreadProjectConfig,
  type NewThreadWorktreeConfig,
} from "@/components/promptbox/NewThreadPromptBox";
import type {
  HistoryConfig,
  PromptBoxAction,
} from "@/components/promptbox/PromptBoxInternal";
import {
  AUTOMATION_PROMPT_ACTION,
  CREATE_PLUGIN_PROMPT_ACTION,
} from "@/components/promptbox/PromptBoxActionsMenu";
import { ProviderCliVersionBanner } from "@/components/promptbox/banner/ProviderCliVersionBanner";
import type { PickerOption } from "@/components/pickers/OptionPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { ModelPickerStoryQueryProvider } from "../../../.ladle/model-picker-query-provider";
import {
  HOST_IDS,
  PROJECT_IDS,
  STORY_BRANCH_OPTIONS,
  STORY_CLAUDE_CODE_MORE_MODELS,
  STORY_PROJECTS,
  STORY_PROJECT_SOURCES,
  STORY_WORKTREE_OPTIONS,
  makeAttachmentsConfig as makeAttachments,
  makeExecutionControlsProps,
  makeTypeaheadConfig as makeTypeahead,
  makeHost,
} from "../../../.ladle/story-fixtures";

export default {
  title: "promptbox/New Thread Prompt Box",
};

const noop = () => {};

const baseExecution = makeExecutionControlsProps();
const codexModelLoadError = {
  providerId: "codex",
  code: "failed",
} satisfies SystemExecutionOptionsModelLoadError;
const codexMissingCliModelLoadError = {
  providerId: "codex",
  code: "missing_executable",
} satisfies SystemExecutionOptionsModelLoadError;

const baseEnvironment: NewThreadEnvironmentConfig = {
  value: `host:${HOST_IDS.local}:local`,
  onChange: noop,
  sources: STORY_PROJECT_SOURCES,
  host: makeHost({ id: HOST_IDS.local }),
  isLocal: true,
};

const baseBranch: NewThreadBranchConfig = {
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

const baseWorktree: NewThreadWorktreeConfig = {
  options: STORY_WORKTREE_OPTIONS,
  value: null,
  onChange: noop,
};

const baseProject: NewThreadProjectConfig = {
  projects: STORY_PROJECTS,
  value: PROJECT_IDS.bb,
  onChange: noop,
};

const permissionModeOptions: readonly PickerOption<PermissionMode>[] = [
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Approve for me" },
  { value: "full", label: "Full Access", tone: "warning" },
];

const basePermission = {
  value: "auto" as PermissionMode,
  options: permissionModeOptions,
  onChange: noop,
  supported: true,
};

const baseHistory: HistoryConfig = {
  currentDraft: { text: "", mentions: [], attachments: [] },
  entries: [
    { text: "review thread workspace", mentions: [], attachments: [] },
    {
      text: "investigate timeline pagination",
      mentions: [],
      attachments: [],
    },
  ],
  onSelectEntry: noop,
};

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

function useControlledValue(initial: string) {
  const [value, setValue] = useState(initial);
  const [mentionRanges, setMentionRanges] = useState<PromptTextMention[]>([]);
  const onChange = (nextValue: string, nextMentions: PromptTextMention[]) => {
    setValue(nextValue);
    setMentionRanges(nextMentions);
  };
  return { value, mentionRanges, onChange };
}

const baseModeConfig: NewThreadModeConfig = {
  environment: baseEnvironment,
  branch: baseBranch,
  worktree: baseWorktree,
  permission: basePermission,
};

interface PromptStageProps {
  children: React.ReactNode;
}

function PromptStage({ children }: PromptStageProps) {
  return <div className="mx-auto w-full max-w-[760px]">{children}</div>;
}

function DefaultRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-default"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled={false}
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        promptActions={promptActions}
        modeConfig={baseModeConfig}
        project={baseProject}
        execution={baseExecution}
      />
    </PromptStage>
  );
}

function SubmittingRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "Investigate the timeline pagination flicker.",
  );
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-submitting"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting
        disabled
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        modeConfig={baseModeConfig}
        project={baseProject}
        execution={baseExecution}
      />
    </PromptStage>
  );
}

function LoadingModelsRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "Investigate the timeline pagination flicker.",
  );
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-loading-models"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        modeConfig={baseModeConfig}
        project={baseProject}
        execution={{
          ...baseExecution,
          model: {
            ...baseExecution.model,
            active: null,
            selected: "",
            options: [],
            isLoading: true,
          },
        }}
      />
    </PromptStage>
  );
}

function ModelLoadFailedRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "Investigate the timeline pagination flicker.",
  );
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-model-load-failed"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        modeConfig={baseModeConfig}
        project={baseProject}
        execution={{
          ...baseExecution,
          model: {
            ...baseExecution.model,
            active: null,
            selected: "",
            options: [],
            isLoading: false,
            loadFailed: true,
            loadError: codexModelLoadError,
          },
        }}
      />
    </PromptStage>
  );
}

function UnsupportedCodexCliRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "Create an automation that checks the release until CI passes.",
  );
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-unsupported-codex-cli"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled
        autoFocus={false}
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        promptActions={promptActions}
        modeConfig={{
          ...baseModeConfig,
          banner: (
            <ProviderCliVersionBanner
              displayName="Codex"
              currentVersion="0.135.0"
              minimumSupportedVersion="0.136.0"
              canUpdate
              updating={false}
              onUpdate={noop}
            />
          ),
        }}
        project={baseProject}
        execution={baseExecution}
      />
    </PromptStage>
  );
}

function MissingCodexCliRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "Investigate the timeline pagination flicker.",
  );
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-missing-codex-cli"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        modeConfig={baseModeConfig}
        project={baseProject}
        execution={{
          ...baseExecution,
          model: {
            ...baseExecution.model,
            active: null,
            selected: "",
            options: [],
            isLoading: false,
            loadFailed: true,
            loadError: codexMissingCliModelLoadError,
          },
        }}
      />
    </PromptStage>
  );
}

function GenericModelRequestFailedRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "Investigate the timeline pagination flicker.",
  );
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-model-request-failed"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        modeConfig={baseModeConfig}
        project={baseProject}
        execution={{
          ...baseExecution,
          provider: {
            options: [],
            selectedId: "",
            onChange: noop,
            hasMultiple: false,
          },
          model: {
            ...baseExecution.model,
            active: null,
            selected: "",
            options: [],
            isLoading: false,
            loadFailed: true,
            loadError: null,
          },
        }}
      />
    </PromptStage>
  );
}

function NoModelsAvailableRow() {
  const { value, mentionRanges, onChange } = useControlledValue(
    "Investigate the timeline pagination flicker.",
  );
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-no-models"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        modeConfig={baseModeConfig}
        project={baseProject}
        execution={{
          ...baseExecution,
          model: {
            ...baseExecution.model,
            active: null,
            selected: "",
            options: [],
            isLoading: false,
            loadFailed: false,
            loadError: null,
          },
        }}
      />
    </PromptStage>
  );
}

function CustomModelAfterLoadErrorRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-custom-model-after-load-error"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled={false}
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        modeConfig={baseModeConfig}
        project={baseProject}
        execution={{
          ...baseExecution,
          model: {
            ...baseExecution.model,
            active: { model: "gpt-example-preview" },
            selected: "gpt-example-preview",
            options: [
              {
                value: "gpt-example-preview",
                label: "GPT Example Preview",
              },
            ],
            isLoading: false,
            loadFailed: true,
            loadError: codexModelLoadError,
          },
        }}
      />
    </PromptStage>
  );
}

function ClaudeProviderRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-claude"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled={false}
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        modeConfig={baseModeConfig}
        project={baseProject}
        execution={{
          ...baseExecution,
          provider: { ...baseExecution.provider, selectedId: "claude-code" },
          model: {
            active: { model: "claude-sonnet-5" },
            selected: "claude-sonnet-5",
            options: [
              { value: "claude-fable-5", label: "Claude Fable 5" },
              { value: "claude-opus-4-8[1m]", label: "Claude Opus 4.8 (1M)" },
              { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
            ],
            moreOptions: STORY_CLAUDE_CODE_MORE_MODELS,
            isLoading: false,
            loadFailed: false,
            onChange: noop,
          },
          serviceTier: { ...baseExecution.serviceTier!, supported: false },
        }}
      />
    </PromptStage>
  );
}

function FullAccessRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-full-access"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled={false}
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        modeConfig={{
          ...baseModeConfig,
          permission: { ...basePermission, value: "full" },
        }}
        project={baseProject}
        execution={baseExecution}
      />
    </PromptStage>
  );
}

function ProjectlessThreadRow() {
  const { value, mentionRanges, onChange } = useControlledValue("");
  return (
    <PromptStage>
      <NewThreadPromptBoxUI
        id="story-new-thread-projectless"
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={noop}
        isSubmitting={false}
        disabled={false}
        history={baseHistory}
        typeahead={makeTypeahead()}
        attachments={makeAttachments()}
        modeConfig={baseModeConfig}
        project={{
          ...baseProject,
          value: null,
          allowNoProject: true,
        }}
        execution={baseExecution}
      />
    </PromptStage>
  );
}

export function Overview() {
  return (
    <ModelPickerStoryQueryProvider>
      <StoryCard>
        <StoryRow
          label="default"
          hint="codex + workspace-write + local-direct env"
        >
          <DefaultRow />
        </StoryRow>
        <StoryRow label="submitting" hint="create-thread mutation in flight">
          <SubmittingRow />
        </StoryRow>
        <StoryRow
          label="loading models"
          hint="committed provider models are loading; submit is disabled"
        >
          <LoadingModelsRow />
        </StoryRow>
        <StoryRow
          label="provider failed"
          hint="provider-specific error; picker menu keeps provider tabs"
        >
          <ModelLoadFailedRow />
        </StoryRow>
        <StoryRow
          label="unsupported Codex CLI"
          hint="thread creation blocked; banner exposes Update action"
        >
          <UnsupportedCodexCliRow />
        </StoryRow>
        <StoryRow
          label="missing Codex CLI"
          hint="provider-specific install help; picker menu keeps provider tabs"
        >
          <MissingCodexCliRow />
        </StoryRow>
        <StoryRow
          label="request failed"
          hint="generic request failure; picker menu hides provider tabs"
        >
          <GenericModelRequestFailedRow />
        </StoryRow>
        <StoryRow
          label="no models"
          hint="successful empty model list; provider tabs remain available"
        >
          <NoModelsAvailableRow />
        </StoryRow>
        <StoryRow
          label="custom model after error"
          hint="provider failed, but configured custom model remains selectable"
        >
          <CustomModelAfterLoadErrorRow />
        </StoryRow>
        <StoryRow label="claude-code provider" hint="no fast mode toggle">
          <ClaudeProviderRow />
        </StoryRow>
        <StoryRow label="full access" hint='permission tone="warning"'>
          <FullAccessRow />
        </StoryRow>
        <StoryRow
          label="projectless"
          hint="host picker replaces environment picker"
        >
          <ProjectlessThreadRow />
        </StoryRow>
      </StoryCard>
    </ModelPickerStoryQueryProvider>
  );
}

export function UnsupportedCodexCli() {
  return (
    <ModelPickerStoryQueryProvider>
      <StoryCard>
        <StoryRow
          label="unsupported Codex CLI"
          hint="Codex is installed but below bb's minimum supported version"
        >
          <UnsupportedCodexCliRow />
        </StoryRow>
      </StoryCard>
    </ModelPickerStoryQueryProvider>
  );
}
