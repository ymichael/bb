import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import type { ThreadListEntry } from "@bb/domain";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type { ThreadSearchMatch } from "@bb/server-contract";
import {
  hasActiveBackgroundAgentActivity,
  hasActiveBackgroundCommandActivity,
  hasActiveGoalActivity,
  hasActivePlanModeActivity,
  hasActiveWorkflowActivity,
  isRuntimeBusyThread,
  isUnreadDoneThread,
  resolveThreadListIndicator,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { useThreadTitleMentionResources } from "@/components/thread/ThreadTitleMentions";
import { ThreadStatusGlyph } from "@/components/sidebar/ThreadRow";
import {
  hasThreadSearchableQuery,
  useThreadSearch,
} from "@/hooks/queries/thread-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { usePromptDraftHasInput } from "@/hooks/usePromptDraftStorage";
import { formatRelativeTime } from "@/lib/relative-time";
import { getThreadDisplayTitle } from "@/lib/thread-title";

export interface ThreadPaletteNavigationItem {
  id: string;
  optionId: string;
  projectId: string;
  threadId: string;
  messageSeq: number | null;
}

interface ThreadPaletteResultsProps {
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onNavigationItemsChange: (
    items: readonly ThreadPaletteNavigationItem[],
  ) => void;
  onSelect: (item: ThreadPaletteNavigationItem) => void;
  optionIdPrefix: string;
  query: string;
}

interface ThreadSearchRenderableRow {
  id: string;
  matches: readonly ThreadSearchMatch[];
  thread: ThreadListEntry;
}

interface ThreadSearchSection {
  id: "active" | "archived";
  label: string;
  rows: readonly ThreadSearchRenderableRow[];
  total: number;
}

const RECENT_THREAD_LIMIT = 20;
const EMPTY_MATCHES: readonly ThreadSearchMatch[] = [];

function isThreadTitleMatch(match: ThreadSearchMatch): boolean {
  return match.sourceKind === "title" || match.sourceKind === "title_fallback";
}

function getMessageMatchSeq(
  matches: readonly ThreadSearchMatch[],
): number | null {
  for (const match of matches) {
    if (!isThreadTitleMatch(match) && match.sourceSeq !== null) {
      return match.sourceSeq;
    }
  }
  return null;
}

function toNavigationItem(
  row: ThreadSearchRenderableRow,
  optionIdPrefix: string,
): ThreadPaletteNavigationItem {
  return {
    id: row.id,
    optionId: `${optionIdPrefix}-${row.id}`,
    projectId: row.thread.projectId,
    threadId: row.thread.id,
    messageSeq: getMessageMatchSeq(row.matches),
  };
}

function ThreadSearchMessage({
  iconName,
  isLoading = false,
  text,
}: {
  iconName: IconName;
  isLoading?: boolean;
  text: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-muted-foreground",
        COARSE_POINTER_TEXT_SM_CLASS,
      )}
    >
      <Icon
        name={iconName}
        className={cn(
          COARSE_POINTER_ICON_SIZE_CLASS,
          isLoading && "animate-spin",
        )}
      />
      <span>{text}</span>
    </div>
  );
}

function flattenRecentThreads(
  navigation: ReturnType<typeof useSidebarNavigation>["data"],
): ThreadListEntry[] {
  if (!navigation) return [];
  return [
    ...navigation.projects.flatMap((project) => project.threads),
    ...navigation.personalProject.threads,
  ];
}

export function ThreadPaletteResults({
  activeIndex,
  onActiveIndexChange,
  onNavigationItemsChange,
  onSelect,
  optionIdPrefix,
  query,
}: ThreadPaletteResultsProps) {
  const navigationQuery = useSidebarNavigation();
  const recentThreads = useMemo(
    () => flattenRecentThreads(navigationQuery.data),
    [navigationQuery.data],
  );
  const { projectNamesById } = useThreadTitleMentionResources();
  const trimmedQuery = query.trim();
  const liveQueryIsSearchable = hasThreadSearchableQuery(trimmedQuery);
  const threadSearch = useThreadSearch({ active: true, query });
  const searchResultsAreCurrent =
    !liveQueryIsSearchable || threadSearch.debouncedQuery === trimmedQuery;
  const sections = useMemo<ThreadSearchSection[]>(() => {
    if (!liveQueryIsSearchable) {
      const rows = recentThreads
        .slice(0, RECENT_THREAD_LIMIT)
        .map((thread) => ({
          id: `recent:${thread.id}`,
          matches: EMPTY_MATCHES,
          thread,
        }));
      return [{ id: "active", label: "Recent", rows, total: rows.length }];
    }

    if (!searchResultsAreCurrent) {
      return [
        { id: "active", label: "Threads", rows: [], total: 0 },
        { id: "archived", label: "Archived", rows: [], total: 0 },
      ];
    }

    const activeRows =
      threadSearch.data?.active.results.map((result) => ({
        id: `active:${result.thread.id}`,
        matches: result.matches,
        thread: result.thread,
      })) ?? [];
    const archivedRows =
      threadSearch.data?.archived.results.map((result) => ({
        id: `archived:${result.thread.id}`,
        matches: result.matches,
        thread: result.thread,
      })) ?? [];
    return [
      {
        id: "active",
        label: "Threads",
        rows: activeRows,
        total: threadSearch.data?.active.total ?? 0,
      },
      {
        id: "archived",
        label: "Archived",
        rows: archivedRows,
        total: threadSearch.data?.archived.total ?? 0,
      },
    ];
  }, [
    liveQueryIsSearchable,
    recentThreads,
    searchResultsAreCurrent,
    threadSearch.data,
  ]);
  const rows = useMemo(
    () => sections.flatMap((section) => section.rows),
    [sections],
  );
  const navigationItems = useMemo(
    () => rows.map((row) => toNavigationItem(row, optionIdPrefix)),
    [optionIdPrefix, rows],
  );

  useEffect(() => {
    onNavigationItemsChange(navigationItems);
  }, [navigationItems, onNavigationItemsChange]);

  const isLoading =
    liveQueryIsSearchable &&
    (!searchResultsAreCurrent ||
      threadSearch.isDebouncing ||
      (threadSearch.isLoading && threadSearch.data === undefined));
  const hasRows = rows.length > 0;
  const showRecentLoading = !liveQueryIsSearchable && navigationQuery.isLoading;
  const showError =
    liveQueryIsSearchable && threadSearch.isError && !isLoading && !hasRows;
  const showNoSearchResults =
    liveQueryIsSearchable && !isLoading && !showError && !hasRows;
  const showTypeToSearch =
    !liveQueryIsSearchable && !showRecentLoading && recentThreads.length === 0;
  let startIndex = 0;

  return (
    <div className="space-y-3 pb-2">
      {showRecentLoading ? (
        <ThreadSearchMessage
          iconName="Spinner"
          isLoading
          text="Loading threads..."
        />
      ) : null}
      {isLoading ? (
        <ThreadSearchMessage
          iconName="Spinner"
          isLoading
          text="Searching threads..."
        />
      ) : null}
      {showError ? (
        <ThreadSearchMessage iconName="AlertCircle" text="Search failed." />
      ) : null}
      {showNoSearchResults ? (
        <ThreadSearchMessage
          iconName="MessageQuestion"
          text="No matching threads"
        />
      ) : null}
      {showTypeToSearch ? (
        <ThreadSearchMessage iconName="Search" text="Type to search threads." />
      ) : null}
      {sections.map((section) => {
        const sectionStartIndex = startIndex;
        startIndex += section.rows.length;
        if (section.rows.length === 0) return null;
        return (
          <section
            key={section.id}
            role="group"
            aria-label={section.label}
            className="space-y-1"
          >
            <div
              className={cn(
                CHROME_SECTION_LABEL_CLASS,
                "sticky top-0 z-10 flex items-center gap-2 rounded-none bg-popover px-2",
              )}
            >
              <span className="min-w-0 truncate">{section.label}</span>
              {section.total > section.rows.length ? (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {section.rows.length}/{section.total}
                </span>
              ) : null}
            </div>
            <div className="space-y-0.5">
              {section.rows.map((row, rowIndex) => {
                const index = sectionStartIndex + rowIndex;
                const item = navigationItems[index];
                if (!item) return null;
                return (
                  <ThreadPaletteResultRow
                    key={row.id}
                    id={item.optionId}
                    isActive={activeIndex === index}
                    matches={row.matches}
                    projectName={projectNamesById.get(row.thread.projectId)}
                    thread={row.thread}
                    onActive={() => onActiveIndexChange(index)}
                    onSelect={() => onSelect(item)}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function clampRange(
  range: ThreadSearchMatch["highlightRanges"][number],
  textLength: number,
): ThreadSearchMatch["highlightRanges"][number] | null {
  const start = Math.max(0, Math.min(range.start, textLength));
  const end = Math.max(start, Math.min(range.end, textLength));
  return end > start ? { start, end } : null;
}

function HighlightedText({
  ranges,
  text,
}: {
  ranges: ThreadSearchMatch["highlightRanges"];
  text: string;
}) {
  if (ranges.length === 0 || text.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  const sortedRanges = ranges
    .map((range) => clampRange(range, text.length))
    .filter((range): range is NonNullable<typeof range> => range !== null)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  for (const range of sortedRanges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(
      <mark
        key={`${range.start}:${range.end}`}
        className="rounded-sm bg-state-selected px-0 text-foreground"
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function getTitleMatch(
  title: string,
  matches: readonly ThreadSearchMatch[],
): ThreadSearchMatch | undefined {
  return matches.find(
    (match) => isThreadTitleMatch(match) && match.text === title,
  );
}

function getSnippetMatch(
  matches: readonly ThreadSearchMatch[],
): ThreadSearchMatch | undefined {
  return matches.find((match) => !isThreadTitleMatch(match));
}

function isNonEmptyMetadataPart(value: string | null): value is string {
  return value !== null && value.length > 0;
}

function ThreadPaletteResultRowComponent({
  id,
  isActive,
  matches,
  onActive,
  onSelect,
  projectName,
  thread,
}: {
  id: string;
  isActive: boolean;
  matches: readonly ThreadSearchMatch[];
  onActive: () => void;
  onSelect: () => void;
  projectName: string | undefined;
  thread: ThreadListEntry;
}) {
  const title = getThreadDisplayTitle(thread);
  const titleMatch = getTitleMatch(title, matches);
  const snippetMatch = getSnippetMatch(matches);
  const primaryMatch = snippetMatch ?? titleMatch;
  const primaryText = primaryMatch?.text ?? title;
  const primaryHighlightRanges = primaryMatch?.highlightRanges ?? [];
  const threadUnreadDone = isUnreadDoneThread(thread);
  const hasUnsubmittedDraft = usePromptDraftHasInput({
    kind: "thread",
    projectId: thread.projectId,
    threadId: thread.id,
  });
  const indicatorState: ThreadListIndicatorState = {
    hasPendingInteraction: thread.hasPendingInteraction,
    hasUnsubmittedDraft,
    hasUnreadError: threadUnreadDone && thread.status === "error",
    hasUnreadSuccess: threadUnreadDone && thread.status !== "error",
    isBackgroundAgentActive: hasActiveBackgroundAgentActivity(thread),
    isBackgroundCommandActive: hasActiveBackgroundCommandActivity(thread),
    isGoalActive: hasActiveGoalActivity(thread),
    queuedWork: thread.queuedWork,
    isPlanModeActive: hasActivePlanModeActivity(thread),
    isRuntimeActive: isRuntimeBusyThread(thread),
    isWorkflowActive: hasActiveWorkflowActivity(thread),
  };
  const indicatorKind = resolveThreadListIndicator(indicatorState);
  const projectMetadata =
    thread.projectId !== PERSONAL_PROJECT_ID && projectName
      ? projectName
      : null;
  const relativeTime = formatRelativeTime({
    timestamp: thread.updatedAt,
    now: Date.now(),
  });
  const metadataText = [
    snippetMatch ? title : null,
    projectMetadata,
    relativeTime,
  ]
    .filter(isNonEmptyMetadataPart)
    .join(" · ");
  const handleMouseEnter = useCallback<MouseEventHandler<HTMLButtonElement>>(
    () => onActive(),
    [onActive],
  );

  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={isActive}
      className={cn(
        "flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none",
        isActive && "bg-state-hover text-foreground",
      )}
      onMouseEnter={handleMouseEnter}
      onFocus={onActive}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block min-w-0 truncate">
          <HighlightedText text={primaryText} ranges={primaryHighlightRanges} />
        </span>
        <span
          className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground"
          title={metadataText}
        >
          {snippetMatch ? (
            <Icon
              name="MessageSquare"
              className="size-3 shrink-0 text-subtle-foreground"
              aria-hidden="true"
            />
          ) : projectMetadata ? (
            <Icon name="Folder" className="size-3.5 shrink-0" aria-hidden />
          ) : null}
          <span className="min-w-0 truncate">{metadataText}</span>
        </span>
      </span>
      {indicatorKind !== "none" ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <ThreadStatusGlyph {...indicatorState} />
        </span>
      ) : null}
    </button>
  );
}

const ThreadPaletteResultRow = memo(ThreadPaletteResultRowComponent);
