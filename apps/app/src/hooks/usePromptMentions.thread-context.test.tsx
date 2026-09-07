// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { makeThread } from "@bb/test-helpers/domain-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePromptMentions } from "./usePromptMentions";

const mocks = vi.hoisted(() => ({
  usePathSuggestions: vi.fn(),
  usePluginContributions: vi.fn(),
  usePluginMentionSearch: vi.fn(),
  useSidebarNavigation: vi.fn(),
  useThreadMentionCandidates: vi.fn(),
}));

vi.mock("./usePathSuggestions", () => ({
  PATH_SUGGESTION_DEBOUNCE_MS: 0,
  usePathSuggestions: mocks.usePathSuggestions,
}));

vi.mock("./queries/plugin-contribution-queries", () => ({
  usePluginContributions: mocks.usePluginContributions,
  usePluginMentionSearch: mocks.usePluginMentionSearch,
}));

vi.mock("./queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: mocks.useSidebarNavigation,
}));

vi.mock("./queries/thread-queries", () => ({
  useThreadMentionCandidates: mocks.useThreadMentionCandidates,
}));

beforeEach(() => {
  mocks.usePathSuggestions.mockReturnValue({
    suggestions: [],
    isLoading: false,
    isError: false,
    isDebouncing: false,
  });
  mocks.usePluginContributions.mockReturnValue({
    data: { mentionProviders: [] },
  });
  mocks.usePluginMentionSearch.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
  mocks.useSidebarNavigation.mockReturnValue({ data: undefined });
  mocks.useThreadMentionCandidates.mockReturnValue({
    data: [
      makeThread({
        id: "thr_existing",
        projectId: "proj_1",
        environmentId: "env_worktree",
        title: "Only worktree thread",
        titleFallback: null,
        lastReadAt: null,
        latestAttentionAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    ],
    isLoading: false,
    isFetching: false,
    isError: false,
  });
});

describe("usePromptMentions thread contexts", () => {
  it("can mention the only thread in a reused worktree while searching its storage", () => {
    const { result } = renderHook(() =>
      usePromptMentions("proj_1", {
        environmentId: "env_worktree",
        threadStorageThreadId: "thr_existing",
      }),
    );

    act(() => {
      result.current.setQuery("Only worktree", "@");
    });

    expect(result.current.results.suggestions).toEqual([
      expect.objectContaining({
        kind: "thread",
        threadId: "thr_existing",
      }),
    ]);
    expect(mocks.usePathSuggestions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        currentThreadId: "thr_existing",
        environmentId: "env_worktree",
      }),
    );
  });
});
