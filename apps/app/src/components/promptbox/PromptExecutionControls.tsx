import type { ComponentProps } from "react";
import type { ReasoningLevel, SandboxMode, ServiceTier } from "@bb/core";
import { formatModelLabel } from "@/hooks/usePromptModelReasoning";
import { PromptProviderModelPicker } from "./PromptProviderModelPicker";
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

  // Unified provider+model picker: when we have multiple providers and model support
  const showUnifiedPicker =
    hasMultipleProviders &&
    providerOptions &&
    providerOptions.length > 0 &&
    selectedProviderId &&
    onSelectedProviderChange &&
    supportsModelList &&
    modelOptions.length > 0;

  return (
    <>
      {showUnifiedPicker ? (
        <PromptProviderModelPicker
          providerOptions={providerOptions}
          selectedProviderId={selectedProviderId}
          onSelectedProviderChange={onSelectedProviderChange}
          hasMultipleProviders
          providerReadOnly={providerReadOnly}
          modelValue={activeModel?.model ?? selectedModel}
          modelOptions={modelOptions}
          onModelChange={onSelectedModelChange}
          formatModelLabel={formatModelLabel}
          fastModeEnabled={serviceTier === "fast"}
          onFastModeChange={(enabled) => onServiceTierChange(enabled ? "fast" : undefined)}
          showFastModeToggle={supportsServiceTier}
        />
      ) : (
        <>
          {hasMultipleProviders && providerReadOnly && providerDisplayName ? (
            <PromptOptionDisplay
              label="Provider"
              value={providerDisplayName}
              icon={providerOptions?.find((p) => p.value === selectedProviderId)?.icon}
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
        </>
      )}
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
