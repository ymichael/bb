import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { directoryFromPath } from "@bb/thread-view";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { Input } from "@bb/shared-ui/input";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import {
  useFileSearchSuggestions,
  type FilePathSearchSuggestion,
  type FileSearchSuggestion,
} from "@/hooks/useFileSearchSuggestions";
import type { FileSearchSelection } from "./useThreadFileTabs";
import {
  useThreadRecentItems,
  THREAD_RECENT_ITEMS_VISIBLE_LIMIT,
  type ThreadRecentItem,
} from "./threadRecentItems";
import {
  getFileNameFromPath,
  resolveRightPanelFileVisual,
} from "./rightPanelFileVisuals";
import { cn } from "@bb/shared-ui/lib/utils";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  LAUNCHER_ROW_BASE_CLASS,
  LAUNCHER_ROW_ICON_CLASS,
  LauncherRowTrailing,
  LauncherSectionHeader,
} from "./launcherRow";

export interface NewTabFileSearchProps {
  projectId: string | undefined;
  environmentId: string | null;
  hostId?: string | null;
  currentThreadId: string;
  autoFocus: boolean;
  idleActions: ReactNode;
  initialQuery?: string;
  onAutoFocusHandled: () => void;
  onSelect: (selection: FileSearchSelection) => void;
  recentItemsThreadId?: string | null;
  showFileSearch?: boolean;
}

interface FileResultRowProps {
  id: string;
  suggestion: FilePathSearchSuggestion;
  isActive: boolean;
  onActivate: () => void;
  onSelect: (suggestion: FilePathSearchSuggestion) => void;
}

interface RecentResultRowProps {
  id: string;
  item: ThreadRecentItem;
  isActive: boolean;
  nowMs: number;
  onActivate: () => void;
  onSelect: (item: ThreadRecentItem) => void;
}

interface FileSearchMessageProps {
  iconName: "AlertCircle" | "File" | "FileQuestion" | "Spinner";
  iconClassName?: string;
  message: string;
}

type FileSearchSectionEntry =
  | { kind: "suggestion"; suggestion: FileSearchSuggestion }
  | { kind: "recent"; item: ThreadRecentItem };

interface FileSearchSectionItem {
  entry: FileSearchSectionEntry;
  index: number;
}

interface FileSearchSection {
  kind: FileSearchSectionKind;
  items: FileSearchSectionItem[];
}

type LauncherKeyDownHandler = (event: KeyboardEvent<HTMLElement>) => void;
type FileSearchSource = FileSearchSuggestion["source"];
type FileSearchSectionKind = "files" | "recent";

interface GroupFileSearchSectionsArgs {
  suggestions: readonly FileSearchSuggestion[];
  recentEntries: readonly FileSearchSectionEntry[];
}

interface LauncherTileProps {
  id: string;
  isActive: boolean;
  onActivate: () => void;
  onSelect: () => void;
  title?: string;
  children: ReactNode;
}

interface ShowMoreToggleProps {
  isExpanded: boolean;
  onToggle: () => void;
  showMoreCount: number;
}

const FILE_SEARCH_LIMIT = 20;
const FILE_SEARCH_SECTION_ORDER: readonly FileSearchSectionKind[] = [
  "files",
  "recent",
];

const FILE_SEARCH_SECTION_LABELS = {
  files: "Files",
  recent: "Recent",
} satisfies Record<FileSearchSectionKind, string>;

const FILE_SEARCH_SOURCE_LABELS = {
  workspace: "Workspace",
  "thread-storage": "Thread storage",
} satisfies Record<FileSearchSource, string>;

const RECENT_ENTRY_ID_PREFIX = "file-search-result-recent";

function getFileSearchResultId(suggestion: FileSearchSuggestion): string {
  return `file-search-result-${suggestion.source}-${encodeURIComponent(
    suggestion.path,
  )}`;
}

function getFileSearchEntryId(entry: FileSearchSectionEntry): string {
  if (entry.kind === "recent") {
    return `${RECENT_ENTRY_ID_PREFIX}-${entry.item.source}-${encodeURIComponent(
      entry.item.path,
    )}`;
  }
  return getFileSearchResultId(entry.suggestion);
}

function getFileSearchResultTitle(suggestion: FileSearchSuggestion): string {
  return `${FILE_SEARCH_SOURCE_LABELS[suggestion.source]}: ${suggestion.path}`;
}

function groupFileSearchSections({
  recentEntries,
  suggestions,
}: GroupFileSearchSectionsArgs): FileSearchSection[] {
  const sectionsByKind = new Map<FileSearchSectionKind, FileSearchSection>();

  const ensureSection = (
    sectionKind: FileSearchSectionKind,
  ): FileSearchSection => {
    const existing = sectionsByKind.get(sectionKind);
    if (existing) {
      return existing;
    }
    const created: FileSearchSection = {
      kind: sectionKind,
      items: [],
    };
    sectionsByKind.set(sectionKind, created);
    return created;
  };

  for (const suggestion of suggestions) {
    ensureSection("files").items.push({
      entry: { kind: "suggestion", suggestion },
      index: 0,
    });
  }

  for (const entry of recentEntries) {
    ensureSection("recent").items.push({ entry, index: 0 });
  }

  let nextIndex = 0;
  return FILE_SEARCH_SECTION_ORDER.flatMap((sectionKind) => {
    const section = sectionsByKind.get(sectionKind);
    if (!section) {
      return [];
    }
    return [
      {
        ...section,
        items: section.items.map(({ entry }) => {
          const index = nextIndex;
          nextIndex += 1;
          return { entry, index };
        }),
      },
    ];
  });
}

function FileSearchMessage({
  iconName,
  iconClassName,
  message,
}: FileSearchMessageProps) {
  return (
    <EmptyStatePanel className="flex min-h-24 items-center justify-center">
      <div className="flex max-w-64 items-center justify-center gap-1.5">
        <Icon
          name={iconName}
          className={cn(
            COARSE_POINTER_ICON_SIZE_CLASS,
            "shrink-0",
            iconClassName,
          )}
        />
        <p className={COARSE_POINTER_TEXT_SM_CLASS}>{message}</p>
      </div>
    </EmptyStatePanel>
  );
}

function LauncherTile({
  id,
  isActive,
  onActivate,
  onSelect,
  title,
  children,
}: LauncherTileProps) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={isActive}
      onClick={onSelect}
      onMouseEnter={onActivate}
      title={title}
      className={cn(
        LAUNCHER_ROW_BASE_CLASS,
        "relative scroll-mt-7",
        isActive ? "bg-state-active" : "hover:bg-state-hover",
      )}
    >
      {children}
    </button>
  );
}

function FileResultRow({
  id,
  suggestion,
  isActive,
  onActivate,
  onSelect,
}: FileResultRowProps) {
  const handleSelect = useCallback(() => {
    onSelect(suggestion);
  }, [onSelect, suggestion]);
  const directory = directoryFromPath(suggestion.path);
  const secondaryDirectory = directory || null;
  const visual = resolveRightPanelFileVisual({ path: suggestion.path });

  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={isActive}
      onClick={handleSelect}
      onMouseEnter={onActivate}
      title={getFileSearchResultTitle(suggestion)}
      className={cn(
        "w-full scroll-mt-7 rounded px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        LIST_HOVER_TRANSITION,
        COARSE_POINTER_TEXT_SM_CLASS,
        isActive ? "bg-state-active" : "hover:bg-state-hover",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon
          name={visual.iconName}
          className={cn(
            COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
            "text-muted-foreground",
          )}
          aria-hidden
        />
        <span className="truncate">{suggestion.name}</span>
        {secondaryDirectory !== null ? (
          <TruncateStart className="text-muted-foreground [flex-shrink:9999]">
            {secondaryDirectory}
          </TruncateStart>
        ) : null}
      </div>
    </button>
  );
}

function RecentResultRow({
  id,
  item,
  isActive,
  nowMs,
  onActivate,
  onSelect,
}: RecentResultRowProps) {
  const handleSelect = useCallback(() => {
    onSelect(item);
  }, [item, onSelect]);
  const visual = resolveRightPanelFileVisual({ path: item.path });
  const name = getFileNameFromPath({ path: item.path });
  const directory = directoryFromPath(item.path);
  const relativeTime = formatRelativeTime({
    timestamp: item.openedAt,
    now: nowMs,
  });

  return (
    <LauncherTile
      id={id}
      isActive={isActive}
      onActivate={onActivate}
      onSelect={handleSelect}
      title={item.path}
    >
      <span className={LAUNCHER_ROW_ICON_CLASS}>
        <Icon
          name={visual.iconName}
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
          aria-hidden
        />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-foreground">{name}</span>
        {directory ? (
          <TruncateStart className="text-muted-foreground [flex-shrink:9999]">
            {directory}
          </TruncateStart>
        ) : null}
      </span>
      <LauncherRowTrailing idle={relativeTime} isActive={isActive} />
    </LauncherTile>
  );
}

function ShowMoreToggle({
  isExpanded,
  onToggle,
  showMoreCount,
}: ShowMoreToggleProps) {
  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      onClick={onToggle}
      className={cn(
        "ml-1.5 mt-0.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        COARSE_POINTER_TEXT_SM_CLASS,
      )}
    >
      <Icon
        name="ChevronDown"
        className={cn(
          COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
          "transition-transform",
          isExpanded && "rotate-180",
        )}
        aria-hidden
      />
      <span>{isExpanded ? "Show less" : `Show ${showMoreCount} more`}</span>
    </button>
  );
}

export function NewTabFileSearch({
  projectId,
  environmentId,
  hostId,
  currentThreadId,
  autoFocus,
  idleActions,
  initialQuery = "",
  onAutoFocusHandled,
  onSelect,
  recentItemsThreadId,
  showFileSearch = true,
}: NewTabFileSearchProps) {
  const quickOpenShortcut = useAppCommandShortcut("file.quickOpen");
  const inputRef = useRef<HTMLInputElement>(null);
  const focusFrameRef = useRef<number | null>(null);
  const listboxId = useId();
  const isPointerCoarse = usePointerCoarse();
  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isRecentExpanded, setIsRecentExpanded] = useState(false);
  const [nowMs] = useState(() => Date.now());
  const defaultRecentItemsThreadId =
    currentThreadId.length > 0 ? currentThreadId : null;
  const recentItemsStorageThreadId =
    recentItemsThreadId === undefined
      ? defaultRecentItemsThreadId
      : recentItemsThreadId;
  const recentItems = useThreadRecentItems(recentItemsStorageThreadId);
  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;
  const {
    suggestions,
    isLoading,
    fileSearchError,
    isDebouncing,
    isUnavailable,
  } = useFileSearchSuggestions({
    projectId,
    query,
    limit: FILE_SEARCH_LIMIT,
    environmentId,
    hostId,
    currentThreadId,
  });
  const searchSuggestions = useMemo(
    () => (hasQuery ? suggestions : []),
    [hasQuery, suggestions],
  );
  const visibleRecentItems = useMemo(
    () =>
      isRecentExpanded
        ? recentItems
        : recentItems.slice(0, THREAD_RECENT_ITEMS_VISIBLE_LIMIT),
    [isRecentExpanded, recentItems],
  );
  const recentEntries = useMemo<FileSearchSectionEntry[]>(
    () =>
      hasQuery
        ? []
        : visibleRecentItems.map((item) => ({ kind: "recent", item })),
    [hasQuery, visibleRecentItems],
  );
  const sections = useMemo(
    () =>
      groupFileSearchSections({
        recentEntries,
        suggestions: searchSuggestions,
      }),
    [recentEntries, searchSuggestions],
  );
  const navigableEntries = useMemo(
    () =>
      sections.flatMap((section) => section.items.map(({ entry }) => entry)),
    [sections],
  );
  const activeEntry = useMemo(
    () =>
      activeIndex >= 0 && activeIndex < navigableEntries.length
        ? (navigableEntries[activeIndex] ?? null)
        : null,
    [activeIndex, navigableEntries],
  );

  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!autoFocus) return;

    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    }

    if (isPointerCoarse) {
      onAutoFocusHandled();
      return;
    }

    inputRef.current?.focus({ preventScroll: true });
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      inputRef.current?.focus({ preventScroll: true });
    });
    onAutoFocusHandled();
  }, [autoFocus, isPointerCoarse, onAutoFocusHandled]);

  useEffect(() => {
    setActiveIndex(navigableEntries.length > 0 ? 0 : -1);
  }, [navigableEntries]);

  const handleQueryChange = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
  }, []);

  const handleFileSelect = useCallback(
    (suggestion: FilePathSearchSuggestion) => {
      onSelect({ source: suggestion.source, path: suggestion.path });
    },
    [onSelect],
  );

  const handleRecentSelect = useCallback(
    (item: ThreadRecentItem) => {
      onSelect({ source: item.source, path: item.path });
    },
    [onSelect],
  );

  const handleToggleRecentExpanded = useCallback(() => {
    setIsRecentExpanded((current) => !current);
  }, []);

  const handleSuggestionSelect = useCallback(
    (suggestion: FileSearchSuggestion) => {
      handleFileSelect(suggestion);
    },
    [handleFileSelect],
  );

  const handleLauncherKeyDown = useCallback<LauncherKeyDownHandler>(
    (event) => {
      if (navigableEntries.length === 0) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % navigableEntries.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) =>
          current <= 0 ? navigableEntries.length - 1 : current - 1,
        );
        return;
      }

      if (event.key === "Enter" && activeEntry) {
        event.preventDefault();
        if (activeEntry.kind === "recent") {
          handleRecentSelect(activeEntry.item);
          return;
        }
        if (activeEntry.kind === "suggestion") {
          handleSuggestionSelect(activeEntry.suggestion);
        }
      }
    },
    [
      activeEntry,
      handleRecentSelect,
      handleSuggestionSelect,
      navigableEntries.length,
    ],
  );

  const activeEntryId = activeEntry
    ? getFileSearchEntryId(activeEntry)
    : undefined;
  const isSearchDisabled = isUnavailable;
  const hasListbox = !isSearchDisabled && navigableEntries.length > 0;

  if (!showFileSearch) {
    return <div className="flex min-w-0 flex-col gap-3">{idleActions}</div>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="relative min-w-0">
        <Icon
          name="Search"
          className={cn(
            "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground",
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
        />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={handleLauncherKeyDown}
          disabled={isSearchDisabled}
          role="combobox"
          aria-label={
            quickOpenShortcut
              ? `Search files (${quickOpenShortcut.label})`
              : "Search files"
          }
          aria-keyshortcuts={quickOpenShortcut?.ariaKeyshortcuts}
          aria-autocomplete="list"
          aria-expanded={hasListbox}
          aria-controls={hasListbox ? listboxId : undefined}
          aria-activedescendant={hasListbox ? activeEntryId : undefined}
          placeholder={
            isSearchDisabled ? "No searchable source" : "Search files"
          }
          className={cn(
            "h-8 pl-8 pr-8 focus-visible:ring-0 max-md:pointer-coarse:h-10",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
        />
        {isDebouncing ? (
          <Icon
            name="Spinner"
            className={cn(
              "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground",
              COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
            )}
          />
        ) : null}
      </div>
      {hasQuery ? null : idleActions}
      {isUnavailable ? (
        <FileSearchMessage
          iconName="FileQuestion"
          message="No searchable source is available."
        />
      ) : (
        <NewTabResults
          activeIndex={activeIndex}
          hasQuery={hasQuery}
          searchError={fileSearchError}
          isLoading={isLoading}
          listboxId={listboxId}
          nowMs={nowMs}
          onActivateIndex={setActiveIndex}
          onSuggestionSelect={handleSuggestionSelect}
          onRecentSelect={handleRecentSelect}
          recent={{
            count: recentItems.length,
            showMoreCount: Math.max(
              0,
              recentItems.length - THREAD_RECENT_ITEMS_VISIBLE_LIMIT,
            ),
            isExpanded: isRecentExpanded,
            toggleVisible:
              !hasQuery &&
              recentItems.length > THREAD_RECENT_ITEMS_VISIBLE_LIMIT,
            emptyHintVisible: !hasQuery && recentItems.length === 0,
            onToggleExpanded: handleToggleRecentExpanded,
          }}
          sections={sections}
        />
      )}
    </div>
  );
}

interface NewTabRecentState {
  count: number;
  showMoreCount: number;
  isExpanded: boolean;
  toggleVisible: boolean;
  emptyHintVisible: boolean;
  onToggleExpanded: () => void;
}

interface NewTabResultsProps {
  activeIndex: number;
  hasQuery: boolean;
  searchError: boolean;
  isLoading: boolean;
  listboxId: string;
  nowMs: number;
  onActivateIndex: (index: number) => void;
  onSuggestionSelect: (suggestion: FileSearchSuggestion) => void;
  onRecentSelect: (item: ThreadRecentItem) => void;
  recent: NewTabRecentState;
  sections: readonly FileSearchSection[];
}

function NewTabResults({
  activeIndex,
  hasQuery,
  searchError,
  isLoading,
  listboxId,
  nowMs,
  onActivateIndex,
  onSuggestionSelect,
  onRecentSelect,
  recent,
  sections,
}: NewTabResultsProps) {
  const filesSection = sections.find((section) => section.kind === "files");
  const recentSection = sections.find((section) => section.kind === "recent");
  const showFilesSection = filesSection !== undefined;
  const showRecentSection =
    !hasQuery && (recentSection !== undefined || recent.emptyHintVisible);
  const hasSearchResults = showFilesSection;
  const showLoading = isLoading && !hasSearchResults;
  const showError = searchError && !hasSearchResults && !showLoading;
  const showNoSearchResults =
    hasQuery && !hasSearchResults && !showLoading && !showError;
  const showSearchMessage = showLoading || showError || showNoSearchResults;
  const hasRecentSectionPredecessor = hasSearchResults || showSearchMessage;
  const showEmptyMessage =
    !hasSearchResults && !showRecentSection && !showLoading && !showError;
  const showListbox = showFilesSection || recentSection !== undefined;

  if (showEmptyMessage) {
    return (
      <FileSearchMessage
        iconName={hasQuery ? "FileQuestion" : "File"}
        message={
          hasQuery ? "No results match your search." : "Type to search files."
        }
      />
    );
  }

  return (
    <div className="pb-1">
      {}
      {showSearchMessage ? (
        <FileSearchMessage
          iconName={
            showError ? "AlertCircle" : showLoading ? "Spinner" : "FileQuestion"
          }
          iconClassName={showLoading ? "animate-spin" : undefined}
          message={
            showError
              ? "Search failed."
              : showLoading
                ? "Searching files..."
                : "No results match your search."
          }
        />
      ) : null}

      {showListbox ? (
        <div id={listboxId} role="listbox" aria-label="File search results">
          {showFilesSection && filesSection ? (
            <section role="group" aria-label={FILE_SEARCH_SECTION_LABELS.files}>
              <LauncherSectionHeader
                label={FILE_SEARCH_SECTION_LABELS.files}
                sticky
              />
              <div className="flex flex-col gap-px">
                {filesSection.items.map(({ entry, index }) => {
                  if (
                    entry.kind !== "suggestion" ||
                    entry.suggestion.entryKind !== "file"
                  ) {
                    return null;
                  }
                  const suggestion = entry.suggestion;
                  return (
                    <FileResultRow
                      key={`${suggestion.source}:${suggestion.path}`}
                      id={getFileSearchEntryId(entry)}
                      suggestion={suggestion}
                      isActive={index === activeIndex}
                      onActivate={() => onActivateIndex(index)}
                      onSelect={onSuggestionSelect}
                    />
                  );
                })}
              </div>
            </section>
          ) : null}

          {recentSection ? (
            <section
              role="group"
              aria-label={FILE_SEARCH_SECTION_LABELS.recent}
              className={cn(hasRecentSectionPredecessor && "mt-3")}
            >
              <LauncherSectionHeader
                label={FILE_SEARCH_SECTION_LABELS.recent}
                count={recent.count > 0 ? recent.count : undefined}
                sticky
                className={hasRecentSectionPredecessor ? "pt-2" : undefined}
              />
              <div className="flex flex-col gap-px">
                {recentSection.items.map(({ entry, index }) => {
                  if (entry.kind !== "recent") {
                    return null;
                  }
                  return (
                    <RecentResultRow
                      key={`recent:${entry.item.source}:${entry.item.path}`}
                      id={getFileSearchEntryId(entry)}
                      item={entry.item}
                      isActive={index === activeIndex}
                      nowMs={nowMs}
                      onActivate={() => onActivateIndex(index)}
                      onSelect={onRecentSelect}
                    />
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {recent.emptyHintVisible && recentSection === undefined ? (
        <section className={cn(hasRecentSectionPredecessor && "mt-3")}>
          <LauncherSectionHeader
            label={FILE_SEARCH_SECTION_LABELS.recent}
            sticky
            className={hasRecentSectionPredecessor ? "pt-2" : undefined}
          />
          <EmptyStatePanel className={cn("py-4", COARSE_POINTER_TEXT_SM_CLASS)}>
            Plans, mockups, and files you open will show up here.
          </EmptyStatePanel>
        </section>
      ) : null}

      {recent.toggleVisible ? (
        <ShowMoreToggle
          isExpanded={recent.isExpanded}
          onToggle={recent.onToggleExpanded}
          showMoreCount={recent.showMoreCount}
        />
      ) : null}
    </div>
  );
}
