import type { ReasoningLevel, SandboxMode, ServiceTier } from "@bb/core";
import { formatModelLabel } from "@/hooks/usePromptModelReasoning";
import { PromptProviderModelPicker } from "./PromptProviderModelPicker";
import { PromptOptionPicker, PromptOptionDisplay, type PromptOption } from "./PromptOptionPicker";

interface PromptExecutionControlsProps {
  providerOptions?: readonly PromptOption<string>[];
  selectedProviderId?: string;
  onSelectedProviderChange?: (value: string) => void;
  hasMultipleProviders?: boolean;
  providerDisplayName?: string;
  providerReadOnly?: boolean;
  activeModel?: { model: string } | null;
  selectedModel: string;
  modelOptions: readonly PromptOption<string>[];
  onSelectedModelChange: (value: string) => void;
  serviceTier?: ServiceTier;
  onServiceTierChange: (value: ServiceTier | undefined) => void;
  supportsServiceTier: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningOptions: readonly PromptOption<ReasoningLevel>[];
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  sandboxMode?: SandboxMode;
  sandboxOptions: readonly PromptOption<SandboxMode>[];
  onSandboxModeChange: (value: SandboxMode) => void;
}

export function PromptExecutionControls({
  providerOptions,
  selectedProviderId,
  onSelectedProviderChange,
  hasMultipleProviders,
  providerDisplayName,
  providerReadOnly,
  activeModel,
  selectedModel,
  modelOptions,
  onSelectedModelChange,
  serviceTier,
  onServiceTierChange,
  supportsServiceTier,
  reasoningLevel,
  reasoningOptions,
  onReasoningLevelChange,
  sandboxMode,
  sandboxOptions,
  onSandboxModeChange,
}: PromptExecutionControlsProps) {
  const resolvedSandboxMode = sandboxMode ?? sandboxOptions[0]?.value ?? "workspace-write";

  // Show read-only provider label when provider is locked (thread follow-up)
  // and there's no model list to show in the unified picker.
  const showReadOnlyProvider =
    hasMultipleProviders &&
    providerReadOnly &&
    providerDisplayName &&
    modelOptions.length === 0;

  const showModelPicker = modelOptions.length > 0;

  return (
    <>
      {showReadOnlyProvider ? (
        <PromptOptionDisplay
          label="Provider"
          value={providerDisplayName}
          icon={providerOptions?.find((p) => p.value === selectedProviderId)?.icon}
        />
      ) : null}
      {showModelPicker ? (
        <PromptProviderModelPicker
          providerOptions={providerOptions ?? []}
          selectedProviderId={selectedProviderId ?? ""}
          onSelectedProviderChange={onSelectedProviderChange ?? (() => {})}
          hasMultipleProviders={hasMultipleProviders ?? false}
          providerReadOnly={providerReadOnly}
          modelValue={activeModel?.model ?? selectedModel}
          modelOptions={modelOptions}
          onModelChange={onSelectedModelChange}
          formatModelLabel={formatModelLabel}
          fastModeEnabled={serviceTier === "fast"}
          onFastModeChange={(enabled) => onServiceTierChange(enabled ? "fast" : undefined)}
          showFastModeToggle={supportsServiceTier}
        />
      ) : null}
      {reasoningOptions.length > 0 ? (
        <PromptOptionPicker
          label="Reasoning"
          value={reasoningLevel}
          options={reasoningOptions}
          onChange={onReasoningLevelChange}
        />
      ) : null}
      <PromptOptionPicker
        label="Sandbox"
        value={resolvedSandboxMode}
        options={sandboxOptions}
        onChange={onSandboxModeChange}
      />
    </>
  );
}
