import { Check, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export interface PromptOption<T extends string> {
  value: T
  label: string
  tone?: "default" | "warning"
}

interface PromptOptionPickerProps<T extends string> {
  label: string
  value: T
  options: readonly PromptOption<T>[]
  onChange: (value: T) => void
  className?: string
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={label}
          title={label}
          className={cn(
            "h-8 w-fit max-w-full min-w-0 items-center gap-1 border-none bg-transparent px-1 text-xs text-muted-foreground/75 shadow-none hover:bg-transparent hover:text-foreground",
            selectedIsWarning &&
              "text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300",
            className
          )}
        >
          <span>{selectedOption?.label ?? value}</span>
          <ChevronDown
            className={cn(
              "size-3.5",
              selectedIsWarning
                ? "text-amber-500/90 dark:text-amber-300"
                : "text-muted-foreground"
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className="flex items-center justify-between gap-3"
          >
            <span
              className={cn(
                "flex items-center gap-2",
                option.tone === "warning" &&
                  "text-amber-700 dark:text-amber-300"
              )}
            >
              <span>{option.label}</span>
            </span>
            <Check
              className={cn(
                "size-4",
                option.value === value ? "opacity-100" : "opacity-0"
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
