import { memo } from "react";
import type { PermissionMode, ReasoningLevel, ServiceTier } from "@bb/domain";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemProvidersQuery,
} from "@bb/server-contract";
import { formatModelLabel } from "@/hooks/useThreadCreationOptions";
import {
  ModelReasoningPicker,
  type ModelReasoningPickerFooterAction,
} from "@/components/pickers/ModelReasoningPicker";
import { type PickerOption } from "@/components/pickers/OptionPicker";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import type { ProviderPickerOption } from "@/components/pickers/model-brand-prefix";

interface ExecutionProviderConfig {
  options?: readonly ProviderPickerOption[];
  selectedId?: string;
  onChange?: (value: string) => void;
  hasMultiple?: boolean;
}

interface ExecutionModelConfig {
  active?: { model: string } | null;
  selected: string;
  options: readonly ModelPickerOption[];
  moreOptions: readonly ModelPickerOption[];
  isLoading: boolean;
  loadFailed: boolean;
  loadError?: SystemExecutionOptionsModelLoadError | null;
  onChange: (value: string) => void;
}

interface ExecutionServiceTierConfig {
  value?: ServiceTier;
  onChange: (value: ServiceTier | undefined) => void;
  supported: boolean;
  supportByProvider?: Record<string, boolean>;
  fastLabel?: string;
}

interface ExecutionReasoningConfig {
  value: ReasoningLevel;
  options: readonly PickerOption<ReasoningLevel>[];
  onChange: (value: ReasoningLevel) => void;
}

export interface ExecutionPermissionConfig {
  value?: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
  supported: boolean;
}

export interface ExecutionControlsProps {
  providerRouting?: SystemProvidersQuery;
  provider: ExecutionProviderConfig;
  model: ExecutionModelConfig;
  serviceTier?: ExecutionServiceTierConfig;
  reasoning: ExecutionReasoningConfig;
  footerAction?: ModelReasoningPickerFooterAction;
  disabled?: boolean;
}

export const ExecutionControls = memo(function ExecutionControls({
  provider,
  providerRouting,
  model,
  serviceTier,
  reasoning,
  footerAction,
  disabled,
}: ExecutionControlsProps) {
  const handleServiceTierChange = serviceTier?.onChange ?? (() => {});
  const selectedProviderId = provider.selectedId ?? "";

  const canSwitchProviders = Boolean(
    provider.hasMultiple &&
    provider.onChange &&
    provider.options &&
    provider.options.length > 1,
  );
  const showModelPicker =
    model.isLoading ||
    model.loadFailed ||
    model.options.length > 0 ||
    canSwitchProviders ||
    selectedProviderId.length > 0 ||
    footerAction !== undefined;

  return (
    <>
      {showModelPicker ? (
        <ModelReasoningPicker
          providerOptions={provider.options ?? []}
          providerRouting={providerRouting}
          selectedProviderId={selectedProviderId}
          onSelectedProviderChange={provider.onChange}
          hasMultipleProviders={provider.hasMultiple ?? false}
          modelValue={model.active?.model ?? model.selected}
          modelOptions={model.options}
          moreModelOptions={model.moreOptions}
          modelIsLoading={model.isLoading}
          modelLoadFailed={model.loadFailed}
          modelLoadError={model.loadError}
          onModelChange={model.onChange}
          formatModelLabel={formatModelLabel}
          reasoningValue={reasoning.value}
          reasoningOptions={reasoning.options}
          onReasoningChange={reasoning.onChange}
          fastModeEnabled={serviceTier?.value === "fast"}
          onFastModeChange={(enabled) =>
            handleServiceTierChange(enabled ? "fast" : "default")
          }
          showFastModeToggle={serviceTier?.supported ?? false}
          serviceTierSupportByProvider={serviceTier?.supportByProvider}
          fastModeLabel={serviceTier?.fastLabel}
          muted
          disabled={disabled}
          footerAction={footerAction}
        />
      ) : null}
    </>
  );
});
