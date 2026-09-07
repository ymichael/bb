import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type PointerEventHandler,
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

const CREATE_NEW_BRANCH_LABEL = "New branch";
const EMPTY_BRANCH_OPTIONS: readonly string[] = [];
const BRANCH_LABEL_PREFIXES = [
  "Start from:",
  "Current:",
  "Checkout:",
  "New branch from:",
  "Branch from:",
] as const;
const CURRENT_PARENTHESES_LABEL_PREFIX = "Current (";
const DETACHED_LABEL_PREFIX = "Detached";
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

interface BranchParentheticalLabelParts {
  kind: "parenthetical";
  prefix: string;
  value: string;
}

type BranchLabelParts =
  | BranchPlainLabelParts
  | BranchPrefixedLabelParts
  | BranchParentheticalLabelParts;

interface BranchPickerTextProps {
  label: string;
  emphasizePlainLabel?: boolean;
  className?: string;
  compactAffixesInPromptbox?: boolean;
  wrap?: boolean;
}

interface BranchPickerSectionHeaderProps {
  label: string;
  subtitle?: string;
  subtitleTitle?: string;
  sticky?: boolean;
  className?: string;
}

export type BranchPickerMenuKind = "checkout" | "base";

interface BranchPickerMenuCopy {
  title: string | null;
  currentSectionLabel: string | null;
  optionsSectionLabel: string | null;
  optionsUnavailableFallback: string;
}

const GENERIC_BRANCH_MENU_COPY: BranchPickerMenuCopy = {
  title: null,
  currentSectionLabel: "Current",
  optionsSectionLabel: "Branches",
  optionsUnavailableFallback: "Branch selection is unavailable right now.",
};

const CHECKOUT_BRANCH_MENU_COPY: BranchPickerMenuCopy = {
  title: "Start from:",
  currentSectionLabel: null,
  optionsSectionLabel: "Checkout:",
  optionsUnavailableFallback: "Branch checkout is unavailable right now.",
};

const BASE_BRANCH_MENU_COPY: BranchPickerMenuCopy = {
  title: "Branch from:",
  currentSectionLabel: null,
  optionsSectionLabel: null,
  optionsUnavailableFallback: "Base branch selection is unavailable right now.",
};

interface BranchPickerUnavailableRowProps {
  icon: IconName;
  label: string;
  description: string;
  title?: string;
}

interface BranchPickerRowButtonProps {
  icon: IconName;
  label: string;
  title?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  onPointerEnter?: PointerEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
}

interface BranchPickerSearchProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  enterSelection: string | undefined;
  onEnterSelection: (branch: string) => void;
  onQueryChange: (query: string) => void;
}

interface BranchPickerOptionGroups {
  local: string[];
  remote: string[];
}

interface BranchPickerBranchOptionsProps {
  options: readonly string[];
  selectedValue: string | null;
  onSelect: (branch: string) => void;
}

interface BuildBranchPickerOptionGroupsArgs {
  options: readonly string[];
  remoteOptions: readonly string[];
}

interface OrderBranchPickerOptionsArgs {
  options: readonly string[];
  selectedValue: string | null;
}

type BranchPickerCheckoutIntent = "current" | "new" | "checkout";

interface ResolveCheckoutIntentArgs {
  isCreatingNew: boolean;
  value: string | null;
}

interface FormatUnavailableDescriptionArgs {
  title?: string;
  reason?: string | null;
  fallback: string;
}

function formatUnavailableDescription({
  title,
  reason,
  fallback,
}: FormatUnavailableDescriptionArgs): string {
  return title ?? reason ?? fallback;
}

function formatCreateBranchTriggerLabel(branch: string | null): string {
  return branch === null
    ? CREATE_NEW_BRANCH_LABEL
    : `New branch from: ${branch}`;
}

function splitBranchLabel(label: string): BranchLabelParts {
  if (
    label.startsWith(CURRENT_PARENTHESES_LABEL_PREFIX) &&
    label.endsWith(")")
  ) {
    return {
      kind: "parenthetical",
      prefix: "Current",
      value: label.slice(CURRENT_PARENTHESES_LABEL_PREFIX.length, -1),
    };
  }

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

  const detachedPrefixWithSpace = `${DETACHED_LABEL_PREFIX} `;
  if (label.startsWith(detachedPrefixWithSpace)) {
    return {
      kind: "prefixed",
      prefix: DETACHED_LABEL_PREFIX,
      value: label.slice(detachedPrefixWithSpace.length),
    };
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
  if (label === CREATE_NEW_BRANCH_LABEL) {
    return (
      <span className={cn("flex min-w-0 items-baseline gap-1", className)}>
        <span
          className={cn(
            valueClassName,
            emphasizePlainLabel && "font-medium text-foreground",
          )}
        >
          New
        </span>
        <span {...compactAffixProps} className="shrink-0 text-muted-foreground">
          branch
        </span>
      </span>
    );
  }

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

  if (parts.kind === "parenthetical") {
    return (
      <span
        className={cn(
          "flex min-w-0 items-baseline",
          wrap && "flex-wrap",
          className,
        )}
      >
        <span {...compactAffixProps} className="shrink-0 text-muted-foreground">
          {parts.prefix} (
        </span>
        <span className={cn(valueClassName, "font-medium text-foreground")}>
          {parts.value}
        </span>
        <span {...compactAffixProps} className="shrink-0 text-muted-foreground">
          )
        </span>
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

function BranchPickerSectionHeader({
  label,
  subtitle,
  subtitleTitle,
  sticky = true,
  className,
}: BranchPickerSectionHeaderProps) {
  const positionClassName = sticky
    ? BRANCH_PICKER_HEADER_STICKY_CLASS_NAME
    : "px-2";
  if (!subtitle) {
    return (
      <div
        className={cn(
          BRANCH_PICKER_HEADER_BASE_CLASS_NAME,
          positionClassName,
          "flex h-7 items-center",
          className,
        )}
      >
        {label}
      </div>
    );
  }
  return (
    <div
      className={cn(
        BRANCH_PICKER_HEADER_BASE_CLASS_NAME,
        positionClassName,
        "py-[0.3125rem] pb-1.5",
        className,
      )}
      title={subtitleTitle ?? subtitle}
    >
      <div>{label}</div>
      <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground">
        <span className="min-w-0">{subtitle}</span>
      </div>
    </div>
  );
}

function BranchPickerUnavailableRow({
  icon,
  label,
  description,
  title,
}: BranchPickerUnavailableRowProps) {
  return (
    <div
      role="note"
      title={title ?? description}
      className="flex w-full min-w-0 items-start gap-2 rounded-sm px-2 py-[0.3125rem] text-left text-xs text-muted-foreground"
    >
      <Icon
        name={icon}
        className={cn(
          "mt-px text-muted-foreground max-md:pointer-coarse:mt-0",
          COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="whitespace-normal break-words text-foreground/80">
          {label}
        </span>
        <span className="whitespace-normal break-words text-xs leading-snug">
          {description}
        </span>
      </span>
    </div>
  );
}

function BranchPickerRowButton({
  icon,
  label,
  title,
  selected,
  disabled = false,
  onSelect,
  onPointerEnter: callerPointerEnter,
  onKeyDown: callerKeyDown,
}: BranchPickerRowButtonProps) {
  const { hoverProps } = useMenuItemHover({
    onPointerEnter: callerPointerEnter,
    onKeyDown: callerKeyDown,
  });
  return (
    <button
      type="button"
      className={cn(
        BRANCH_PICKER_ROW_CLASS_NAME,
        LIST_HOVER_TRANSITION,
        MENU_ITEM_LAST_HOVERED_CLASS,
        disabled &&
          "cursor-not-allowed text-muted-foreground opacity-60 hover:bg-transparent hover:text-muted-foreground",
      )}
      disabled={disabled}
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
  menuKind: BranchPickerMenuKind | undefined,
): BranchPickerMenuCopy {
  switch (menuKind) {
    case "checkout":
      return CHECKOUT_BRANCH_MENU_COPY;
    case "base":
      return BASE_BRANCH_MENU_COPY;
    case undefined:
      return GENERIC_BRANCH_MENU_COPY;
  }
}

export function buildBranchPickerOptionGroups({
  options,
  remoteOptions,
}: BuildBranchPickerOptionGroupsArgs): BranchPickerOptionGroups {
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

function resolveCheckoutIntent({
  isCreatingNew,
  value,
}: ResolveCheckoutIntentArgs): BranchPickerCheckoutIntent {
  if (isCreatingNew) {
    return "new";
  }
  if (value !== null) {
    return "checkout";
  }
  return "current";
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
  menuKind?: BranchPickerMenuKind;
  currentOptionLabel?: string | null;
  currentOptionTitle?: string;
  onChange: (branch: string) => void;
  onClear?: () => void;
  onCreateBaseChange?: (branch: string) => void;
  onSearchQueryChange?: (query: string) => void;
  optionDisabledReason?: string | null;
  optionDisabledTitle?: string;
  createDisabledReason?: string | null;
  createDisabledTitle?: string;
  onCreate?: () => void;
  isCreatingNew?: boolean;
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
  currentOptionLabel,
  currentOptionTitle,
  onChange,
  onClear,
  onCreateBaseChange,
  onSearchQueryChange,
  optionDisabledReason,
  optionDisabledTitle,
  createDisabledReason,
  createDisabledTitle,
  onCreate,
  isCreatingNew = false,
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
  const selectedCheckoutIntent = resolveCheckoutIntent({
    isCreatingNew,
    value,
  });
  const [checkoutIntent, setCheckoutIntent] =
    useState<BranchPickerCheckoutIntent>(selectedCheckoutIntent);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;
  const [debouncedNormalizedQuery] = useDebounceValue(
    normalizedQuery,
    BRANCH_SEARCH_DEBOUNCE_MS,
  );
  const menuCopy = getBranchPickerMenuCopy(menuKind);
  const isCheckoutMenu = menuKind === "checkout";
  const activeCheckoutIntent = isCheckoutMenu
    ? checkoutIntent
    : selectedCheckoutIntent;
  const showBranchChooser =
    !isCheckoutMenu || activeCheckoutIntent !== "current";
  const checkoutBranchSectionLabel =
    activeCheckoutIntent === "new" ? "Branch from:" : "Checkout:";
  const branchOptionsDisabled = Boolean(optionDisabledReason);
  const createDisabled = Boolean(createDisabledReason);
  const branchChooserDisabled =
    isCheckoutMenu && activeCheckoutIntent === "new"
      ? createDisabled
      : branchOptionsDisabled;
  const branchOptionGroups = useMemo(
    () =>
      buildBranchPickerOptionGroups({
        options,
        remoteOptions,
      }),
    [options, remoteOptions],
  );
  const filteredLocalBranchOptions = useMemo(
    () =>
      searchPickerOptions({
        options: branchOptionGroups.local,
        query: deferredQuery,
        getLabel: (branch) => branch,
      }),
    [branchOptionGroups.local, deferredQuery],
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
  const filteredCheckoutTargetOptions = useMemo(
    () =>
      orderBranchPickerOptions({
        options: filteredLocalBranchOptions,
        selectedValue: isSearching ? null : value,
      }),
    [filteredLocalBranchOptions, isSearching, value],
  );
  const filteredBranchOptions = useMemo(
    () =>
      orderBranchPickerOptions({
        options: filteredCombinedBranchOptions,
        selectedValue: isSearching ? null : value,
      }),
    [filteredCombinedBranchOptions, isSearching, value],
  );
  const activeEnterOptions =
    isCheckoutMenu && activeCheckoutIntent === "checkout"
      ? filteredCheckoutTargetOptions
      : filteredBranchOptions;
  const firstFilteredOption = activeEnterOptions[0];
  const enterSelection = branchChooserDisabled
    ? undefined
    : value
      ? (activeEnterOptions.find((branch) => branch === value) ??
        firstFilteredOption)
      : firstFilteredOption;
  const unresolvedTriggerLabel = loading
    ? "Loading branches..."
    : (placeholder ?? "Select branch");
  const triggerLabel =
    triggerLabelOverride ??
    (isCreatingNew
      ? formatCreateBranchTriggerLabel(value)
      : (value ?? unresolvedTriggerLabel));
  const triggerHasPlainBranchValue =
    emphasizeTriggerValue &&
    triggerLabelOverride === undefined &&
    (isCreatingNew || value !== null);
  const showCreateItem = Boolean(onCreate);
  const createDisabledDescription = formatUnavailableDescription({
    title: createDisabledTitle,
    reason: createDisabledReason,
    fallback: "New branches are unavailable right now.",
  });
  const branchOptionsDisabledDescription = formatUnavailableDescription({
    title: optionDisabledTitle ?? createDisabledTitle,
    reason: optionDisabledReason ?? createDisabledReason,
    fallback: menuCopy.optionsUnavailableFallback,
  });
  const branchChooserDisabledDescription =
    isCheckoutMenu && activeCheckoutIntent === "new"
      ? createDisabledDescription
      : branchOptionsDisabledDescription;
  const branchChooserDisabledTitle =
    isCheckoutMenu && activeCheckoutIntent === "new"
      ? createDisabledTitle
      : (optionDisabledTitle ?? createDisabledTitle);
  const currentOptionItemLabel =
    currentOptionLabel !== undefined && currentOptionLabel !== null && onClear
      ? currentOptionLabel
      : null;
  const hasCurrentItem = currentOptionItemLabel !== null;
  const hasBranchOptions =
    branchOptionGroups.local.length > 0 || branchOptionGroups.remote.length > 0;
  const hasOptionsSection =
    loading ||
    showCreateItem ||
    hasBranchOptions ||
    ((branchOptionsDisabled || createDisabled) &&
      options.length + remoteOptions.length > 0);
  const showOptionsSearch = showBranchChooser && !branchChooserDisabled;
  const optionsSectionDisabled = branchChooserDisabled;
  const titleSubtitle =
    menuCopy.optionsSectionLabel === null && optionsSectionDisabled
      ? branchChooserDisabledDescription
      : undefined;
  const titleSubtitleTitle =
    menuCopy.optionsSectionLabel === null
      ? branchChooserDisabledTitle
      : undefined;
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
    if (isCheckoutMenu && activeCheckoutIntent === "new") {
      (onCreateBaseChange ?? onChange)(branch);
    } else {
      onChange(branch);
    }
    closePicker();
  };
  const selectCheckoutTarget = (branch: string) => {
    onChange(branch);
    closePicker();
  };
  const selectEnterBranch = (branch: string) => {
    if (isCheckoutMenu && activeCheckoutIntent === "checkout") {
      selectCheckoutTarget(branch);
      return;
    }

    selectBranchAndClose(branch);
  };

  useEffect(() => {
    if (open && isCheckoutMenu) {
      setCheckoutIntent(selectedCheckoutIntent);
    }
  }, [isCheckoutMenu, open, selectedCheckoutIntent]);

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
        autoFocusRef={showOptionsSearch ? inputRef : undefined}
        className={cn(
          BRANCH_PICKER_CONTENT_CLASS_NAME,
          showOptionsSearch && "md:min-w-40",
        )}
      >
        <MenuHoverProvider>
          {showOptionsSearch ? (
            <BranchPickerSearch
              inputRef={inputRef}
              query={query}
              enterSelection={enterSelection}
              onEnterSelection={selectEnterBranch}
              onQueryChange={setQuery}
            />
          ) : null}
          <div
            ref={optionsScrollRef}
            className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain px-1 pb-1 pt-0 md:max-h-80"
            onWheel={(event) => {
              event.stopPropagation();
            }}
          >
            {menuCopy.title ? (
              <BranchPickerSectionHeader
                label={menuCopy.title}
                subtitle={titleSubtitle}
                subtitleTitle={titleSubtitleTitle}
                sticky={!isCheckoutMenu}
              />
            ) : null}
            {isCheckoutMenu ? (
              <>
                {currentOptionItemLabel !== null && onClear ? (
                  <BranchPickerRowButton
                    icon="GitMerge"
                    label={currentOptionItemLabel}
                    title={currentOptionTitle ?? currentOptionItemLabel}
                    selected={activeCheckoutIntent === "current"}
                    onSelect={() => {
                      setCheckoutIntent("current");
                      onClear();
                      closePicker();
                    }}
                  />
                ) : null}
                {showCreateItem && onCreate ? (
                  <BranchPickerRowButton
                    icon="Plus"
                    label={CREATE_NEW_BRANCH_LABEL}
                    title={createDisabledTitle ?? CREATE_NEW_BRANCH_LABEL}
                    selected={activeCheckoutIntent === "new"}
                    disabled={createDisabled}
                    onSelect={() => {
                      setCheckoutIntent("new");
                      onCreate();
                    }}
                  />
                ) : null}
                <BranchPickerRowButton
                  icon="GitMerge"
                  label="Checkout"
                  title={optionDisabledTitle ?? "Checkout an existing branch"}
                  selected={activeCheckoutIntent === "checkout"}
                  disabled={branchOptionsDisabled}
                  onSelect={() => {
                    setCheckoutIntent("checkout");
                  }}
                />
                {showBranchChooser ? (
                  <>
                    <div className="my-1 h-px bg-border/60" />
                    <BranchPickerSectionHeader
                      label={checkoutBranchSectionLabel}
                      subtitle={
                        optionsSectionDisabled
                          ? branchChooserDisabledDescription
                          : undefined
                      }
                      subtitleTitle={branchChooserDisabledTitle}
                    />
                    {optionsSectionDisabled ? null : (
                      <>
                        {activeCheckoutIntent === "checkout" ? (
                          <>
                            {filteredCheckoutTargetOptions.length > 0
                              ? filteredCheckoutTargetOptions.map((branch) => (
                                  <BranchPickerRowButton
                                    key={branch}
                                    icon="GitMerge"
                                    label={branch}
                                    title={branch}
                                    selected={branch === value}
                                    onSelect={() =>
                                      selectCheckoutTarget(branch)
                                    }
                                  />
                                ))
                              : null}
                            {filteredCheckoutTargetOptions.length === 0 ? (
                              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                {loading
                                  ? "Loading branches..."
                                  : "No local branches found."}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <BranchPickerBranchOptions
                              options={filteredBranchOptions}
                              selectedValue={value}
                              onSelect={selectBranchAndClose}
                            />
                            {filteredBranchOptions.length === 0 ? (
                              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                {loading
                                  ? "Loading branches..."
                                  : "No branches found."}
                              </p>
                            ) : null}
                          </>
                        )}
                      </>
                    )}
                  </>
                ) : null}
              </>
            ) : (
              <>
                {hasCurrentItem ? (
                  <>
                    {currentOptionItemLabel !== null &&
                    menuCopy.currentSectionLabel ? (
                      <BranchPickerSectionHeader
                        label={menuCopy.currentSectionLabel}
                      />
                    ) : null}
                    {currentOptionItemLabel !== null && onClear ? (
                      <BranchPickerRowButton
                        icon="GitMerge"
                        label={currentOptionItemLabel}
                        title={currentOptionTitle ?? currentOptionItemLabel}
                        selected={!isCreatingNew && value === null}
                        onSelect={() => {
                          onClear();
                          closePicker();
                        }}
                      />
                    ) : null}
                  </>
                ) : null}
                {hasOptionsSection ? (
                  <>
                    {menuCopy.optionsSectionLabel ? (
                      <>
                        {hasCurrentItem ? (
                          <div className="my-1 h-px bg-border/60" />
                        ) : null}
                        <BranchPickerSectionHeader
                          label={menuCopy.optionsSectionLabel}
                          subtitle={
                            optionsSectionDisabled
                              ? branchChooserDisabledDescription
                              : undefined
                          }
                          subtitleTitle={branchChooserDisabledTitle}
                        />
                      </>
                    ) : null}
                    {optionsSectionDisabled ? null : (
                      <>
                        {showCreateItem && onCreate ? (
                          createDisabled ? (
                            <BranchPickerUnavailableRow
                              icon="Plus"
                              label={CREATE_NEW_BRANCH_LABEL}
                              description={createDisabledDescription}
                              title={createDisabledTitle}
                            />
                          ) : (
                            <BranchPickerRowButton
                              icon="Plus"
                              label={CREATE_NEW_BRANCH_LABEL}
                              title={createDisabledTitle}
                              selected={isCreatingNew}
                              onSelect={() => {
                                onCreate();
                                closePicker();
                              }}
                            />
                          )
                        ) : null}
                        <BranchPickerBranchOptions
                          options={filteredBranchOptions}
                          selectedValue={value}
                          onSelect={selectBranchAndClose}
                        />
                        {filteredBranchOptions.length === 0 &&
                        !showCreateItem ? (
                          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                            {loading
                              ? "Loading branches..."
                              : "No branches found."}
                          </p>
                        ) : null}
                      </>
                    )}
                  </>
                ) : hasCurrentItem ? null : (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {loading ? "Loading branches..." : "No branches found."}
                  </p>
                )}
              </>
            )}
          </div>
        </MenuHoverProvider>
      </PopoverContent>
    </Popover>
  );
}
