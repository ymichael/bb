import { ClaudeIcon } from "@/components/icons/ClaudeIcon";
import { OpenAiIcon } from "@/components/icons/OpenAiIcon";
import { PiIcon } from "@/components/icons/PiIcon";
import type { PickerOption } from "./OptionPicker";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Provider Model Picker",
};

// Real bb providers in the order useThreadCreationOptions emits them:
// codex first, then claude-code, then pi.
const providerOptions: readonly PickerOption<string>[] = [
  { value: "codex", label: "Codex", icon: OpenAiIcon },
  { value: "claude-code", label: "Claude Code", icon: ClaudeIcon },
  { value: "pi", label: "Pi", icon: PiIcon },
];

// Only codex supports fast mode (service tier).
const serviceTierSupportByProvider: Record<string, boolean> = {
  codex: true,
  "claude-code": false,
  pi: false,
};

const codexModels: readonly PickerOption<string>[] = [
  { value: "gpt-5-pro", label: "GPT-5 Pro" },
  { value: "gpt-5", label: "GPT-5" },
  { value: "gpt-5-mini", label: "GPT-5 mini" },
];

const claudeModels: readonly PickerOption<string>[] = [
  { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

// Pi proxies through other backends — its model list is a cross-provider mix.
// Mirrors PI_DEFAULT_MODEL_PER_PROVIDER in @bb/agent-providers.
const piModels: readonly PickerOption<string>[] = [
  { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "grok-4-fast-non-reasoning", label: "Grok 4 Fast" },
];

const noop = () => {};

const codexBase = {
  providerOptions,
  serviceTierSupportByProvider,
  selectedProviderId: "codex",
  onSelectedProviderChange: noop,
  hasMultipleProviders: true,
  modelValue: "gpt-5",
  modelOptions: codexModels,
  onModelChange: noop,
  fastModeEnabled: false,
  onFastModeChange: noop,
  showFastModeToggle: true,
};

const claudeBase = {
  ...codexBase,
  selectedProviderId: "claude-code",
  modelValue: "claude-sonnet-4-6",
  modelOptions: claudeModels,
  showFastModeToggle: false,
};

const piBase = {
  ...codexBase,
  selectedProviderId: "pi",
  modelValue: "claude-opus-4-7",
  modelOptions: piModels,
  showFastModeToggle: false,
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="default" hint="codex selected, fast mode supported">
        <ProviderModelPicker {...codexBase} />
      </StoryRow>
      <StoryRow label="muted" hint="prompt-box treatment">
        <ProviderModelPicker {...codexBase} muted />
      </StoryRow>
      <StoryRow label="claude-code selected" hint="no fast mode toggle">
        <ProviderModelPicker {...claudeBase} />
      </StoryRow>
      <StoryRow label="pi selected" hint="cross-provider model list">
        <ProviderModelPicker {...piBase} />
      </StoryRow>
      <StoryRow label="fast mode active" hint="codex + fastModeEnabled">
        <ProviderModelPicker {...codexBase} fastModeEnabled />
      </StoryRow>
      <StoryRow label="open popover" hint="defaultOpen + modal=false">
        <ProviderModelPicker {...codexBase} defaultOpen modal={false} />
      </StoryRow>
    </StoryCard>
  );
}
