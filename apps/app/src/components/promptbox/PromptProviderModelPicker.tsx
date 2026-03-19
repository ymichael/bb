import { useCallback, useMemo, useState } from "react"
import { Check, ChevronDown, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useAvailableModels } from "@/hooks/useApi"
import { getProviderIconInfo } from "@/lib/provider-icon"
import {
  PROMPT_OPTION_BASE_CLASS_NAME,
  PROMPT_OPTION_INTERACTIVE_CLASS_NAME,
  PROMPT_OPTION_CONTENT_CLASS_NAME,
  type PromptOption,
} from "./PromptOptionPicker"

interface PromptProviderModelPickerProps {
  // Provider state
  providerOptions: readonly PromptOption<string>[]
  selectedProviderId: string
  onSelectedProviderChange: (value: string) => void
  hasMultipleProviders: boolean
  providerReadOnly?: boolean
  // Model state
  modelValue: string
  modelOptions: readonly PromptOption<string>[]
  onModelChange: (value: string) => void
  formatModelLabel?: (displayName: string, providerId: string) => string
  // Fast mode / service tier
  fastModeEnabled: boolean
  onFastModeChange: (enabled: boolean) => void
  showFastModeToggle: boolean
  className?: string
}

export function PromptProviderModelPicker({
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
  className,
}: PromptProviderModelPickerProps) {
  const [open, setOpen] = useState(false)
  // While the popover is open, the user can browse other providers without
  // committing. previewProviderId tracks which provider tab is active.
  // null means "showing the committed provider".
  const [previewProviderId, setPreviewProviderId] = useState<string | null>(null)

  const activeProviderId = previewProviderId ?? selectedProviderId

  const selectedProvider = providerOptions.find(
    (p) => p.value === selectedProviderId,
  )
  const ProviderIcon = selectedProvider?.icon
  const selectedModelOption = modelOptions.find((m) => m.value === modelValue)
  const selectedModelLabel = selectedModelOption?.label ?? modelValue

  const showProviderTabs =
    hasMultipleProviders && !providerReadOnly && providerOptions.length > 1

  // When previewing a different provider, fetch its models independently
  // so we don't disturb the committed state in the hook.
  const isPreviewing = previewProviderId !== null && previewProviderId !== selectedProviderId
  const previewModelsQuery = useAvailableModels(
    isPreviewing ? previewProviderId : undefined,
  )

  const previewModelOptions = useMemo((): readonly PromptOption<string>[] => {
    if (!isPreviewing) return modelOptions
    const models = previewModelsQuery.data
    if (!models || models.length === 0) return []
    return models.map((model) => ({
      value: model.model,
      label: formatModelLabel
        ? formatModelLabel(model.displayName || model.model, previewProviderId!)
        : model.displayName || model.model,
    }))
  }, [isPreviewing, modelOptions, previewModelsQuery.data, formatModelLabel, previewProviderId])

  const previewProviderIcon = useMemo(() => {
    if (!isPreviewing) return undefined
    return getProviderIconInfo(previewProviderId!)?.icon
  }, [isPreviewing, previewProviderId])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) {
        // Reset preview when closing without selecting a model
        setPreviewProviderId(null)
      }
    },
    [],
  )

  const handleModelSelect = useCallback(
    (model: string) => {
      // Commit the previewed provider if it differs from the current one
      if (isPreviewing) {
        onSelectedProviderChange(previewProviderId!)
      }
      onModelChange(model)
      setOpen(false)
      setPreviewProviderId(null)
    },
    [isPreviewing, onModelChange, onSelectedProviderChange, previewProviderId],
  )

  // Icon shown in the trigger: use preview provider icon while previewing isn't committed
  const TriggerIcon = ProviderIcon

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Provider and model"
          title={`${selectedProvider?.label ?? selectedProviderId}: ${selectedModelLabel}${fastModeEnabled ? " (Fast mode)" : ""}`}
          className={cn(
            PROMPT_OPTION_BASE_CLASS_NAME,
            PROMPT_OPTION_INTERACTIVE_CLASS_NAME,
            className,
          )}
        >
          <span className={PROMPT_OPTION_CONTENT_CLASS_NAME}>
            {TriggerIcon ? (
              <TriggerIcon className="size-3.5 shrink-0" />
            ) : null}
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
        className="flex w-auto min-w-52 max-w-80 flex-col p-0"
      >
        {/* Provider icon tabs */}
        {showProviderTabs ? (
          <div className="flex items-center gap-0.5 border-b border-border bg-muted/40 px-1.5 pt-1">
            {providerOptions.map((provider) => {
              const Icon = provider.icon
              const isActive = provider.value === activeProviderId
              return (
                <button
                  key={provider.value}
                  type="button"
                  title={provider.label}
                  onClick={() => {
                    if (provider.value !== activeProviderId) {
                      setPreviewProviderId(
                        provider.value === selectedProviderId ? null : provider.value,
                      )
                    }
                  }}
                  className={cn(
                    "flex h-7 w-6 items-center justify-center border-b-2 transition-colors",
                    isActive
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {Icon ? (
                    <Icon className="size-4" />
                  ) : (
                    <span className="text-xs font-medium">
                      {provider.label.charAt(0)}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ) : null}

        {/* Model list */}
        <div className="max-h-[min(300px,var(--radix-popover-content-available-height,300px)-80px)] overflow-y-auto p-1">
          {isPreviewing && previewModelsQuery.isLoading ? (
            <div className="px-2 py-[0.3125rem] text-xs text-muted-foreground">
              Loading models...
            </div>
          ) : previewModelOptions.length > 0 ? (
            previewModelOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleModelSelect(option.value)}
                className="relative flex w-full cursor-default select-none items-center justify-between gap-3 rounded-sm px-2 py-[0.3125rem] text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span className="truncate" title={option.label}>
                  {option.label}
                </span>
                <Check
                  className={cn(
                    "size-4 shrink-0",
                    !isPreviewing && option.value === modelValue
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
              </button>
            ))
          ) : (
            <div className="px-2 py-[0.3125rem] text-xs text-muted-foreground">
              No models available
            </div>
          )}
        </div>

        {/* Fast mode toggle */}
        {showFastModeToggle ? (
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
  )
}
