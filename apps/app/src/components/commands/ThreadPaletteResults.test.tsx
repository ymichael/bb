// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadListEntry } from "@bb/domain";
import type {
  ThreadSearchMatch,
  ThreadSearchResponse,
} from "@bb/server-contract";
import {
  useThreadSearch,
  type UseThreadSearchResult,
} from "@/hooks/queries/thread-queries";
import {
  ThreadPaletteResults,
  type ThreadPaletteNavigationItem,
} from "./ThreadPaletteResults";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";

vi.mock("@/hooks/queries/thread-queries", () => ({
  hasThreadSearchableQuery: (value: string) =>
    value.replace(/\s/g, "").length >= 2,
  useThreadSearch: vi.fn(),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("@/components/thread/ThreadTitleMentions", () => ({
  useThreadTitleMentionResources: () => ({
    projectNamesById: new Map<string, string>(),
  }),
}));

const mockUseThreadSearch = vi.mocked(useThreadSearch);

function createThreadListEntry({
  id,
  title,
}: {
  id: string;
  title: string;
}): ThreadListEntry {
  return makeThreadListEntry({
    createdAt: 1000,
    id,
    lastReadAt: null,
    latestAttentionAt: 1000,
    projectId: "proj_search",
    title,
    updatedAt: 1000,
  });
}

function createSearchResponse(
  thread: ThreadListEntry,
  matches: readonly ThreadSearchMatch[] = [],
): ThreadSearchResponse {
  return {
    active: { results: [{ matches: [...matches], thread }], total: 1 },
    archived: { results: [], total: 0 },
  };
}

function mockThreadSearch(result: UseThreadSearchResult): void {
  mockUseThreadSearch.mockReturnValue(result);
}

function renderResults({
  onNavigationItemsChange = vi.fn(),
  query,
}: {
  onNavigationItemsChange?: (
    items: readonly ThreadPaletteNavigationItem[],
  ) => void;
  query: string;
}) {
  return render(
    <ThreadPaletteResults
      activeIndex={0}
      onActiveIndexChange={vi.fn()}
      onNavigationItemsChange={onNavigationItemsChange}
      onSelect={vi.fn()}
      optionIdPrefix="palette-option"
      query={query}
    />,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("ThreadPaletteResults", () => {
  it("clears stale rows while the visible query is debouncing", () => {
    mockThreadSearch({
      data: createSearchResponse(
        createThreadListEntry({ id: "thr_previous", title: "Previous needle" }),
      ),
      debouncedQuery: "needle",
      hasSearchableQuery: true,
      isDebouncing: true,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    renderResults({ query: "needle updated" });

    expect(screen.getByText("Searching threads...")).not.toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("uses the palette option prefix for the active row", () => {
    mockThreadSearch({
      data: createSearchResponse(
        createThreadListEntry({ id: "thr_current", title: "Current needle" }),
      ),
      debouncedQuery: "needle",
      hasSearchableQuery: true,
      isDebouncing: false,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    renderResults({ query: "needle" });

    expect(screen.getByRole("option").id).toBe(
      "palette-option-active:thr_current",
    );
  });

  it("keeps the matched message sequence in its navigation item", async () => {
    const onNavigationItemsChange = vi.fn();
    const messageMatch: ThreadSearchMatch = {
      highlightRanges: [{ start: 0, end: 6 }],
      sourceKind: "user_message",
      sourceSeq: 7,
      text: "Needle in a message",
    };
    mockThreadSearch({
      data: createSearchResponse(
        createThreadListEntry({ id: "thr_message", title: "Message match" }),
        [messageMatch],
      ),
      debouncedQuery: "needle",
      hasSearchableQuery: true,
      isDebouncing: false,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    renderResults({ onNavigationItemsChange, query: "needle" });

    await waitFor(() =>
      expect(onNavigationItemsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ threadId: "thr_message", messageSeq: 7 }),
      ]),
    );
  });

  it("shows an archived overflow count", () => {
    const archivedThread = createThreadListEntry({
      id: "thr_archived",
      title: "Archived cleanup",
    });
    mockThreadSearch({
      data: {
        active: { results: [], total: 0 },
        archived: {
          results: [{ matches: [], thread: archivedThread }],
          total: 3,
        },
      },
      debouncedQuery: "cleanup",
      hasSearchableQuery: true,
      isDebouncing: false,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    renderResults({ query: "cleanup" });

    expect(screen.getByText("Archived")).not.toBeNull();
    expect(screen.getByText("1/3")).not.toBeNull();
  });
});
