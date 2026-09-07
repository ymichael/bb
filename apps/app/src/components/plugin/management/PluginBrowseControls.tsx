import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { cn } from "@bb/shared-ui/lib/utils";
import { useScrollOverflowState } from "@/components/thread/timeline/useScrollOverflowState";
import type {
  PluginBrowseSort,
  PluginBrowseSortDirection,
} from "./plugin-browse-discovery";

const PLUGIN_BROWSE_SORTS = [
  "recently-added",
  "most-installed",
] as const satisfies readonly PluginBrowseSort[];

const PLUGIN_BROWSE_SORT_LABELS: Record<PluginBrowseSort, string> = {
  "recently-added": "Recently added",
  "most-installed": "Most installed",
};

const PLUGIN_BROWSE_SORT_ICONS: Record<PluginBrowseSort, IconName> = {
  "recently-added": "Clock",
  "most-installed": "Download",
};

export function pluginBrowseSort(
  value: string | null,
): PluginBrowseSort | null {
  return PLUGIN_BROWSE_SORTS.find((sort) => sort === value) ?? null;
}

export function pluginBrowseSortDirection(
  value: string | null,
): PluginBrowseSortDirection | null {
  return value === "asc" || value === "desc" ? value : null;
}

export function pluginBrowseSortOptions(hasInstallCounts: boolean) {
  return PLUGIN_BROWSE_SORTS.map((sort) => ({
    id: sort,
    label: PLUGIN_BROWSE_SORT_LABELS[sort],
    leading: <Icon name={PLUGIN_BROWSE_SORT_ICONS[sort]} className="size-4" />,
    disabled: sort === "most-installed" && !hasInstallCounts,
  }));
}

export interface PluginBrowseCategoryOption {
  id: string;
  label: string;
  count: number;
}

type PluginBrowseCategoryFilterSelection =
  | {
      selectionMode: "single";
      value: string | null;
      onChange: (value: string | null) => void;
    }
  | {
      selectionMode: "multiple";
      value: readonly string[];
      onChange: (value: string[]) => void;
    };

const ENGAGED_CONTROL_CLASS =
  "bg-state-active text-foreground hover:bg-state-active";

const SCROLLBAR_IDLE_DELAY_MS = 600;

function CategoryOptionCheckbox({ enabled }: { enabled: boolean }) {
  return (
    <span
      data-category-option-checkbox
      data-state={enabled ? "enabled" : "disabled"}
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-sm border shadow-xs",
        enabled
          ? "border-foreground bg-foreground text-background"
          : "border-input bg-background text-transparent",
      )}
      aria-hidden
    >
      <Icon name="Check" className="size-3.5" />
    </span>
  );
}

export function PluginBrowseCategoryFilter(
  props: {
    options: readonly PluginBrowseCategoryOption[];
  } & PluginBrowseCategoryFilterSelection,
) {
  const { options } = props;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showKeyboardFocus, setShowKeyboardFocus] = useState(false);
  const [scrollbarScrolling, setScrollbarScrolling] = useState(false);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboardFocusRef = useRef(false);
  const selectedValues =
    props.selectionMode === "multiple"
      ? props.value
      : props.value === null
        ? []
        : [props.value];
  const selected = new Set(selectedValues);
  const selectedOptions = selectedValues.flatMap((value) => {
    const option = options.find((candidate) => candidate.id === value);
    return option === undefined ? [] : [option];
  });
  const selectionLabel =
    selectedOptions.length === 0
      ? "All categories"
      : selectedOptions.length === 1
        ? (selectedOptions[0]?.label ?? "Category")
        : `${selectedOptions.length} categories`;
  const accessibleSelectionLabel =
    selectedOptions.length === 0
      ? "All categories"
      : selectedOptions.map((option) => option.label).join(", ");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredOptions = options.filter((option) =>
    `${option.label} ${option.id}`
      .toLocaleLowerCase()
      .includes(normalizedSearch),
  );
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const {
    scrollRef: listRef,
    topSentinelRef,
    bottomSentinelRef,
    belowOverflow,
  } = useScrollOverflowState<HTMLDivElement>({
    enabled: listElement !== null,
    measureOverflow: true,
  });
  const attachList = useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      setListElement(node);
    },
    [listRef],
  );
  const scrollbarIdleRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const animationFrame = requestAnimationFrame(() =>
      inputRef.current?.focus(),
    );
    return () => cancelAnimationFrame(animationFrame);
  }, [open]);

  useEffect(
    () => () => {
      if (scrollbarIdleRef.current !== null) {
        window.clearTimeout(scrollbarIdleRef.current);
      }
    },
    [],
  );

  const revealScrollbarWhileScrolling = (
    _event: React.UIEvent<HTMLDivElement>,
  ) => {
    setScrollbarScrolling(true);
    if (scrollbarIdleRef.current !== null) {
      window.clearTimeout(scrollbarIdleRef.current);
    }
    scrollbarIdleRef.current = window.setTimeout(() => {
      scrollbarIdleRef.current = null;
      setScrollbarScrolling(false);
    }, SCROLLBAR_IDLE_DELAY_MS);
  };

  const closeAfterSelection = () => {
    setOpen(false);
    setSearch("");
  };

  const clearSelection = () => {
    if (props.selectionMode === "multiple") {
      props.onChange([]);
      return;
    }
    props.onChange(null);
    closeAfterSelection();
  };

  const toggle = (optionId: string) => {
    if (props.selectionMode === "multiple") {
      const next = new Set(props.value);
      if (next.has(optionId)) next.delete(optionId);
      else next.add(optionId);
      props.onChange([...next]);
      return;
    }
    props.onChange(optionId === props.value ? null : optionId);
    closeAfterSelection();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-8 max-w-52 gap-2 px-2.5 text-xs font-normal",
            (open || selectedValues.length > 0) && ENGAGED_CONTROL_CLASS,
          )}
          aria-label={`Filter plugins by category: ${accessibleSelectionLabel}`}
          aria-expanded={open}
          onPointerDown={() => {
            keyboardFocusRef.current = false;
            setShowKeyboardFocus(false);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" ||
              event.key === " " ||
              event.key === "ArrowDown"
            ) {
              keyboardFocusRef.current = true;
              setShowKeyboardFocus(true);
            }
          }}
        >
          <Icon
            name="SlidersHorizontal"
            className="size-3.5 shrink-0"
            aria-hidden
          />
          <span className="min-w-0 truncate">{selectionLabel}</span>
          <Icon name="ChevronDown" className="size-3 shrink-0" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        mobileTitle="Filter plugins by category"
        className="w-72 p-1.5 md:p-0.5"
      >
        <div className="relative mx-2.5 mt-1.5">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={inputRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search categories"
            aria-label="Search plugin categories"
            role="combobox"
            aria-controls={listboxId}
            aria-expanded={open}
            aria-autocomplete="list"
            className={cn(
              "h-7 border-transparent bg-surface-recessed pl-7 pr-2 text-xs focus-visible:ring-0",
              showKeyboardFocus && "ring-1 ring-ring",
            )}
            onFocus={() => setShowKeyboardFocus(keyboardFocusRef.current)}
            onBlur={() => setShowKeyboardFocus(false)}
            onPointerDown={() => {
              keyboardFocusRef.current = false;
              setShowKeyboardFocus(false);
            }}
            onKeyDown={(event) => {
              keyboardFocusRef.current = true;
              setShowKeyboardFocus(true);
              if (event.key === "ArrowDown") {
                event.preventDefault();
                categoryOptionElements(listElement)[0]?.focus();
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                categoryOptionElements(listElement).at(-1)?.focus();
              } else if (event.key !== "Escape" && event.key !== "Tab") {
                event.stopPropagation();
              }
            }}
          />
        </div>
        <div className="relative isolate mt-1.5">
          <div
            id={listboxId}
            ref={attachList}
            data-scrollbar-scrolling={scrollbarScrolling ? "true" : undefined}
            role="listbox"
            aria-label="Plugin categories"
            aria-multiselectable={
              props.selectionMode === "multiple" ? true : undefined
            }
            className="transient-scrollbar max-h-64 overflow-y-auto"
            onScroll={revealScrollbarWhileScrolling}
          >
            <div ref={topSentinelRef} aria-hidden className="h-px w-full" />
            {filteredOptions.length === 0 ? (
              <p
                className="px-2 py-6 text-center text-xs text-muted-foreground"
                role="status"
              >
                {options.length === 0
                  ? "No categories are available."
                  : "No categories match your search."}
              </p>
            ) : (
              filteredOptions.map((option) => {
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-label={`${option.label}, ${option.count.toLocaleString()} ${option.count === 1 ? "plugin" : "plugins"}`}
                    aria-selected={selected.has(option.id)}
                    onClick={() => toggle(option.id)}
                    className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs outline-none hover:bg-state-hover focus-visible:bg-state-hover focus-visible:text-foreground md:gap-1.5"
                    onKeyDown={(event) =>
                      focusCategoryOption(event, listElement)
                    }
                  >
                    <span className="flex w-8 shrink-0 justify-center">
                      <span
                        data-category-option-count
                        className="rounded-full bg-surface-recessed p-1.5 text-center text-2xs font-medium leading-none tabular-nums text-subtle-foreground"
                      >
                        {option.count.toLocaleString()}
                      </span>
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {option.label}
                    </span>
                    <CategoryOptionCheckbox enabled={selected.has(option.id)} />
                  </button>
                );
              })
            )}
            <div ref={bottomSentinelRef} aria-hidden className="h-px w-full" />
          </div>
          {belowOverflow ? (
            <div
              aria-hidden
              data-category-list-fade="below"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-popover/90 via-popover/60 to-transparent"
            />
          ) : null}
        </div>
        {selectedValues.length > 0 ? (
          <div className="mt-0.5 border-t border-border-seam pt-0.5">
            <button
              type="button"
              onClick={clearSelection}
              className="flex w-full items-center rounded-sm px-2 py-1 text-left text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground"
            >
              Clear filter
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function focusCategoryOption(
  event: React.KeyboardEvent<HTMLButtonElement>,
  listbox: HTMLDivElement | null,
) {
  const options = categoryOptionElements(listbox);
  const index = options.indexOf(event.currentTarget);
  if (index < 0) return;
  let nextIndex: number | null = null;
  if (event.key === "ArrowDown")
    nextIndex = Math.min(index + 1, options.length - 1);
  else if (event.key === "ArrowUp") nextIndex = Math.max(index - 1, 0);
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = options.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  options[nextIndex]?.focus();
}

function categoryOptionElements(
  listbox: HTMLDivElement | null,
): HTMLButtonElement[] {
  if (listbox === null) return [];
  return [...listbox.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}
