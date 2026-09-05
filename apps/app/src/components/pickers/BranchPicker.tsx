import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useDebounceValue } from "usehooks-ts";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  MENU_ITEM_LAST_HOVERED_CLASS,
  MenuHoverProvider,
  useMenuItemHover,
} from "@bb/shared-ui/menu-item-hover";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Input } from "@bb/shared-ui/input";
import { blurActiveKeyboardInputWithin } from "@bb/shared-ui/overlay-trigger";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import { cn } from "@bb/shared-ui/lib/utils";
import type { GitBranchRefClassification } from "@bb/domain";
import { searchPickerOptions } from "./picker-search";
import { useResetPickerScroll } from "./useResetPickerScroll";

interface GetMergeBaseBranchCandidatesArgs {
  mergeBaseBranch?: string;
  mergeBaseBranchRef?: GitBranchRefClassification | null;
  mergeBaseBranchOptions?: readonly string[];
  remoteMergeBaseBranchOptions?: readonly string[];
}

export interface MergeBaseBranchCandidateGroups {
  options: readonly string[];
  remoteOptions: readonly string[];
}

export function getMergeBaseBranchCandidateGroups({
  mergeBaseBranch,
  mergeBaseBranchRef,
  mergeBaseBranchOptions,
  remoteMergeBaseBranchOptions,
}: GetMergeBaseBranchCandidatesArgs): MergeBaseBranchCandidateGroups {
  const fromProps = mergeBaseBranchOptions ?? [];
  const fromRemoteProps = remoteMergeBaseBranchOptions ?? [];
  const selectedRef =
    mergeBaseBranchRef?.name === mergeBaseBranch ? mergeBaseBranchRef : null;
  const selectedOptionKind =
    selectedRef && selectedRef.kind !== "missing"
      ? selectedRef.kind
      : undefined;
  if (
    !mergeBaseBranch ||
    fromProps.includes(mergeBaseBranch) ||
    fromRemoteProps.includes(mergeBaseBranch)
  ) {
    return {
      options: fromProps,
      remoteOptions: fromRemoteProps,
    };
  }
  if (selectedOptionKind === "remote") {
    return {
      options: fromProps,
      remoteOptions: [mergeBaseBranch, ...fromRemoteProps],
    };
  }
  if (selectedOptionKind === "local" || selectedRef?.kind !== "missing") {
    return {
      options: [mergeBaseBranch, ...fromProps],
      remoteOptions: fromRemoteProps,
    };
  }
  return { options: fromProps, remoteOptions: fromRemoteProps };
}

const EMPTY_BRANCH_OPTIONS: readonly string[] = [];
const BRANCH_LABEL_PREFIXES = ["Branch from:"] as const;
const BRANCH_PICKER_ROW_CLASS_NAME =
  "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-left text-xs outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground";
const BRANCH_PICKER_HEADER_BASE_CLASS_NAME =
  "text-xs font-medium text-muted-foreground";
const BRANCH_PICKER_HEADER_STICKY_CLASS_NAME =
  "sticky top-0 z-20 -mx-1 bg-background px-3";
const BRANCH_PICKER_CONTENT_CLASS_NAME =
  "flex w-full min-w-0 flex-col overflow-hidden p-0 md:w-max md:max-w-[min(18rem,calc(100vw-2rem))] md:max-h-[calc(100vh-6rem)]";
const BRANCH_SEARCH_DEBOUNCE_MS = 120;

interface BranchPlainLabelParts {
  kind: "plain";
  value: string;
}

interface BranchPrefixedLabelParts {
  kind: "prefixed";
  prefix: string;
  value: string;
}

type BranchLabelParts = BranchPlainLabelParts | BranchPrefixedLabelParts;

interface BranchPickerTextProps {
  label: string;
  emphasizePlainLabel?: boolean;
  className?: string;
  compactAffixesInPromptbox?: boolean;
  wrap?: boolean;
}

interface BranchPickerSectionHeaderProps {
  label: string;
}

interface BranchPickerMenuCopy {
  title: string | null;
  optionsSectionLabel: string | null;
}

const GENERIC_BRANCH_MENU_COPY: BranchPickerMenuCopy = {
  title: null,
  optionsSectionLabel: "Branches",
};

const BASE_BRANCH_MENU_COPY: BranchPickerMenuCopy = {
  title: "Branch from:",
  optionsSectionLabel: null,
};

interface BranchPickerRowButtonProps {
  icon: IconName;
  label: string;
  title?: string;
  selected: boolean;
  onSelect: () => void;
}

interface BranchPickerSearchProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  enterSelection: string | undefined;
  onEnterSelection: (branch: string) => void;
  onQueryChange: (query: string) => void;
}

interface BranchPickerBranchOptionsProps {
  options: readonly string[];
  selectedValue: string | null;
  onSelect: (branch: string) => void;
}

interface OrderBranchPickerOptionsArgs {
  options: readonly string[];
  selectedValue: string | null;
}

function splitBranchLabel(label: string): BranchLabelParts {
  for (const prefix of BRANCH_LABEL_PREFIXES) {
    const prefixWithSpace = `${prefix} `;
    if (label.startsWith(prefixWithSpace)) {
      return {
        kind: "prefixed",
        prefix,
        value: label.slice(prefixWithSpace.length),
      };
    }
  }

  return {
    kind: "plain",
    value: label,
  };
}

function BranchPickerText({
  label,
  emphasizePlainLabel = false,
  className,
  compactAffixesInPromptbox = false,
  wrap = false,
}: BranchPickerTextProps) {
  const valueClassName = wrap
    ? "min-w-0 whitespace-normal break-words"
    : "min-w-0 truncate";
  const compactAffixProps = compactAffixesInPromptbox
    ? { "data-promptbox-hide-compact": "" }
    : {};
  const parts = splitBranchLabel(label);
  if (parts.kind === "plain") {
    return (
      <span
        className={cn(
          valueClassName,
          emphasizePlainLabel && "font-medium text-foreground",
          className,
        )}
      >
        {parts.value}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "flex min-w-0 items-baseline gap-1",
        wrap && "flex-wrap",
        className,
      )}
    >
      <span {...compactAffixProps} className="shrink-0 text-muted-foreground">
        {parts.prefix}
      </span>
      <span className={cn(valueClassName, "font-medium text-foreground")}>
        {parts.value}
      </span>
    </span>
  );
}

function BranchPickerSectionHeader({ label }: BranchPickerSectionHeaderProps) {
  return (
    <div
      className={cn(
        BRANCH_PICKER_HEADER_BASE_CLASS_NAME,
        BRANCH_PICKER_HEADER_STICKY_CLASS_NAME,
        "flex h-7 items-center",
      )}
    >
      {label}
    </div>
  );
}

function BranchPickerRowButton({
  icon,
  label,
  title,
  selected,
  onSelect,
}: BranchPickerRowButtonProps) {
  const { hoverProps } = useMenuItemHover();
  return (
    <button
      type="button"
      className={cn(
        BRANCH_PICKER_ROW_CLASS_NAME,
        LIST_HOVER_TRANSITION,
        MENU_ITEM_LAST_HOVERED_CLASS,
      )}
      title={title ?? label}
      onClick={onSelect}
      {...hoverProps}
    >
      <Icon
        name={icon}
        className={cn(
          "text-muted-foreground",
          COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
        )}
      />
      <BranchPickerText label={label} className="flex-1" wrap />
      <Icon
        name="Check"
        className={
          selected
            ? cn("opacity-100", COARSE_POINTER_ICON_SIZE_SHRINK_CLASS)
            : cn("opacity-0", COARSE_POINTER_ICON_SIZE_SHRINK_CLASS)
        }
      />
    </button>
  );
}

function BranchPickerSearch({
  inputRef,
  query,
  enterSelection,
  onEnterSelection,
  onQueryChange,
}: BranchPickerSearchProps) {
  return (
    <div className="shrink-0 border-b border-border p-1.5">
      <div className="relative">
        <Icon
          name="Search"
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") {
              return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (!enterSelection) {
              return;
            }

            onEnterSelection(enterSelection);
          }}
          placeholder="Search branches"
          className="h-8 border-0 bg-transparent pl-8 pr-2 text-xs shadow-none focus-visible:ring-0"
        />
      </div>
    </div>
  );
}

function BranchPickerBranchOptions({
  options,
  selectedValue,
  onSelect,
}: BranchPickerBranchOptionsProps) {
  return (
    <>
      {options.map((branch) => (
        <BranchPickerRowButton
          key={branch}
          icon="GitMerge"
          label={branch}
          title={branch}
          selected={branch === selectedValue}
          onSelect={() => onSelect(branch)}
        />
      ))}
    </>
  );
}

function getBranchPickerMenuCopy(
  menuKind: "base" | undefined,
): BranchPickerMenuCopy {
  return menuKind === "base" ? BASE_BRANCH_MENU_COPY : GENERIC_BRANCH_MENU_COPY;
}

export function buildBranchPickerOptionGroups({
  options,
  remoteOptions,
}: {
  options: readonly string[];
  remoteOptions: readonly string[];
}): { local: string[]; remote: string[] } {
  const local = [...options];
  const localBranchNames = new Set(local);
  const remote = remoteOptions.filter(
    (branch) => !localBranchNames.has(branch),
  );
  return { local, remote };
}

export function orderBranchPickerOptions({
  options,
  selectedValue,
}: OrderBranchPickerOptionsArgs): string[] {
  const availableOptions = new Set(options);
  const ordered: string[] = [];
  const seenOptions = new Set<string>();

  const append = (branch: string | null | undefined) => {
    if (!branch || !availableOptions.has(branch) || seenOptions.has(branch)) {
      return;
    }
    ordered.push(branch);
    seenOptions.add(branch);
  };

  append(selectedValue);
  for (const branch of options) {
    append(branch);
  }

  return ordered;
}

export interface BranchPickerProps {
  value: string | null;
  options: readonly string[];
  remoteOptions?: readonly string[];
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  triggerLabel?: string;
  triggerTitle?: string;
  emphasizeTriggerValue?: boolean;
  menuKind?: "base";
  onChange: (branch: string) => void;
  onSearchQueryChange?: (query: string) => void;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  variant?: "default" | "minimal" | "option";
  muted?: boolean;
  defaultOpen?: boolean;
  modal?: boolean;
  popoverAlign?: "start" | "end";
}

export function BranchPicker({
  value,
  options,
  remoteOptions = EMPTY_BRANCH_OPTIONS,
  loading = false,
  disabled,
  placeholder,
  triggerLabel: triggerLabelOverride,
  triggerTitle,
  emphasizeTriggerValue = true,
  menuKind,
  onChange,
  onSearchQueryChange,
  onOpenChange,
  className,
  variant = "default",
  muted,
  defaultOpen = false,
  modal = true,
  popoverAlign = "start",
}: BranchPickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const optionsScrollRef = useResetPickerScroll<HTMLDivElement>(query);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;
  const [debouncedNormalizedQuery] = useDebounceValue(
    normalizedQuery,
    BRANCH_SEARCH_DEBOUNCE_MS,
  );
  const menuCopy = getBranchPickerMenuCopy(menuKind);
  const branchOptionGroups = useMemo(
    () =>
      buildBranchPickerOptionGroups({
        options,
        remoteOptions,
      }),
    [options, remoteOptions],
  );
  const combinedBranchOptions = useMemo(
    () => [...branchOptionGroups.local, ...branchOptionGroups.remote],
    [branchOptionGroups.local, branchOptionGroups.remote],
  );
  const filteredCombinedBranchOptions = useMemo(
    () =>
      searchPickerOptions({
        options: combinedBranchOptions,
        query: deferredQuery,
        getLabel: (branch) => branch,
      }),
    [combinedBranchOptions, deferredQuery],
  );
  const filteredBranchOptions = useMemo(
    () =>
      orderBranchPickerOptions({
        options: filteredCombinedBranchOptions,
        selectedValue: isSearching ? null : value,
      }),
    [filteredCombinedBranchOptions, isSearching, value],
  );
  const firstFilteredOption = filteredBranchOptions[0];
  const enterSelection = value
    ? (filteredBranchOptions.find((branch) => branch === value) ??
      firstFilteredOption)
    : firstFilteredOption;
  const unresolvedTriggerLabel = loading
    ? "Loading branches..."
    : (placeholder ?? "Select branch");
  const triggerLabel = triggerLabelOverride ?? value ?? unresolvedTriggerLabel;
  const triggerHasPlainBranchValue =
    emphasizeTriggerValue &&
    triggerLabelOverride === undefined &&
    value !== null;
  const hasBranchOptions =
    branchOptionGroups.local.length > 0 || branchOptionGroups.remote.length > 0;
  const hasOptionsSection = loading || hasBranchOptions;
  const updateOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      blurActiveKeyboardInputWithin(inputRef.current);
    }
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const closePicker = () => {
    updateOpen(false);
  };
  const selectBranchAndClose = (branch: string) => {
    onChange(branch);
    closePicker();
  };

  useEffect(() => {
    if (!open) {
      setQuery("");
      onSearchQueryChange?.("");
      return;
    }

    if (debouncedNormalizedQuery !== normalizedQuery) {
      return;
    }

    onSearchQueryChange?.(debouncedNormalizedQuery);
  }, [debouncedNormalizedQuery, normalizedQuery, onSearchQueryChange, open]);

  return (
    <Popover modal={modal} open={open} onOpenChange={updateOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant={variant === "default" ? "outline" : "ghost"}
          size="sm"
          disabled={disabled}
          aria-label="Branch"
          className={cn(
            LIST_HOVER_TRANSITION,
            variant === "default" &&
              "h-8 w-full min-w-0 justify-between rounded-md border-border bg-background px-2.5 text-sm font-normal shadow-none hover:bg-state-hover",
            variant === "minimal" &&
              "-mx-1 h-5 w-auto min-w-0 justify-between gap-1 rounded-sm px-1 text-xs font-normal shadow-none hover:bg-state-hover data-[state=open]:bg-state-hover",
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
            <span
              className={OPTION_TRIGGER_CONTENT_CLASS_NAME}
              title={triggerTitle ?? triggerLabel}
            >
              <Icon
                name="GitMerge"
                className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
              />
              <BranchPickerText
                label={triggerLabel}
                emphasizePlainLabel={triggerHasPlainBranchValue}
                className="truncate"
                compactAffixesInPromptbox
              />
            </span>
          ) : (
            <span
              className="flex min-w-0 items-center overflow-hidden"
              title={triggerTitle ?? triggerLabel}
            >
              <BranchPickerText
                label={triggerLabel}
                emphasizePlainLabel={triggerHasPlainBranchValue}
                className="truncate text-left"
                compactAffixesInPromptbox
              />
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
        mobileTitle={menuCopy.title ?? "Branch"}
        autoFocusRef={inputRef}
        className={cn(BRANCH_PICKER_CONTENT_CLASS_NAME, "md:min-w-40")}
      >
        <MenuHoverProvider>
          <BranchPickerSearch
            inputRef={inputRef}
            query={query}
            enterSelection={enterSelection}
            onEnterSelection={selectBranchAndClose}
            onQueryChange={setQuery}
          />
          <div
            ref={optionsScrollRef}
            className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain px-1 pb-1 pt-0 md:max-h-80"
            onWheel={(event) => {
              event.stopPropagation();
            }}
          >
            {menuCopy.title ? (
              <BranchPickerSectionHeader label={menuCopy.title} />
            ) : null}
            {hasOptionsSection && menuCopy.optionsSectionLabel ? (
              <BranchPickerSectionHeader label={menuCopy.optionsSectionLabel} />
            ) : null}
            <BranchPickerBranchOptions
              options={filteredBranchOptions}
              selectedValue={value}
              onSelect={selectBranchAndClose}
            />
            {filteredBranchOptions.length === 0 ? (
              <p
                className={cn(
                  "px-2 text-center text-xs text-muted-foreground",
                  hasOptionsSection ? "py-3" : "py-6",
                )}
              >
                {loading ? "Loading branches..." : "No branches found."}
              </p>
            ) : null}
          </div>
        </MenuHoverProvider>
      </PopoverContent>
    </Popover>
  );
}
