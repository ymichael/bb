import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Icon } from "@/components/ui/icon.js";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
} from "@/components/ui/coarse-pointer-sizing.js";
import { Input } from "@/components/ui/input.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover.js";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_CONTENT_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
} from "./OptionPicker";
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

const CREATE_NEW_BRANCH_LABEL = "Checkout new branch";

export function BranchPicker({
  value,
  options,
  loading = false,
  disabled,
  placeholder,
  onChange,
  onCreate,
  isCreatingNew = false,
  onOpenChange,
  className,
  variant = "default",
  muted,
  defaultOpen = false,
  modal = true,
  popoverAlign = "start",
}: {
  value: string | null;
  options: readonly string[];
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  onChange: (branch: string) => void;
  /**
   * When provided, the popover surfaces a "Create new branch" action item.
   * The server is responsible for naming the new branch — this picker only
   * captures the user's intent.
   */
  onCreate?: () => void;
  /**
   * When true, the trigger renders the create-new affordance instead of a
   * branch name. Pair with onCreate.
   */
  isCreatingNew?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  variant?: "default" | "minimal" | "option";
  /** Render with the dim, hover-to-foreground treatment used inside the prompt box. Only meaningful with variant="minimal" or "option". */
  muted?: boolean;
  /** Render with the popover open on mount. Story-only escape hatch. */
  defaultOpen?: boolean;
  /** Whether the popover blocks page interaction. Defaults to true; pass false in stories. */
  modal?: boolean;
  /** Popover alignment relative to the trigger. Use "end" when the picker is pinned to the right edge of its container. */
  popoverAlign?: "start" | "end";
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredOptions = useMemo(() => {
    const matches =
      normalizedQuery.length === 0
        ? options
        : options.filter((branch) =>
            branch.toLowerCase().includes(normalizedQuery),
          );
    // Pin the currently-selected branch to the top of the list so it's
    // always visible without scrolling. Only when not creating a new branch
    // (then no list option is "selected").
    if (isCreatingNew) return matches;
    if (!value) return matches;
    const selectedIndex = matches.indexOf(value);
    if (selectedIndex <= 0) return matches;
    return [
      matches[selectedIndex],
      ...matches.slice(0, selectedIndex),
      ...matches.slice(selectedIndex + 1),
    ];
  }, [normalizedQuery, options, value, isCreatingNew]);
  const enterSelection = value
    ? (filteredOptions.find((branch) => branch === value) ?? filteredOptions[0])
    : filteredOptions[0];
  const unresolvedTriggerLabel = loading
    ? "Loading branches..."
    : (placeholder ?? "Select branch");
  const triggerLabel = isCreatingNew
    ? CREATE_NEW_BRANCH_LABEL
    : (value ?? unresolvedTriggerLabel);
  const showCreateItem =
    Boolean(onCreate) &&
    CREATE_NEW_BRANCH_LABEL.toLowerCase().includes(normalizedQuery);

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
      modal={modal}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant={variant === "default" ? "outline" : "ghost"}
          size="sm"
          disabled={disabled}
          aria-label="Branch"
          title={
            isCreatingNew
              ? CREATE_NEW_BRANCH_LABEL
              : value
                ? `Branch: ${value}`
                : unresolvedTriggerLabel
          }
          className={cn(
            variant === "default" &&
              "h-8 w-full min-w-0 justify-between rounded-md border-border/60 bg-background px-2.5 text-sm font-normal shadow-none hover:bg-state-hover",
            variant === "minimal" &&
              "h-5 w-auto min-w-0 justify-between gap-1 rounded-sm px-0 text-xs font-normal shadow-none hover:bg-transparent data-[state=open]:bg-transparent data-[state=open]:hover:bg-transparent",
            variant === "minimal" &&
              muted &&
              "text-muted-foreground hover:text-foreground",
            variant === "option" &&
              cn(OPTION_BASE_CLASS_NAME, OPTION_INTERACTIVE_CLASS_NAME),
            variant === "option" && muted && OPTION_MUTED_CLASS_NAME,
            className,
          )}
          role="combobox"
          aria-expanded={open}
        >
          {variant === "option" ? (
            <span className={OPTION_CONTENT_CLASS_NAME}>
              {isCreatingNew ? (
                <Icon
                  name="Plus"
                  className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
                />
              ) : (
                <Icon
                  name="GitMerge"
                  className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
                />
              )}
              <span
                className={cn(
                  "truncate",
                  isCreatingNew && "text-muted-foreground",
                )}
              >
                {triggerLabel}
              </span>
            </span>
          ) : (
            <span
              className={cn(
                "truncate text-left",
                isCreatingNew && "text-muted-foreground",
              )}
            >
              {triggerLabel}
            </span>
          )}
          <Icon
            name="ChevronDown"
            className={cn(
              "shrink-0 text-muted-foreground",
              variant === "default" && "size-4",
              variant === "minimal" && "size-3",
              variant === "option" && COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={popoverAlign}
        sideOffset={6}
        collisionPadding={16}
        mobileTitle="Branch"
        className="flex flex-col overflow-hidden p-0 md:max-h-[calc(100vh-6rem)] md:w-[18rem] md:min-w-[min(var(--radix-popover-trigger-width),calc(100vw-2rem))] md:max-w-[calc(100vw-2rem)]"
      >
        <div className="shrink-0 border-b border-border/70 p-1.5">
          <div className="relative">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
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
          className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain p-1 md:max-h-80"
          onWheel={(event) => {
            event.stopPropagation();
          }}
        >
          {showCreateItem && onCreate ? (
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-2 rounded-sm py-1.5 pl-3 pr-2 text-left text-sm outline-none transition-colors hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground"
              onClick={() => {
                onCreate();
                setOpen(false);
              }}
            >
              <Icon
                name="Plus"
                className={cn(
                  "text-muted-foreground",
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                )}
              />
              <span className="min-w-0 flex-1 truncate">
                {CREATE_NEW_BRANCH_LABEL}
              </span>
              <Icon
                name="Check"
                className={
                  isCreatingNew
                    ? cn("opacity-100", COARSE_POINTER_ICON_SIZE_SHRINK_CLASS)
                    : cn("opacity-0", COARSE_POINTER_ICON_SIZE_SHRINK_CLASS)
                }
              />
            </button>
          ) : null}
          {filteredOptions.length > 0 ? (
            filteredOptions.map((branch) => (
              <button
                key={branch}
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-sm py-1.5 pl-3 pr-2 text-left text-sm outline-none transition-colors hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground"
                onClick={() => {
                  onChange(branch);
                  setOpen(false);
                }}
              >
                <Icon
                  name="GitMerge"
                  className={cn(
                    "text-muted-foreground",
                    COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  )}
                />
                <span className="min-w-0 flex-1 truncate" title={branch}>
                  {branch}
                </span>
                <Icon
                  name="Check"
                  className={
                    !isCreatingNew && branch === value
                      ? cn("opacity-100", COARSE_POINTER_ICON_SIZE_SHRINK_CLASS)
                      : cn("opacity-0", COARSE_POINTER_ICON_SIZE_SHRINK_CLASS)
                  }
                />
              </button>
            ))
          ) : showCreateItem && onCreate ? null : (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {loading ? "Loading branches..." : "No branches found."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
