import { useState } from "react";
import type { UploadedPromptAttachment } from "@bb/server-contract";
import { ClaudeIcon } from "@/components/icons/ClaudeIcon";
import { OpenAiIcon } from "@/components/icons/OpenAiIcon";
import {
  ExecutionControls,
  type ExecutionControlsProps,
} from "@/components/promptbox/ExecutionControls";
import {
  PromptBoxInternal,
  type AttachmentsConfig,
  type HistoryConfig,
  type MentionsConfig,
  type PromptBoxSubmissionConfig,
  type PromptVoiceConfig,
} from "@/components/promptbox/PromptBoxInternal";
import type { PickerOption } from "@/components/pickers/OptionPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "promptbox/Prompt Box Internal",
};

const noop = () => {};

// ---------------------------------------------------------------------------
// Realistic execution controls strip — same shape as the real ExecutionControls
// component takes. Mirrors what useThreadCreationOptions emits.
// ---------------------------------------------------------------------------

const codexModels: readonly PickerOption<string>[] = [
  { value: "gpt-5-pro", label: "GPT-5 Pro" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5-mini", label: "GPT-5 mini" },
];

const providerOptions: readonly PickerOption<string>[] = [
  { value: "codex", label: "Codex", icon: OpenAiIcon },
  { value: "claude-code", label: "Claude Code", icon: ClaudeIcon },
];

const mockExecution: ExecutionControlsProps = {
  provider: {
    options: providerOptions,
    selectedId: "codex",
    onChange: noop,
    hasMultiple: true,
  },
  model: {
    active: { model: "gpt-5.5" },
    selected: "gpt-5.5",
    options: codexModels,
    onChange: noop,
  },
  serviceTier: {
    value: undefined,
    onChange: noop,
    supported: true,
    supportByProvider: { codex: true, "claude-code": false },
  },
  reasoning: {
    value: "medium",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    onChange: noop,
  },
};

// ---------------------------------------------------------------------------
// Voice fixtures — story-only PromptVoiceConfig values for the recording UX.
// ---------------------------------------------------------------------------

const idleVoice: PromptVoiceConfig = {
  state: "idle",
  isSupported: true,
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

// ---------------------------------------------------------------------------
// Mock attachments
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// History fixture (Up/Down recall)
// ---------------------------------------------------------------------------

const historyEntries = [
  { text: "fix the timeline pagination bug", attachments: [] },
  { text: "promote thread workspace", attachments: [] },
];

const baseHistory: HistoryConfig = {
  currentDraft: { text: "", attachments: [] },
  entries: historyEntries,
  onSelectEntry: noop,
};

// ---------------------------------------------------------------------------
// Per-row controlled value + helpers
// ---------------------------------------------------------------------------

function useControlledValue(initial: string) {
  const [value, setValue] = useState(initial);
  return { value, onChange: setValue };
}

function makeMentions(overrides?: Partial<MentionsConfig>): MentionsConfig {
  return {
    suggestions: [],
    isLoading: false,
    isError: false,
    onQueryChange: noop,
    ...overrides,
  };
}

function makeAttachments(
  overrides?: Partial<AttachmentsConfig>,
): AttachmentsConfig {
  return {
    items: [],
    projectId: "proj_demo",
    onAttachFiles: noop,
    onRemove: noop,
    isAttaching: false,
    error: null,
    ...overrides,
  };
}

function makeSubmission(
  overrides?: Partial<PromptBoxSubmissionConfig>,
): PromptBoxSubmissionConfig {
  return {
    isSubmitting: false,
    disabled: false,
    title: "Submit (Enter)",
    mode: "enter",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Story rows. Each row is its own controlled instance.
// ---------------------------------------------------------------------------

function DefaultRow() {
  const { value, onChange } = useControlledValue("");
  return (
    <PromptBoxInternal
      value={value}
      onChange={onChange}
      onSubmit={noop}
      placeholder="What do you want to build?"
      mentions={makeMentions()}
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function WithAttachmentsRow() {
  const { value, onChange } = useControlledValue(
    "Take a look at this screenshot and the diff.",
  );
  return (
    <PromptBoxInternal
      value={value}
      onChange={onChange}
      onSubmit={noop}
      mentions={makeMentions()}
      attachments={makeAttachments({ items: mockAttachments })}
      history={baseHistory}
      submission={makeSubmission()}
      voice={idleVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function SubmittingRow() {
  const { value, onChange } = useControlledValue("Promote thread workspace.");
  return (
    <PromptBoxInternal
      value={value}
      onChange={onChange}
      onSubmit={noop}
      mentions={makeMentions()}
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
  const { value, onChange } = useControlledValue("");
  return (
    <PromptBoxInternal
      value={value}
      onChange={onChange}
      onSubmit={noop}
      placeholder="Queue a follow-up while the agent runs..."
      mentions={makeMentions()}
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
  const { value, onChange } = useControlledValue("");
  return (
    <PromptBoxInternal
      value={value}
      onChange={onChange}
      onSubmit={noop}
      mentions={makeMentions()}
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={recordingVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
  );
}

function RecordingProcessingRow() {
  const { value, onChange } = useControlledValue("");
  return (
    <PromptBoxInternal
      value={value}
      onChange={onChange}
      onSubmit={noop}
      mentions={makeMentions()}
      attachments={makeAttachments()}
      history={baseHistory}
      submission={makeSubmission()}
      voice={transcribingVoice}
      footerStart={<ExecutionControls {...mockExecution} />}
    />
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
