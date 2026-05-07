import type { PermissionMode, ReasoningLevel, ServiceTier } from "@bb/domain";
import { formatModelLabel } from "@/hooks/useThreadCreationOptions";
import { ProviderModelPicker } from "@/components/pickers/ProviderModelPicker";
import {
  OptionPicker,
  OptionDisplay,
  type PickerOption,
} from "@/components/pickers/OptionPicker";

export interface PromptExecutionProviderConfig {
  options?: readonly PickerOption<string>[];
  selectedId?: string;
  onChange?: (value: string) => void;
  hasMultiple?: boolean;
  displayName?: string;
  readOnly?: boolean;
}

export interface PromptExecutionModelConfig {
  active?: { model: string } | null;
  selected: string;
  options: readonly PickerOption<string>[];
  onChange: (value: string) => void;
}

export interface PromptExecutionServiceTierConfig {
  value?: ServiceTier;
  onChange: (value: ServiceTier | undefined) => void;
  supported: boolean;
  supportByProvider?: Record<string, boolean>;
}

export interface PromptExecutionReasoningConfig {
  value: ReasoningLevel;
  options: readonly PickerOption<ReasoningLevel>[];
  onChange: (value: ReasoningLevel) => void;
}

export interface PromptExecutionPermissionConfig {
  value?: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
  supported: boolean;
}

export interface PromptExecutionControlsProps {
  provider: PromptExecutionProviderConfig;
  model: PromptExecutionModelConfig;
  serviceTier?: PromptExecutionServiceTierConfig;
  reasoning: PromptExecutionReasoningConfig;
}

export function PromptExecutionControls({
  provider,
  model,
  serviceTier,
  reasoning,
}: PromptExecutionControlsProps) {
  const handleProviderChange = provider.onChange ?? (() => {});
  const handleServiceTierChange = serviceTier?.onChange ?? (() => {});

  // Show read-only provider label when provider is locked (thread follow-up)
  // and there's no model list to show in the unified picker.
  const showReadOnlyProvider =
    provider.hasMultiple &&
    provider.readOnly &&
    provider.displayName &&
    model.options.length === 0;

  const showModelPicker = model.options.length > 0;

  return (
    <>
      {showReadOnlyProvider ? (
        <OptionDisplay
          label="Provider"
          value={provider.displayName}
          icon={
            provider.options?.find(
              (candidate) => candidate.value === provider.selectedId,
            )?.icon
          }
          muted
        />
      ) : null}
      {showModelPicker ? (
        <ProviderModelPicker
          providerOptions={provider.options ?? []}
          selectedProviderId={provider.selectedId ?? ""}
          onSelectedProviderChange={handleProviderChange}
          hasMultipleProviders={provider.hasMultiple ?? false}
          providerReadOnly={provider.readOnly}
          modelValue={model.active?.model ?? model.selected}
          modelOptions={model.options}
          onModelChange={model.onChange}
          formatModelLabel={formatModelLabel}
          fastModeEnabled={serviceTier?.value === "fast"}
          onFastModeChange={(enabled) =>
            handleServiceTierChange(enabled ? "fast" : undefined)
          }
          showFastModeToggle={serviceTier?.supported ?? false}
          serviceTierSupportByProvider={serviceTier?.supportByProvider}
          muted
        />
      ) : null}
      {reasoning.options.length > 0 ? (
        <OptionPicker
          label="Reasoning level"
          value={reasoning.value}
          options={reasoning.options}
          onChange={reasoning.onChange}
          muted
        />
      ) : null}
    </>
  );
}
