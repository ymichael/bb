// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import {
  gitDiffCollapsedFileKeysAtom,
  gitDiffLoadingFileKeysAtom,
  pendingGitDiffScrollPathAtom,
} from "../threadSecondaryPanelAtoms";
import {
  buildParsedGitDiffFileEntries,
  parseGitDiffFiles,
  type ParsedGitDiffFileEntry,
} from "../../git-diff/git-diff-parsing";
import { useGitDiffPanelState } from "./useGitDiffPanelState";
import { useGitDiffFileRenderQueue } from "./useGitDiffFileRenderQueue";

interface MockThreadGitDiffResponse {
  diff: string;
  files: string;
  mergeBaseRef: string | null;
  shortstat: string;
  truncated: boolean;
}

interface MockGitDiffQuery {
  data: MockThreadGitDiffResponse | undefined;
  error: Error | null;
  isLoading: boolean;
}

interface MockWorkspaceStatus {
  mergeBase: {
    commits: [];
  };
  workingTree: {
    files: string[];
  };
}

interface MockWorkStatusQuery {
  data: MockWorkspaceStatus;
}

interface MockEnvironmentQueries {
  gitDiff: MockGitDiffQuery;
  workStatus: MockWorkStatusQuery;
}

const mockEnvironmentQueries = vi.hoisted<MockEnvironmentQueries>(() => ({
  gitDiff: {
    data: undefined,
    error: null,
    isLoading: false,
  },
  workStatus: {
    data: {
      mergeBase: {
        commits: [],
      },
      workingTree: {
        files: [],
      },
    },
  },
}));

vi.mock("../../../hooks/queries/environment-queries", () => ({
  useEnvironmentGitDiff: () => mockEnvironmentQueries.gitDiff,
  useEnvironmentWorkStatus: () => mockEnvironmentQueries.workStatus,
}));

interface WrapperProps {
  children: ReactNode;
}

interface RenderQueueProps {
  environmentId?: string;
  expectedGitDiffFileCount: number;
  gitDiffIdentity: string;
  isDiffPanelActive: boolean;
  isParsingGitDiffFiles: boolean;
  parsedGitDiffFileEntries: ParsedGitDiffFileEntry[];
}

function buildPatchDiff(paths: readonly string[]): string {
  return paths.map((path) => buildModifiedFileDiff(path)).join("\n");
}

function buildModifiedFileDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-old line",
    "+new line",
    "",
  ].join("\n");
}

function buildEntries(paths: readonly string[]): ParsedGitDiffFileEntry[] {
  return buildParsedGitDiffFileEntries(parseGitDiffFiles(buildPatchDiff(paths)));
}

function makeThreadGitDiffResponse(diff: string): MockThreadGitDiffResponse {
  return {
    diff,
    files: "",
    mergeBaseRef: "merge-base",
    shortstat: "",
    truncated: false,
  };
}

function resetEnvironmentQueryMocks(): void {
  mockEnvironmentQueries.gitDiff.data = undefined;
  mockEnvironmentQueries.gitDiff.error = null;
  mockEnvironmentQueries.gitDiff.isLoading = false;
  mockEnvironmentQueries.workStatus.data = {
    mergeBase: {
      commits: [],
    },
    workingTree: {
      files: [],
    },
  };
}

function createTestWrapper(store: ReturnType<typeof createStore>) {
  const queryClient = createAppQueryClient({
    defaultOptions: {
      mutations: {
        retry: false,
      },
      queries: {
        gcTime: Infinity,
        retry: false,
      },
    },
  });

  return function TestWrapper({ children }: WrapperProps) {
    return (
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </JotaiProvider>
    );
  };
}

function renderQueueHook(initialProps: RenderQueueProps) {
  const store = createStore();
  const wrapper = createTestWrapper(store);
  const hook = renderHook(
    (props: RenderQueueProps) => useGitDiffFileRenderQueue(props),
    {
      initialProps,
      wrapper,
    },
  );

  return {
    ...hook,
    store,
  };
}

function renderPanelStateHook(store: ReturnType<typeof createStore>) {
  const wrapper = createTestWrapper(store);
  return renderHook(
    () =>
      useGitDiffPanelState({
        defaultMergeBaseBranch: "main",
        environmentId: "env-test",
        isDiffPanelActive: true,
      }),
    { wrapper },
  );
}

function sortedKeys(keys: ReadonlySet<string>): string[] {
  return Array.from(keys).sort();
}

beforeEach(() => {
  resetEnvironmentQueryMocks();
  window.requestAnimationFrame = (callback) =>
    window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (handle) => {
    window.clearTimeout(handle);
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useGitDiffFileRenderQueue", () => {
  it("focuses one file by collapsing every other diff card", () => {
    vi.useFakeTimers();
    const entries = buildEntries(["src/a.ts", "src/b.ts", "src/c.ts"]);
    const targetEntry = entries[1];
    expect(targetEntry).toBeDefined();
    if (!targetEntry) return;
    const { result, store } = renderQueueHook({
      environmentId: "env-test",
      expectedGitDiffFileCount: entries.length,
      gitDiffIdentity: "env-test:all:main:merge-base",
      isDiffPanelActive: true,
      isParsingGitDiffFiles: false,
      parsedGitDiffFileEntries: entries,
    });

    expect(sortedKeys(store.get(gitDiffLoadingFileKeysAtom))).toEqual(
      sortedKeys(new Set(entries.map((entry) => entry.key))),
    );

    act(() => {
      result.current.focusGitDiffFile(targetEntry.key);
    });

    expect(sortedKeys(store.get(gitDiffCollapsedFileKeysAtom))).toEqual(
      sortedKeys(
        new Set(
          entries
            .filter((entry) => entry.key !== targetEntry.key)
            .map((entry) => entry.key),
        ),
      ),
    );
    expect(store.get(gitDiffLoadingFileKeysAtom)).toEqual(
      new Set([targetEntry.key]),
    );
  });

  it("preserves bulk collapse within a diff identity and resets it for a new identity", () => {
    const firstEntries = buildEntries(["src/a.ts"]);
    const nextEntries = buildEntries(["src/a.ts", "src/b.ts"]);
    const { result, rerender, store } = renderQueueHook({
      environmentId: "env-test",
      expectedGitDiffFileCount: firstEntries.length,
      gitDiffIdentity: "env-test:commit:one",
      isDiffPanelActive: true,
      isParsingGitDiffFiles: false,
      parsedGitDiffFileEntries: firstEntries,
    });

    act(() => {
      result.current.toggleAllGitDiffFilesCollapsed();
    });
    expect(sortedKeys(store.get(gitDiffCollapsedFileKeysAtom))).toEqual(
      sortedKeys(new Set(firstEntries.map((entry) => entry.key))),
    );

    rerender({
      environmentId: "env-test",
      expectedGitDiffFileCount: nextEntries.length,
      gitDiffIdentity: "env-test:commit:one",
      isDiffPanelActive: true,
      isParsingGitDiffFiles: false,
      parsedGitDiffFileEntries: nextEntries,
    });
    expect(sortedKeys(store.get(gitDiffCollapsedFileKeysAtom))).toEqual(
      sortedKeys(new Set(nextEntries.map((entry) => entry.key))),
    );

    rerender({
      environmentId: "env-test",
      expectedGitDiffFileCount: nextEntries.length,
      gitDiffIdentity: "env-test:commit:two",
      isDiffPanelActive: true,
      isParsingGitDiffFiles: false,
      parsedGitDiffFileEntries: nextEntries,
    });
    expect(store.get(gitDiffCollapsedFileKeysAtom)).toEqual(new Set());
  });

  it("clears pending render timers and loading state when the diff identity changes", () => {
    vi.useFakeTimers();
    const identityAEntries = buildEntries([
      "src/shared.ts",
      "src/a-1.ts",
      "src/a-2.ts",
      "src/a-3.ts",
      "src/a-4.ts",
    ]);
    const identityBEntries = buildEntries(["src/shared.ts", "src/b-1.ts"]);
    const identityBLoadingKeys = new Set(
      identityBEntries.map((entry) => entry.key),
    );
    const { rerender, store } = renderQueueHook({
      environmentId: "env-test",
      expectedGitDiffFileCount: identityAEntries.length,
      gitDiffIdentity: "env-test:commit:a",
      isDiffPanelActive: true,
      isParsingGitDiffFiles: false,
      parsedGitDiffFileEntries: identityAEntries,
    });

    expect(sortedKeys(store.get(gitDiffLoadingFileKeysAtom))).toEqual(
      sortedKeys(new Set(identityAEntries.map((entry) => entry.key))),
    );

    rerender({
      environmentId: "env-test",
      expectedGitDiffFileCount: identityBEntries.length,
      gitDiffIdentity: "env-test:commit:b",
      isDiffPanelActive: true,
      isParsingGitDiffFiles: false,
      parsedGitDiffFileEntries: identityBEntries,
    });

    expect(sortedKeys(store.get(gitDiffLoadingFileKeysAtom))).toEqual(
      sortedKeys(identityBLoadingKeys),
    );

    act(() => {
      vi.advanceTimersByTime(30);
    });
    expect(sortedKeys(store.get(gitDiffLoadingFileKeysAtom))).toEqual(
      sortedKeys(identityBLoadingKeys),
    );

    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(store.get(gitDiffLoadingFileKeysAtom)).toEqual(new Set());
  });

  it("drains batched render loading state in the initial and follow-up waves", () => {
    vi.useFakeTimers();
    const entries = buildEntries(
      Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`),
    );
    const firstBatchKeys = new Set(
      entries.slice(0, 4).map((entry) => entry.key),
    );
    const secondBatchKeys = new Set(
      entries.slice(4, 10).map((entry) => entry.key),
    );
    const { store } = renderQueueHook({
      environmentId: "env-test",
      expectedGitDiffFileCount: entries.length,
      gitDiffIdentity: "env-test:commit:one",
      isDiffPanelActive: true,
      isParsingGitDiffFiles: false,
      parsedGitDiffFileEntries: entries,
    });

    expect(sortedKeys(store.get(gitDiffLoadingFileKeysAtom))).toEqual(
      sortedKeys(new Set(entries.map((entry) => entry.key))),
    );

    act(() => {
      vi.advanceTimersByTime(29);
    });
    expect(sortedKeys(store.get(gitDiffLoadingFileKeysAtom))).toEqual(
      sortedKeys(new Set(entries.map((entry) => entry.key))),
    );

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(sortedKeys(store.get(gitDiffLoadingFileKeysAtom))).toEqual(
      sortedKeys(secondBatchKeys),
    );
    for (const key of firstBatchKeys) {
      expect(store.get(gitDiffLoadingFileKeysAtom).has(key)).toBe(false);
    }

    act(() => {
      vi.advanceTimersByTime(69);
    });
    expect(sortedKeys(store.get(gitDiffLoadingFileKeysAtom))).toEqual(
      sortedKeys(secondBatchKeys),
    );

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(store.get(gitDiffLoadingFileKeysAtom)).toEqual(new Set());
  });

  it("toggles all files between collapsed and render-queued expanded states", () => {
    vi.useFakeTimers();
    const entries = buildEntries(["src/a.ts", "src/b.ts"]);
    const { result, store } = renderQueueHook({
      environmentId: "env-test",
      expectedGitDiffFileCount: entries.length,
      gitDiffIdentity: "env-test:commit:one",
      isDiffPanelActive: true,
      isParsingGitDiffFiles: false,
      parsedGitDiffFileEntries: entries,
    });

    act(() => {
      result.current.toggleAllGitDiffFilesCollapsed();
    });
    expect(sortedKeys(store.get(gitDiffCollapsedFileKeysAtom))).toEqual(
      sortedKeys(new Set(entries.map((entry) => entry.key))),
    );
    expect(store.get(gitDiffLoadingFileKeysAtom)).toEqual(new Set());

    act(() => {
      result.current.toggleAllGitDiffFilesCollapsed();
    });
    expect(store.get(gitDiffCollapsedFileKeysAtom)).toEqual(new Set());
    expect(sortedKeys(store.get(gitDiffLoadingFileKeysAtom))).toEqual(
      sortedKeys(new Set(entries.map((entry) => entry.key))),
    );
  });

  it("cancels a queued render when that file collapses", () => {
    vi.useFakeTimers();
    const entries = buildEntries([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
    ]);
    const targetEntry = entries[4];
    expect(targetEntry).toBeDefined();
    if (!targetEntry) return;
    const { result, store } = renderQueueHook({
      environmentId: "env-test",
      expectedGitDiffFileCount: entries.length,
      gitDiffIdentity: "env-test:commit:one",
      isDiffPanelActive: true,
      isParsingGitDiffFiles: false,
      parsedGitDiffFileEntries: entries,
    });

    expect(store.get(gitDiffLoadingFileKeysAtom).has(targetEntry.key)).toBe(
      true,
    );

    act(() => {
      result.current.toggleGitDiffFileCollapsed(targetEntry.key);
    });

    expect(store.get(gitDiffCollapsedFileKeysAtom).has(targetEntry.key)).toBe(
      true,
    );
    expect(store.get(gitDiffLoadingFileKeysAtom).has(targetEntry.key)).toBe(
      false,
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(store.get(gitDiffLoadingFileKeysAtom).has(targetEntry.key)).toBe(
      false,
    );
  });
});

describe("useGitDiffPanelState pending scroll", () => {
  it("keeps a pending scroll path while the diff is still loading", () => {
    mockEnvironmentQueries.gitDiff.isLoading = true;
    const store = createStore();
    renderPanelStateHook(store);

    act(() => {
      store.set(pendingGitDiffScrollPathAtom, "src/target.ts");
    });

    expect(store.get(pendingGitDiffScrollPathAtom)).toBe("src/target.ts");
  });

  it("keeps a pending scroll path while the current diff is still parsing", async () => {
    vi.useFakeTimers();
    mockEnvironmentQueries.gitDiff.isLoading = true;
    const paths = Array.from({ length: 25 }, (_, index) =>
      index === 24 ? "src/target.ts" : `src/file-${index}.ts`,
    );
    const store = createStore();
    const { rerender } = renderPanelStateHook(store);

    act(() => {
      store.set(pendingGitDiffScrollPathAtom, "src/target.ts");
    });
    expect(store.get(pendingGitDiffScrollPathAtom)).toBe("src/target.ts");

    mockEnvironmentQueries.gitDiff.isLoading = false;
    mockEnvironmentQueries.gitDiff.data = makeThreadGitDiffResponse(
      buildPatchDiff(paths),
    );
    rerender();

    expect(store.get(pendingGitDiffScrollPathAtom)).toBe("src/target.ts");
    await act(async () => {
      vi.runAllTimers();
    });
    await act(async () => {
      vi.runAllTimers();
    });
    expect(store.get(pendingGitDiffScrollPathAtom)).toBeNull();
  });

  it("clears a pending scroll path when a loaded diff has no matching file", async () => {
    mockEnvironmentQueries.gitDiff.data = makeThreadGitDiffResponse(
      buildPatchDiff(["src/other.ts"]),
    );
    const store = createStore();
    const { result } = renderPanelStateHook(store);

    await waitFor(() => {
      expect(result.current.parsedGitDiffFileEntries).toHaveLength(1);
    });
    act(() => {
      store.set(pendingGitDiffScrollPathAtom, "src/missing.ts");
    });

    await waitFor(() => {
      expect(store.get(pendingGitDiffScrollPathAtom)).toBeNull();
    });
  });

  it("collapses every non-target file when opening the panel to a file", async () => {
    const diff = buildPatchDiff(["src/a.ts", "src/target.ts", "src/c.ts"]);
    const entries = buildParsedGitDiffFileEntries(parseGitDiffFiles(diff));
    const targetEntry = entries.find(({ fileDiff }) =>
      fileDiff.name.endsWith("target.ts"),
    );
    expect(targetEntry).toBeDefined();
    if (!targetEntry) return;
    mockEnvironmentQueries.gitDiff.data = makeThreadGitDiffResponse(diff);
    const store = createStore();
    const { result } = renderPanelStateHook(store);

    await waitFor(() => {
      expect(result.current.parsedGitDiffFileEntries).toHaveLength(3);
    });
    act(() => {
      store.set(pendingGitDiffScrollPathAtom, "src/target.ts");
    });

    await waitFor(() => {
      expect(sortedKeys(store.get(gitDiffCollapsedFileKeysAtom))).toEqual(
        sortedKeys(
          new Set(
            entries
              .filter((entry) => entry.key !== targetEntry.key)
              .map((entry) => entry.key),
          ),
        ),
      );
    });
  });
});
