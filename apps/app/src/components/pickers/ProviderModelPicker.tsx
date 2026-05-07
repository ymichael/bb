import { useCallback, useMemo, useState } from "react";
import { Check, ChevronDown, Zap } from "lucide-react";
import { Button } from "@/components/ui";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_PROVIDER_TAB_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@/components/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { Switch } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useAvailableModels } from "@/hooks/queries/system-queries";
import { useIsMobile } from "@/components/ui";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_CONTENT_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  type PickerOption,
} from "./OptionPicker";

interface ProviderModelPickerProps {
  // Provider state
  providerOptions: readonly PickerOption<string>[];
  selectedProviderId: string;
  onSelectedProviderChange: (value: string) => void;
  hasMultipleProviders: boolean;
  providerReadOnly?: boolean;
  // Model state
  modelValue: string;
  modelOptions: readonly PickerOption<string>[];
  onModelChange: (value: string) => void;
  formatModelLabel?: (displayName: string, providerId: string) => string;
  // Fast mode / service tier
  fastModeEnabled: boolean;
  onFastModeChange: (enabled: boolean) => void;
  showFastModeToggle: boolean;
  serviceTierSupportByProvider?: Record<string, boolean>;
  className?: string;
  /** Render with the dim, hover-to-foreground treatment used inside the prompt box. */
  muted?: boolean;
  /** Render with the popover open on mount. Story-only escape hatch. */
  defaultOpen?: boolean;
  /** Whether the popover blocks page interaction. Defaults to true; pass false in stories. */
  modal?: boolean;
}

export function ProviderModelPicker({
  providerOptions,
  selectedProviderId,
  onSelectedProviderChange,
  hasMultipleProviders,
  providerReadOnly,
  modelValue,
  modelOptions,
  onModelChange,
  formatModelLabel,
  fastModeEnabled,
  onFastModeChange,
  showFastModeToggle,
  serviceTierSupportByProvider,
  className,
  muted,
  defaultOpen = false,
  modal = true,
}: ProviderModelPickerProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(defaultOpen);
  // While the popover is open, the user can browse other providers without
  // committing. previewProviderId tracks which provider tab is active.
  // null means "showing the committed provider".
  const [previewProviderId, setPreviewProviderId] = useState<string | null>(
    null,
  );

  const activeProviderId = previewProviderId ?? selectedProviderId;

  // When previewing a different provider, resolve fast-mode toggle from that
  // provider's capabilities instead of the committed provider's.
  const effectiveShowFastModeToggle = serviceTierSupportByProvider
    ? (serviceTierSupportByProvider[activeProviderId] ?? false)
    : showFastModeToggle;

  const selectedProvider = providerOptions.find(
    (p) => p.value === selectedProviderId,
  );
  const ProviderIcon = selectedProvider?.icon;
  const selectedModelOption = modelOptions.find((m) => m.value === modelValue);
  const selectedModelLabel = selectedModelOption?.label ?? modelValue;

  const showProviderTabs =
    hasMultipleProviders && !providerReadOnly && providerOptions.length > 1;

  // When previewing a different provider, fetch its models independently
  // so we don't disturb the committed state in the hook.
  const isPreviewing =
    previewProviderId !== null && previewProviderId !== selectedProviderId;
  const previewModelsQuery = useAvailableModels({
    enabled: isPreviewing,
    providerId: isPreviewing ? previewProviderId : undefined,
  });

  const previewModelOptions = useMemo((): readonly PickerOption<string>[] => {
    if (!isPreviewing) return modelOptions;
    const models = previewModelsQuery.data;
    if (!models || models.length === 0) return [];
    return models.map((model) => ({
      value: model.model,
      label: formatModelLabel
        ? formatModelLabel(model.displayName || model.model, previewProviderId!)
        : model.displayName || model.model,
    }));
  }, [
    isPreviewing,
    modelOptions,
    previewModelsQuery.data,
    formatModelLabel,
    previewProviderId,
  ]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      // Reset preview when closing without selecting a model
      setPreviewProviderId(null);
    }
  }, []);

  const handleModelSelect = useCallback(
    (model: string) => {
      // Commit the previewed provider if it differs from the current one
      if (isPreviewing) {
        onSelectedProviderChange(previewProviderId!);
      }
      onModelChange(model);
      setOpen(false);
      setPreviewProviderId(null);
    },
    [isPreviewing, onModelChange, onSelectedProviderChange, previewProviderId],
  );

  const TriggerIcon = ProviderIcon;

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal={modal}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Provider and model"
          title={`${selectedProvider?.label ?? selectedProviderId}: ${selectedModelLabel}${fastModeEnabled ? " (Fast mode)" : ""}`}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            muted && OPTION_MUTED_CLASS_NAME,
            className,
          )}
        >
          <span className={OPTION_CONTENT_CLASS_NAME}>
            {TriggerIcon ? <TriggerIcon className="size-3.5 shrink-0" /> : null}
            {fastModeEnabled ? (
              <Zap className="size-3.5 shrink-0 fill-current text-muted-foreground/75" />
            ) : null}
            <span className="truncate">{selectedModelLabel}</span>
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-auto min-w-52 max-w-80 flex-col p-0 max-md:w-full max-md:max-w-none"
      >
        {/* Provider icon tabs */}
        {showProviderTabs ? (
          <div
            className={cn(
              "flex items-center gap-0.5 border-b border-border px-2.5 pt-1",
              isMobile ? "sticky top-0 z-10 bg-background" : "bg-muted/40",
            )}
          >
            {providerOptions.map((provider) => {
              const Icon = provider.icon;
              const isActive = provider.value === activeProviderId;
              return (
                <button
                  key={provider.value}
                  type="button"
                  title={provider.label}
                  onClick={() => {
                    if (provider.value !== activeProviderId) {
                      setPreviewProviderId(
                        provider.value === selectedProviderId
                          ? null
                          : provider.value,
                      );
                    }
                  }}
                  className={cn(
                    "flex items-center justify-center border-b-2 transition-colors",
                    COARSE_POINTER_PROVIDER_TAB_SIZE_CLASS,
                    isActive
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {Icon ? (
                    <Icon className={COARSE_POINTER_ICON_SIZE_CLASS} />
                  ) : (
                    <span
                      className={cn(
                        "font-medium",
                        COARSE_POINTER_TEXT_SM_CLASS,
                      )}
                    >
                      {provider.label.charAt(0)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Model list */}
        <div
          className={cn(
            "overflow-y-auto p-1",
            !isMobile &&
              "max-h-[min(300px,var(--radix-popover-content-available-height,300px)-80px)]",
          )}
        >
          {isPreviewing && previewModelsQuery.isLoading ? (
            <div
              className={cn(
                "px-2 text-xs text-muted-foreground",
                isMobile ? "py-2" : "py-[0.3125rem]",
              )}
            >
              Loading models...
            </div>
          ) : previewModelOptions.length > 0 ? (
            previewModelOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleModelSelect(option.value)}
                className={cn(
                  "relative flex w-full cursor-default select-none items-center justify-between gap-3 rounded-sm px-2 text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                  isMobile ? "py-2" : "py-[0.3125rem]",
                )}
              >
                <span className="truncate" title={option.label}>
                  {option.label}
                </span>
                <Check
                  className={cn(
                    COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
                    !isPreviewing && option.value === modelValue
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
              </button>
            ))
          ) : (
            <div
              className={cn(
                "px-2 text-xs text-muted-foreground",
                isMobile ? "py-2" : "py-[0.3125rem]",
              )}
            >
              No models available
            </div>
          )}
        </div>

        {/* Fast mode toggle */}
        {effectiveShowFastModeToggle ? (
          <>
            <div className="border-t border-border" />
            <div className="p-1">
              <div className="flex items-center justify-between gap-3 rounded-sm px-2 py-[0.3125rem] text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  <Zap className="size-4 fill-current text-muted-foreground" />
                  <span>Fast mode</span>
                </span>
                <Switch
                  checked={fastModeEnabled}
                  onCheckedChange={onFastModeChange}
                  aria-label="Fast mode"
                />
              </div>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
