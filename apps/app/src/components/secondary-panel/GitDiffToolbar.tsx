import { Button, COARSE_POINTER_COMPACT_ICON_SIZE_CLASS, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Icon } from "@/components/ui";
import {
  formatChangeSummary,
  renderChangeSummary,
} from "@/components/workspace/workspace-change-summary";
import { cn } from "@/lib/utils";
import type { GitDiffStats } from "../git-diff/git-diff-parsing";

export type GitDiffDisplayMode = "unified" | "split";

export interface GitDiffSelectionOption {
  value: string;
  label: string;
  /** When set, rendered in monospace before the label (e.g. a short commit SHA). */
  monoPrefix?: string;
}

interface GitDiffSelectorProps {
  value: string;
  options: readonly GitDiffSelectionOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

function GitDiffSelector({
  value,
  options,
  onChange,
  disabled,
}: GitDiffSelectorProps) {
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? value;
  const selectedMonoPrefix = selectedOption?.monoPrefix;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "h-8 w-full min-w-0 justify-between gap-2 rounded-lg border border-border/70 bg-transparent px-2.5 text-xs font-normal",
            disabled && "opacity-60",
          )}
        >
          <span className="flex min-w-0 items-baseline gap-2">
            {selectedMonoPrefix ? (
              <span className="shrink-0 font-mono text-muted-foreground">
                {selectedMonoPrefix}
              </span>
            ) : null}
            <span className="truncate">{selectedLabel}</span>
          </span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        // Cap at viewport so we don't overflow; otherwise grow to content.
        // Bigger than the trigger so commit-label rows can breathe and match
        // the width of the diff cards rendered below the selector.
        className="min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[var(--radix-popper-available-width)]"
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className="flex items-center justify-between gap-2"
          >
            <span
              className="flex min-w-0 items-baseline gap-2"
              title={
                option.monoPrefix
                  ? `${option.monoPrefix} ${option.label}`
                  : option.label
              }
            >
              {option.monoPrefix ? (
                <span className="shrink-0 font-mono text-muted-foreground">
                  {option.monoPrefix}
                </span>
              ) : null}
              <span className="truncate">{option.label}</span>
            </span>
            <Icon name="Check"
              className={cn(
                COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
                option.value === value ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface GitDiffToolbarProps {
  selectionValue: string;
  selectionOptions: readonly GitDiffSelectionOption[];
  onSelectionChange: (value: string) => void;
  /** Disables the selector while data is loading or unavailable. */
  isSelectorDisabled: boolean;

  stats: GitDiffStats;
  /** True while files are still being parsed (background work). */
  isParsing: boolean;

  /** Whether the collapse-all action would expand or collapse next. */
  areAllFilesCollapsed: boolean;
  /** Disabled when there are no parsed files (or while loading). */
  isCollapseAllDisabled: boolean;
  onToggleAllCollapsed: () => void;

  displayMode: GitDiffDisplayMode;
  onDisplayModeChange: (mode: GitDiffDisplayMode) => void;
}

export function GitDiffToolbar({
  selectionValue,
  selectionOptions,
  onSelectionChange,
  isSelectorDisabled,
  stats,
  isParsing,
  areAllFilesCollapsed,
  isCollapseAllDisabled,
  onToggleAllCollapsed,
  displayMode,
  onDisplayModeChange,
}: GitDiffToolbarProps) {
  return (
    <div className="px-4 pb-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <GitDiffSelector
            value={selectionValue}
            options={selectionOptions}
            onChange={onSelectionChange}
            disabled={isSelectorDisabled}
          />
        </div>
        <span
          className="min-w-0 shrink truncate text-xs text-muted-foreground"
          title={formatChangeSummary(stats)}
        >
          {renderChangeSummary(stats)}
        </span>
        {isParsing ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Icon name="Spinner" className="size-3 animate-spin" />
            Parsing
          </span>
        ) : null}
        <div className="ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 rounded-md p-0 text-muted-foreground"
            onClick={onToggleAllCollapsed}
            disabled={isCollapseAllDisabled}
            aria-label={
              areAllFilesCollapsed ? "Expand all files" : "Collapse all files"
            }
            title={
              areAllFilesCollapsed ? "Expand all files" : "Collapse all files"
            }
          >
            {areAllFilesCollapsed ? (
              <Icon name="ChevronsDown" className="size-3.5" />
            ) : (
              <Icon name="ChevronsUp" className="size-3.5" />
            )}
          </Button>
          <div
            className="inline-flex items-center gap-1 rounded-lg border border-border/70 p-0.5"
            role="tablist"
            aria-label="Diff view mode"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-md p-0 text-muted-foreground"
              onClick={() => onDisplayModeChange("unified")}
              aria-label="Stacked diff view"
              aria-pressed={displayMode === "unified"}
              title="Stacked diff view"
            >
              <Icon name="Rows2" className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-md p-0 text-muted-foreground"
              onClick={() => onDisplayModeChange("split")}
              aria-label="Split diff view"
              aria-pressed={displayMode === "split"}
              title="Split diff view"
            >
              <Icon name="Columns2" className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
