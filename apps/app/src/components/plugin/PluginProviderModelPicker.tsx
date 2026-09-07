import { useCallback, useEffect, useMemo } from "react";
import type {
  ExperimentalProviderModelPickerProps,
  ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk";
import { ModelReasoningPicker } from "@/components/pickers/ModelReasoningPicker";
import {
  formatModelLabel,
  useThreadCreationOptions,
} from "@/hooks/useThreadCreationOptions";
import { resolvePluginExecutionRouting } from "./plugin-execution-routing";

function selectionKey(value: ExperimentalProviderModelPickerValue): string {
  return [
    value.providerId,
    value.model,
    value.reasoningLevel,
    value.serviceTier ?? "",
  ].join("\0");
}

export function PluginProviderModelPicker({
  value,
  onChange,
  routing,
  allowProviderChange = true,
  align = "start",
  disabled,
  className,
}: ExperimentalProviderModelPickerProps) {
  const resolvedRouting = useMemo(
    () => resolvePluginExecutionRouting(routing),
    [routing],
  );
  const controlledKey = `${resolvedRouting.key}\0${selectionKey(value)}`;
  const controller = useThreadCreationOptions({
    scope: "component-local",
    initialProviderId: value.providerId,
    initialModel: value.model,
    initialReasoningLevel: value.reasoningLevel,
    initialServiceTier: value.serviceTier,
    resetKey: controlledKey,
    resolveProviderRouting: () => resolvedRouting.query,
  });

  const emit = useCallback(
    (next: ExperimentalProviderModelPickerValue) => {
      if (selectionKey(next) !== selectionKey(value)) {
        onChange(next);
      }
    },
    [onChange, value],
  );

  useEffect(() => {
    if (
      !controller.modelCatalogIsVerified ||
      controller.selectedModel.length === 0
    ) {
      return;
    }
    emit({
      providerId: controller.selectedProviderId,
      model: controller.selectedModel,
      reasoningLevel: controller.reasoningLevel,
      ...(controller.serviceTier === undefined
        ? {}
        : { serviceTier: controller.serviceTier }),
    });
  }, [
    controller.modelCatalogIsVerified,
    controller.reasoningLevel,
    controller.selectedModel,
    controller.selectedProviderId,
    controller.serviceTier,
    emit,
  ]);

  const handleModelChange = useCallback(
    (model: string) => {
      if (!controller.modelCatalogIsVerified) return;
      controller.setSelectedModel(model);
    },
    [controller],
  );
  const handleReasoningChange = useCallback(
    (
      reasoningLevel: ExperimentalProviderModelPickerValue["reasoningLevel"],
    ) => {
      if (!controller.modelCatalogIsVerified) return;
      emit({
        providerId: controller.selectedProviderId,
        model: controller.selectedModel,
        reasoningLevel,
        ...(controller.serviceTier === undefined
          ? {}
          : { serviceTier: controller.serviceTier }),
      });
    },
    [controller, emit],
  );
  const handleFastModeChange = useCallback(
    (enabled: boolean) => {
      if (
        !controller.modelCatalogIsVerified ||
        !controller.supportsServiceTier
      ) {
        return;
      }
      emit({
        providerId: controller.selectedProviderId,
        model: controller.selectedModel,
        reasoningLevel: controller.reasoningLevel,
        serviceTier: enabled ? "fast" : "default",
      });
    },
    [controller, emit],
  );
  const handleProviderPreviewResolved = useCallback(
    (selection: {
      providerId: string;
      model: string;
      reasoningLevel: ExperimentalProviderModelPickerValue["reasoningLevel"];
      supportsServiceTier: boolean;
    }) => {
      emit({
        providerId: selection.providerId,
        model: selection.model,
        reasoningLevel: selection.reasoningLevel,
        ...(selection.supportsServiceTier && value.serviceTier !== undefined
          ? { serviceTier: value.serviceTier }
          : {}),
      });
    },
    [emit, value.serviceTier],
  );

  return (
    <ModelReasoningPicker
      providerOptions={controller.providerOptions}
      providerRouting={controller.executionOptionsRouting}
      selectedProviderId={controller.selectedProviderId}
      onSelectedProviderChange={allowProviderChange ? () => {} : undefined}
      onProviderPreviewResolved={
        allowProviderChange ? handleProviderPreviewResolved : undefined
      }
      requireVerifiedProviderPreview={allowProviderChange}
      hasMultipleProviders={controller.hasMultipleProviders}
      modelValue={controller.selectedModel}
      modelOptions={controller.modelOptions}
      moreModelOptions={controller.moreModelOptions}
      modelIsLoading={controller.isLoadingModels}
      modelLoadFailed={controller.modelLoadFailed}
      modelLoadError={controller.modelLoadError}
      onModelChange={handleModelChange}
      formatModelLabel={formatModelLabel}
      reasoningValue={controller.reasoningLevel}
      reasoningOptions={controller.reasoningOptions}
      onReasoningChange={handleReasoningChange}
      fastModeEnabled={controller.serviceTier === "fast"}
      onFastModeChange={handleFastModeChange}
      showFastModeToggle={controller.supportsServiceTier}
      serviceTierSupportByProvider={controller.serviceTierSupportByProvider}
      commandShortcutsEnabled={false}
      align={align}
      disabled={disabled}
      className={className}
    />
  );
}
