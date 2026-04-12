import type { ComponentType, ReactNode } from "react"
import { Check, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export const PROMPT_OPTION_BASE_CLASS_NAME =
  "h-8 w-fit max-w-full min-w-0 items-center gap-1 px-1 text-xs leading-tight text-muted-foreground/75"
export const PROMPT_OPTION_INTERACTIVE_CLASS_NAME =
  "border-none bg-transparent shadow-none hover:bg-transparent hover:text-foreground"
export const PROMPT_OPTION_CONTENT_CLASS_NAME = "flex min-w-0 items-center gap-1.5"
const PROMPT_OPTION_WARNING_TEXT_CLASS_NAME =
  "text-amber-600 dark:text-amber-400"
const PROMPT_OPTION_WARNING_INTERACTIVE_CLASS_NAME =
  "hover:text-amber-700 dark:hover:text-amber-300"
const PROMPT_OPTION_WARNING_ICON_CLASS_NAME =
  "text-amber-500/90 dark:text-amber-300"

export interface PromptOption<T extends string> {
  value: T
  label: string
  description?: string
  tone?: "default" | "warning"
  icon?: ComponentType<{ className?: string }>
}

interface PromptOptionDisplayProps {
  label: string
  value: ReactNode
  tone?: "default" | "warning"
  icon?: ComponentType<{ className?: string }>
  className?: string
  title?: string
}

interface PromptOptionPickerProps<T extends string> {
  label: string
  value: T
  options: readonly PromptOption<T>[]
  onChange: (value: T) => void
  className?: string
}

export function PromptOptionDisplay({
  label,
  value,
  tone = "default",
  icon: Icon,
  className,
  title,
}: PromptOptionDisplayProps) {
  const defaultTitle = typeof value === "string" ? `${label}: ${value}` : undefined

  return (
    <div
      title={title ?? defaultTitle}
      className={cn(
        "inline-flex",
        PROMPT_OPTION_BASE_CLASS_NAME,
        tone === "warning" && PROMPT_OPTION_WARNING_TEXT_CLASS_NAME,
        className
      )}
    >
      <span className={PROMPT_OPTION_CONTENT_CLASS_NAME}>
        {Icon ? <Icon className="size-4 shrink-0" /> : null}
        <span className="sr-only">{label}: </span>
        <span className="truncate">{value}</span>
      </span>
    </div>
  )
}

export function PromptOptionPicker<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: PromptOptionPickerProps<T>) {
  const selectedOption = options.find((option) => option.value === value)
  const selectedIsWarning = selectedOption?.tone === "warning"
  const SelectedIcon = selectedOption?.icon
  const selectedLabel = selectedOption?.label ?? value
  const selectedTitle = selectedOption?.description
    ? `${label}: ${selectedLabel} - ${selectedOption.description}`
    : `${label}: ${selectedLabel}`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={label}
          title={selectedTitle}
          className={cn(
            PROMPT_OPTION_BASE_CLASS_NAME,
            PROMPT_OPTION_INTERACTIVE_CLASS_NAME,
            selectedIsWarning && PROMPT_OPTION_WARNING_TEXT_CLASS_NAME,
            selectedIsWarning && PROMPT_OPTION_WARNING_INTERACTIVE_CLASS_NAME,
            className
          )}
        >
          <span className={PROMPT_OPTION_CONTENT_CLASS_NAME}>
            {SelectedIcon ? <SelectedIcon className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{selectedLabel}</span>
          </span>
          <ChevronDown
            className={cn(
              "size-3.5",
              selectedIsWarning
                ? PROMPT_OPTION_WARNING_ICON_CLASS_NAME
                : "text-muted-foreground"
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52 max-w-96">
        {options.map((option) => {
          const OptionIcon = option.icon
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onChange(option.value)}
              className="flex items-start justify-between gap-3"
            >
              <span
                className={cn(
                  "flex min-w-0 items-start gap-2",
                  option.tone === "warning" &&
                    "text-amber-700 dark:text-amber-300"
                )}
              >
                {OptionIcon ? <OptionIcon className="mt-0.5 size-4 shrink-0" /> : null}
                <span className="min-w-0">
                  <span className="block truncate" title={option.label}>
                    {option.label}
                  </span>
                  {option.description ? (
                    <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </span>
              <Check
                className={cn(
                  "size-4",
                  option.value === value ? "opacity-100" : "opacity-0"
                )}
              />
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
