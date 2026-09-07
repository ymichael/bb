import { useCallback, useMemo, useState } from "react";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@bb/shared-ui/command";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { searchPickerOptions } from "./picker-search";
import { useResetPickerScroll } from "./useResetPickerScroll";

export interface ParentThreadPickerOption {
  label: string;
  value: string;
}

export interface ParentThreadPickerProps {
  value: string;
  options: readonly ParentThreadPickerOption[];
  isLoading: boolean;
  isError: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  defaultOpen?: boolean;
}

export function ParentThreadPicker({
  value,
  options,
  isLoading,
  isError,
  disabled = false,
  onChange,
  onOpenChange,
  onRetry,
  defaultOpen,
}: ParentThreadPickerProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [searchQuery, setSearchQuery] = useState("");
  const listRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  const filteredOptions = useMemo(
    () =>
      searchPickerOptions({
        options,
        query: searchQuery,
        getLabel: (option) => option.label,
        getAliases: (option) => [option.value],
      }),
    [options, searchQuery],
  );
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? "None";
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        setSearchQuery("");
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "-mx-1 inline-flex h-5 w-fit max-w-full min-w-0 items-center gap-1 rounded-sm px-1 leading-tight text-foreground outline-none ring-sidebar-ring transition-colors hover:bg-state-hover data-[state=open]:bg-state-hover focus-visible:ring-2 disabled:cursor-default",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
        >
          <span
            className={cn(
              "min-w-0 truncate text-foreground",
              COARSE_POINTER_TEXT_SM_CLASS,
            )}
          >
            {selectedLabel}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
              "text-muted-foreground",
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-0 max-md:w-full"
        mobileTitle="Assign parent thread"
      >
        <Command label="Search parent threads" shouldFilter={false}>
          <CommandInput
            aria-label="Search parent threads"
            placeholder="Search threads…"
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList ref={listRef} className="max-h-72">
            {isLoading ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                Loading threads…
              </div>
            ) : isError ? (
              <CommandGroup>
                <CommandItem
                  forceMount
                  value="retry"
                  onSelect={() => {
                    onRetry();
                    handleOpenChange(false);
                  }}
                >
                  Retry loading threads
                </CommandItem>
              </CommandGroup>
            ) : (
              <>
                {filteredOptions.length === 0 ? (
                  <div className="py-6 text-center text-sm">
                    No matching threads.
                  </div>
                ) : (
                  <CommandGroup heading="Assign parent thread">
                    {filteredOptions.map((option) => (
                      <CommandItem
                        key={option.value}
                        value={option.value}
                        aria-current={
                          value === option.value ? "true" : undefined
                        }
                        onSelect={() => {
                          onChange(option.value);
                          handleOpenChange(false);
                        }}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="truncate" title={option.label}>
                          {option.label}
                        </span>
                        <Icon
                          name="Check"
                          aria-hidden
                          className={cn(
                            COARSE_POINTER_ICON_SIZE_CLASS,
                            value === option.value
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
