// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Provider as JotaiProvider } from "jotai";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useSetThreadSecondaryPanel,
  useThreadSecondaryPanelState,
  useThreadSecondaryPanelStorageMaintenance,
  useThreadSecondaryPanelUrlSync,
  useTouchThreadSecondaryPanelState,
} from "./thread-secondary-panel";
import {
  createEmptyThreadSecondaryPanelState,
  EMPTY_THREAD_SECONDARY_PANEL_STATE,
  getThreadSecondaryPanelStateStorageKey,
  parseThreadSecondaryPanelState,
  serializeThreadSecondaryPanelState,
  THREAD_SECONDARY_PANEL_IDLE_EXPIRY_MS,
  type ThreadSecondaryPanelState,
} from "./thread-secondary-panel-state";

const NOW = 1_700_000_000_000;

interface TestWrapperProps {
  children: ReactNode;
}

interface UrlSyncHookProps {
  threadId: string;
}

interface ThreadIdHookProps {
  threadId: string;
}

function createTestWrapper(initialEntries: readonly string[]) {
  return function TestWrapper({ children }: TestWrapperProps) {
    return (
      <JotaiProvider>
        <MemoryRouter initialEntries={[...initialEntries]}>
          {children}
        </MemoryRouter>
      </JotaiProvider>
    );
  };
}

function readStoredState(threadId: string): ThreadSecondaryPanelState {
  return parseThreadSecondaryPanelState({
    initialValue: EMPTY_THREAD_SECONDARY_PANEL_STATE,
    now: Date.now(),
    storedValue: window.localStorage.getItem(
      getThreadSecondaryPanelStateStorageKey({ threadId }),
    ),
  });
}

function seedStoredState(
  threadId: string,
  state: ThreadSecondaryPanelState,
): void {
  window.localStorage.setItem(
    getThreadSecondaryPanelStateStorageKey({ threadId }),
    serializeThreadSecondaryPanelState({ state }),
  );
}

function useUrlSyncProbe({ threadId }: UrlSyncHookProps) {
  useThreadSecondaryPanelUrlSync(threadId);
  const location = useLocation();
  return {
    location,
    state: useThreadSecondaryPanelState(threadId),
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("thread secondary panel state hooks", () => {
  it("prunes expired storage on mount and thread id changes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const mountExpiredThreadId = "thr-expired-on-mount";
    const mountExpiredKey = getThreadSecondaryPanelStateStorageKey({
      threadId: mountExpiredThreadId,
    });
    seedStoredState(
      mountExpiredThreadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "thread-info",
        lastUsedAt: NOW - THREAD_SECONDARY_PANEL_IDLE_EXPIRY_MS - 1,
      }),
    );
    const { rerender } = renderHook(
      (props: ThreadIdHookProps) =>
        useThreadSecondaryPanelStorageMaintenance(props.threadId),
      {
        initialProps: { threadId: "thr-current-maintenance" },
        wrapper: createTestWrapper([
          "/projects/proj-one/threads/thr-current-maintenance",
        ]),
      },
    );

    await waitFor(() => {
      expect(window.localStorage.getItem(mountExpiredKey)).toBeNull();
    });

    const changeExpiredThreadId = "thr-expired-on-change";
    const changeExpiredKey = getThreadSecondaryPanelStateStorageKey({
      threadId: changeExpiredThreadId,
    });
    seedStoredState(
      changeExpiredThreadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "git-diff",
        lastUsedAt: NOW - THREAD_SECONDARY_PANEL_IDLE_EXPIRY_MS - 1,
      }),
    );
    expect(window.localStorage.getItem(changeExpiredKey)).not.toBeNull();

    rerender({ threadId: "thr-next-maintenance" });

    await waitFor(() => {
      expect(window.localStorage.getItem(changeExpiredKey)).toBeNull();
    });
  });

  it("does not prune unrelated expired thread state on state writes", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const currentThreadId = "thr-current-write";
    const expiredThreadId = "thr-expired-write";
    const expiredKey = getThreadSecondaryPanelStateStorageKey({
      threadId: expiredThreadId,
    });
    seedStoredState(
      expiredThreadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "thread-info",
        lastUsedAt: NOW - THREAD_SECONDARY_PANEL_IDLE_EXPIRY_MS - 1,
      }),
    );
    const { result } = renderHook(
      () => useSetThreadSecondaryPanel(currentThreadId),
      {
        wrapper: createTestWrapper([
          "/projects/proj-one/threads/thr-current-write",
        ]),
      },
    );

    act(() => {
      result.current("thread-info");
    });

    expect(window.localStorage.getItem(expiredKey)).not.toBeNull();
    expect(readStoredState(currentThreadId).activePanel).toBe("thread-info");
  });

  it("treats URL panel values as one-shot overrides without rewriting unchanged state", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const threadId = "thr-url-unchanged";
    seedStoredState(
      threadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "thread-info",
        lastUsedAt: NOW,
      }),
    );
    dateNowSpy.mockReturnValue(NOW + 10_000);
    const { result } = renderHook(
      (props: UrlSyncHookProps) => useUrlSyncProbe(props),
      {
        initialProps: { threadId },
        wrapper: createTestWrapper([
          "/projects/proj-one/threads/thr-url-unchanged?secondaryPanel=thread-info&tab=logs",
        ]),
      },
    );

    await waitFor(() => {
      expect(result.current.location.search).toBe("?tab=logs");
    });

    expect(result.current.state.activePanel).toBe("thread-info");
    expect(readStoredState(threadId).lastUsedAt).toBe(NOW);
  });

  it("does not let a consumed URL override rewrite another thread preference", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const sourceThreadId = "thr-url-source";
    const nextThreadId = "thr-url-next";
    seedStoredState(
      nextThreadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "thread-info",
        lastUsedAt: NOW,
      }),
    );
    const { result, rerender } = renderHook(
      (props: UrlSyncHookProps) => useUrlSyncProbe(props),
      {
        initialProps: { threadId: sourceThreadId },
        wrapper: createTestWrapper([
          "/projects/proj-one/threads/thr-url-source?secondaryPanel=git-diff",
        ]),
      },
    );

    await waitFor(() => {
      expect(result.current.location.search).toBe("");
    });
    expect(readStoredState(sourceThreadId).activePanel).toBe("git-diff");

    rerender({ threadId: nextThreadId });

    expect(readStoredState(nextThreadId).activePanel).toBe("thread-info");
    expect(readStoredState(nextThreadId).lastUsedAt).toBe(NOW);
  });

  it("leaves persisted panel state alone when the URL omits an override", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const threadId = "thr-url-omitted";
    seedStoredState(
      threadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "git-diff",
        lastUsedAt: NOW,
      }),
    );
    const { result } = renderHook(
      (props: UrlSyncHookProps) => useUrlSyncProbe(props),
      {
        initialProps: { threadId },
        wrapper: createTestWrapper([
          "/projects/proj-one/threads/thr-url-omitted",
        ]),
      },
    );

    expect(result.current.state.activePanel).toBe("git-diff");
    expect(readStoredState(threadId).lastUsedAt).toBe(NOW);
  });

  it("coarsens panel focus touches to minute-scale storage writes", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const threadId = "thr-focus-touch";
    seedStoredState(
      threadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "thread-info",
        lastUsedAt: NOW,
      }),
    );
    const { result } = renderHook(
      () => useTouchThreadSecondaryPanelState(threadId),
      {
        wrapper: createTestWrapper([
          "/projects/proj-one/threads/thr-focus-touch",
        ]),
      },
    );

    dateNowSpy.mockReturnValue(NOW + 1_000);
    act(() => {
      result.current();
    });
    expect(readStoredState(threadId).lastUsedAt).toBe(NOW);

    dateNowSpy.mockReturnValue(NOW + 62_000);
    act(() => {
      result.current();
    });
    expect(readStoredState(threadId).lastUsedAt).toBe(NOW + 62_000);
  });

  it("does not suppress the first focus touch after switching threads", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const firstThreadId = "thr-focus-first";
    const secondThreadId = "thr-focus-second";
    seedStoredState(
      firstThreadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "thread-info",
        lastUsedAt: NOW - 61_000,
      }),
    );
    seedStoredState(
      secondThreadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "thread-info",
        lastUsedAt: NOW - 61_000,
      }),
    );
    const { result, rerender } = renderHook(
      (props: ThreadIdHookProps) =>
        useTouchThreadSecondaryPanelState(props.threadId),
      {
        initialProps: { threadId: firstThreadId },
        wrapper: createTestWrapper([
          "/projects/proj-one/threads/thr-focus-first",
        ]),
      },
    );

    act(() => {
      result.current();
    });
    expect(readStoredState(firstThreadId).lastUsedAt).toBe(NOW);

    dateNowSpy.mockReturnValue(NOW + 1_000);
    rerender({ threadId: secondThreadId });
    act(() => {
      result.current();
    });

    expect(readStoredState(secondThreadId).lastUsedAt).toBe(NOW + 1_000);
  });

  it("preserves secondary panel fields when focus touch refreshes lastUsedAt", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW - 61_000);
    const threadId = "thr-focus-preserve-fields";
    const fileTabs = {
      workspace: [
        {
          lineNumber: 5,
          path: "src/app.ts",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      ],
      storage: ["STATUS.md"],
      hostFiles: [{ lineNumber: 3, path: "/Users/me/notes.md" }],
      active: { type: "workspace", path: "src/app.ts" },
    } satisfies ThreadSecondaryPanelState["fileTabs"];
    seedStoredState(
      threadId,
      createEmptyThreadSecondaryPanelState({
        activePanel: "git-diff",
        environmentId: "env-one",
        fileTabs,
        lastUsedAt: NOW - 61_000,
      }),
    );
    const { result } = renderHook(
      () => useTouchThreadSecondaryPanelState(threadId),
      {
        wrapper: createTestWrapper([
          "/projects/proj-one/threads/thr-focus-preserve-fields",
        ]),
      },
    );

    dateNowSpy.mockReturnValue(NOW);
    act(() => {
      result.current();
    });

    const storedState = readStoredState(threadId);
    expect(storedState.activePanel).toBe("git-diff");
    expect(storedState.environmentId).toBe("env-one");
    expect(storedState.fileTabs).toEqual(fileTabs);
    expect(storedState.lastUsedAt).toBe(NOW);
  });
});
