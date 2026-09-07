import type { KeyboardEvent, RefObject } from "react";
import { BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH } from "@bb/desktop-contract";
import {
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS } from "./panelChromeClasses";

export interface BrowserFindMatches {
  activeMatchOrdinal: number;
  matches: number;
}

interface BrowserFindBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  matches: BrowserFindMatches | null;
  onQueryChange: (query: string) => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onClose: () => void;
  shortcut: AppShortcutPresentation | null;
}

interface FindBarButtonProps {
  icon: "ChevronUp" | "ChevronDown" | "X";
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

function formatBrowserFindMatches(
  matches: BrowserFindMatches | null,
): string | null {
  if (matches === null) {
    return null;
  }
  return `${matches.activeMatchOrdinal}/${matches.matches}`;
}

function FindBarButton({ icon, label, disabled, onClick }: FindBarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "flex shrink-0 items-center justify-center transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
        CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
      )}
    >
      <Icon name={icon} aria-hidden />
    </button>
  );
}

export function BrowserFindBar({
  inputRef,
  query,
  matches,
  onQueryChange,
  onFindNext,
  onFindPrevious,
  onClose,
  shortcut,
}: BrowserFindBarProps) {
  const matchLabel = formatBrowserFindMatches(matches);
  const hasMatches = matches !== null && matches.matches > 0;
  const noMatches = matches !== null && matches.matches === 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        onFindPrevious();
      } else {
        onFindNext();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      data-testid="browser-find-bar"
      role="search"
      aria-label="Find in page"
      className={cn(
        "flex h-9 shrink-0 items-center gap-1 border-b border-border/70 py-1 pl-2 pr-2",
        SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS,
      )}
    >
      <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in page"
          aria-label={
            shortcut ? `Find in page (${shortcut.label})` : "Find in page"
          }
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          autoComplete="off"
          spellCheck={false}
          maxLength={BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
        />
        {matchLabel !== null ? (
          <span
            data-testid="browser-find-match-count"
            aria-live="polite"
            className={cn(
              "shrink-0 tabular-nums",
              noMatches ? "text-destructive" : "text-muted-foreground",
              COARSE_POINTER_TEXT_SM_CLASS,
            )}
          >
            {matchLabel}
          </span>
        ) : null}
      </div>
      <FindBarButton
        icon="ChevronUp"
        label="Previous match"
        disabled={!hasMatches}
        onClick={onFindPrevious}
      />
      <FindBarButton
        icon="ChevronDown"
        label="Next match"
        disabled={!hasMatches}
        onClick={onFindNext}
      />
      <FindBarButton icon="X" label="Close find bar" onClick={onClose} />
    </div>
  );
}
