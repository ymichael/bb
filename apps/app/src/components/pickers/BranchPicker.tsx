import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui";
import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui";
import { Input } from "@/components/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";

export function getMergeBaseBranchCandidates({
  mergeBaseBranch,
  mergeBaseBranchOptions,
}: {
  mergeBaseBranch?: string;
  mergeBaseBranchOptions?: readonly string[];
}) {
  const fromProps = mergeBaseBranchOptions ?? [];
  if (!mergeBaseBranch || fromProps.includes(mergeBaseBranch)) {
    return fromProps;
  }
  return [mergeBaseBranch, ...fromProps];
}

export function BranchPicker({
  value,
  options,
  loading = false,
  disabled,
  onChange,
  onOpenChange,
  className,
  variant = "default",
}: {
  value: string;
  options: readonly string[];
  loading?: boolean;
  disabled?: boolean;
  onChange: (branch: string) => void;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  variant?: "default" | "minimal";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredOptions = useMemo(() => {
    if (normalizedQuery.length === 0) {
      return options;
    }
    return options.filter((branch) =>
      branch.toLowerCase().includes(normalizedQuery),
    );
  }, [normalizedQuery, options]);
  const enterSelection =
    filteredOptions.find((branch) => branch === value) ?? filteredOptions[0];

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant={variant === "minimal" ? "ghost" : "outline"}
          size="sm"
          disabled={disabled}
          className={cn(
            variant === "minimal"
              ? "h-5 w-auto min-w-0 justify-between gap-1 rounded-sm px-0 text-xs font-normal text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground"
              : "h-8 w-full min-w-0 justify-between rounded-md border-border/60 bg-background px-2.5 text-sm font-normal shadow-none hover:bg-muted/35",
            className,
          )}
          role="combobox"
          aria-expanded={open}
        >
          <span className="truncate text-left">{value}</span>
          <ChevronDown
            className={cn(
              "shrink-0 text-muted-foreground",
              variant === "minimal" ? "size-3" : "size-4",
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={16}
        className="flex max-h-[calc(100vh-6rem)] w-[18rem] min-w-[min(var(--radix-popover-trigger-width),calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
      >
        <div className="shrink-0 border-b border-border/70 p-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }

                event.preventDefault();
                event.stopPropagation();

                if (!enterSelection) {
                  return;
                }

                onChange(enterSelection);
                setOpen(false);
              }}
              placeholder="Search branches"
              className="h-8 border-0 bg-transparent pl-8 pr-2 text-sm shadow-none focus-visible:ring-0"
            />
          </div>
        </div>
        <div
          className="min-h-0 max-h-80 overflow-y-auto overscroll-contain p-1"
          onWheel={(event) => {
            event.stopPropagation();
          }}
        >
          {filteredOptions.length > 0 ? (
            filteredOptions.map((branch) => (
              <button
                key={branch}
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                onClick={() => {
                  onChange(branch);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 truncate" title={branch}>
                  {branch}
                </span>
                <Check
                  className={
                    branch === value
                      ? cn("opacity-100", COARSE_POINTER_ICON_SIZE_SHRINK_CLASS)
                      : cn("opacity-0", COARSE_POINTER_ICON_SIZE_SHRINK_CLASS)
                  }
                />
              </button>
            ))
          ) : (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {loading ? "Loading branches..." : "No branches found."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
