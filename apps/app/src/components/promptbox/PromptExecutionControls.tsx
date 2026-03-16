import type { ComponentProps } from "react";
import type { ReasoningLevel, SandboxMode, ServiceTier } from "@bb/core";
import { PromptModelPicker } from "./PromptModelPicker";
import { PromptOptionPicker, PromptOptionDisplay, type PromptOption } from "./PromptOptionPicker";

interface PromptExecutionControlsProps {
  providerOptions?: readonly PromptOption<string>[];
  selectedProviderId?: string;
  onSelectedProviderChange?: (value: string) => void;
  hasMultipleProviders?: boolean;
  providerDisplayName?: string;
  providerReadOnly?: boolean;
  supportsModelList: boolean;
  activeModel?: { model: string } | null;
  selectedModel: string;
  modelOptions: ComponentProps<typeof PromptModelPicker>["options"];
  onSelectedModelChange: ComponentProps<typeof PromptModelPicker>["onChange"];
  serviceTier?: ServiceTier;
  onServiceTierChange: (value: ServiceTier | undefined) => void;
  supportsServiceTier: boolean;
  supportsReasoningLevels: boolean;
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
  supportsModelList,
  activeModel,
  selectedModel,
  modelOptions,
  onSelectedModelChange,
  serviceTier,
  onServiceTierChange,
  supportsServiceTier,
  supportsReasoningLevels,
  reasoningLevel,
  reasoningOptions,
  onReasoningLevelChange,
  sandboxMode,
  sandboxOptions,
  onSandboxModeChange,
}: PromptExecutionControlsProps) {
  const resolvedSandboxMode = sandboxMode ?? sandboxOptions[0]?.value ?? "workspace-write";

  return (
    <>
      {hasMultipleProviders && providerReadOnly && providerDisplayName ? (
        <PromptOptionDisplay
          label="Provider"
          value={providerDisplayName}
        />
      ) : null}
      {hasMultipleProviders &&
      !providerReadOnly &&
      providerOptions &&
      providerOptions.length > 0 &&
      selectedProviderId &&
      onSelectedProviderChange ? (
        <PromptOptionPicker
          label="Provider"
          value={selectedProviderId}
          options={providerOptions}
          onChange={onSelectedProviderChange}
        />
      ) : null}
      {supportsModelList && modelOptions.length > 0 ? (
        <PromptModelPicker
          value={activeModel?.model ?? selectedModel}
          options={modelOptions}
          onChange={onSelectedModelChange}
          fastModeEnabled={serviceTier === "fast"}
          onFastModeChange={(enabled) => onServiceTierChange(enabled ? "fast" : undefined)}
          showFastModeToggle={supportsServiceTier}
        />
      ) : null}
      {supportsReasoningLevels && reasoningOptions.length > 0 ? (
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
