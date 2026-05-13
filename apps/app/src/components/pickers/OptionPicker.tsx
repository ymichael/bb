import type { ComponentType, ReactNode } from "react";
import { Button, Icon } from "@/components/ui";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";

export const OPTION_BASE_CLASS_NAME =
  "h-8 w-fit max-w-full min-w-0 items-center gap-1 px-1 text-xs leading-tight";
export const OPTION_INTERACTIVE_CLASS_NAME =
  "border-none bg-transparent shadow-none hover:bg-transparent data-[state=open]:bg-transparent";
export const OPTION_CONTENT_CLASS_NAME =
  "flex min-w-0 items-center gap-1.5";
export const OPTION_MUTED_CLASS_NAME =
  "text-muted-foreground/75 hover:text-foreground";
const OPTION_WARNING_TEXT_CLASS_NAME = "text-warning";
const OPTION_WARNING_INTERACTIVE_CLASS_NAME =
  "hover:text-warning/80 data-[state=open]:text-warning";
const OPTION_WARNING_ICON_CLASS_NAME = "text-warning/90";

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  tone?: "default" | "warning";
  icon?: ComponentType<{ className?: string }>;
}

interface OptionDisplayProps {
  label: string;
  value: ReactNode;
  tone?: "default" | "warning";
  icon?: ComponentType<{ className?: string }>;
  /** Pre-rendered leading element (e.g. an Icon). Takes precedence over `icon`. */
  leading?: ReactNode;
  className?: string;
  title?: string;
  /** Render with the dim, hover-to-foreground treatment used inside the prompt box. */
  muted?: boolean;
}

interface OptionPickerProps<T extends string> {
  label: string;
  value: T;
  options: readonly PickerOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  contentClassName?: string;
  /** Render with the dim, hover-to-foreground treatment used inside the prompt box. */
  muted?: boolean;
  /** Render with the menu open on mount. Story-only escape hatch. */
  defaultOpen?: boolean;
  /** Whether the menu blocks page interaction. Defaults to Radix's true; pass false in stories. */
  modal?: boolean;
  /** How the menu aligns to the trigger. Defaults to "start". */
  align?: "start" | "end" | "center";
}

export function OptionDisplay({
  label,
  value,
  tone = "default",
  icon: BrandIcon,
  leading,
  className,
  title,
  muted,
}: OptionDisplayProps) {
  const defaultTitle =
    typeof value === "string" ? `${label}: ${value}` : undefined;

  return (
    <div
      title={title ?? defaultTitle}
      className={cn(
        "inline-flex",
        OPTION_BASE_CLASS_NAME,
        muted && OPTION_MUTED_CLASS_NAME,
        tone === "warning" && OPTION_WARNING_TEXT_CLASS_NAME,
        className,
      )}
    >
      <span className={OPTION_CONTENT_CLASS_NAME}>
        {leading ?? (BrandIcon ? <BrandIcon className="size-4 shrink-0" /> : null)}
        <span className="sr-only">{label}: </span>
        <span className="truncate">{value}</span>
      </span>
    </div>
  );
}

export function OptionPicker<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  contentClassName,
  muted,
  defaultOpen,
  modal,
  align = "start",
}: OptionPickerProps<T>) {
  const selectedOption = options.find((option) => option.value === value);
  const selectedIsWarning = selectedOption?.tone === "warning";
  const SelectedIcon = selectedOption?.icon;
  const selectedLabel = selectedOption?.label ?? value;
  const selectedTitle = selectedOption?.description
    ? `${label}: ${selectedLabel} - ${selectedOption.description}`
    : `${label}: ${selectedLabel}`;

  return (
    <DropdownMenu defaultOpen={defaultOpen} modal={modal}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={label}
          title={selectedTitle}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            muted && OPTION_MUTED_CLASS_NAME,
            selectedIsWarning && OPTION_WARNING_TEXT_CLASS_NAME,
            selectedIsWarning && OPTION_WARNING_INTERACTIVE_CLASS_NAME,
            className,
          )}
        >
          <span className={OPTION_CONTENT_CLASS_NAME}>
            {SelectedIcon ? (
              <SelectedIcon className="size-3.5 shrink-0" />
            ) : null}
            <span className="truncate">{selectedLabel}</span>
          </span>
          <Icon name="ChevronDown"
            className={cn(
              "size-3.5",
              selectedIsWarning
                ? OPTION_WARNING_ICON_CLASS_NAME
                : "text-muted-foreground",
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn("min-w-52 max-w-96", contentClassName)}
        mobileTitle={label}
      >
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map((option) => {
          const OptionIcon = option.icon;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onChange(option.value)}
              className="flex items-start justify-between gap-3"
            >
              <span
                className={cn(
                  "flex min-w-0 items-start gap-2",
                  option.tone === "warning" && "text-warning",
                )}
              >
                {OptionIcon ? (
                  <OptionIcon className="mt-0.5 size-4 shrink-0" />
                ) : null}
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
              <Icon name="Check"
                className={cn(
                  COARSE_POINTER_ICON_SIZE_CLASS,
                  option.value === value ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
