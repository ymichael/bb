import { Check, ChevronDown, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { PromptOption } from "./PromptOptionPicker";

interface PromptModelPickerProps {
  value: string;
  options: readonly PromptOption<string>[];
  onChange: (value: string) => void;
  fastModeEnabled: boolean;
  onFastModeChange: (enabled: boolean) => void;
  showFastModeToggle: boolean;
  className?: string;
}

export function PromptModelPicker({
  value,
  options,
  onChange,
  fastModeEnabled,
  onFastModeChange,
  showFastModeToggle,
  className,
}: PromptModelPickerProps) {
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? value;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Model"
          title={`Model: ${selectedLabel}${fastModeEnabled ? " (Fast mode)" : ""}`}
          className={cn(
            "h-8 w-fit max-w-full min-w-0 items-center gap-1 border-none bg-transparent px-1 text-xs leading-none text-muted-foreground/75 shadow-none hover:bg-transparent hover:text-foreground",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {fastModeEnabled ? <Zap className="size-3.5 shrink-0 text-amber-500" /> : null}
            <span className="truncate">{selectedLabel}</span>
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52 max-w-80">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className="flex items-center justify-between gap-3"
          >
            <span className="truncate" title={option.label}>
              {option.label}
            </span>
            <Check className={cn("size-4", option.value === value ? "opacity-100" : "opacity-0")} />
          </DropdownMenuItem>
        ))}
        {showFastModeToggle ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={fastModeEnabled}
              onCheckedChange={(checked) => onFastModeChange(checked === true)}
            >
              <span className="flex items-center gap-2">
                <Zap className="size-4 text-amber-500" />
                <span>Fast mode</span>
              </span>
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
