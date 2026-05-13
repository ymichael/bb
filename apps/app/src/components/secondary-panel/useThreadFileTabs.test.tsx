// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { Provider as JotaiProvider, createStore } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkspaceFileTabsAtom } from "./threadSecondaryPanelAtoms";
import { useThreadFileTabs } from "./useThreadFileTabs";

interface TestWrapperProps {
  children: ReactNode;
}

function renderThreadFileTabsHook() {
  const store = createStore();
  const wrapper = ({ children }: TestWrapperProps) => (
    <JotaiProvider store={store}>
      <MemoryRouter>{children}</MemoryRouter>
    </JotaiProvider>
  );
  const hook = renderHook(
    () =>
      useThreadFileTabs({
        environmentId: "env-1",
        isManagerThread: false,
        storageFiles: [],
        threadId: "thread-1",
      }),
    { wrapper },
  );

  return { ...hook, store };
}

afterEach(cleanup);

describe("useThreadFileTabs", () => {
  it("does not update workspace tabs when reopening the same structural source", () => {
    const { result, store } = renderThreadFileTabsHook();

    act(() => {
      result.current.openWorkspaceFile({
        lineNumber: null,
        path: "src/file.ts",
        source: { kind: "merge-base", ref: "abc1234" },
        statusLabel: "deleted",
      });
    });

    const firstTabs = store.get(openWorkspaceFileTabsAtom);
    expect(firstTabs).toHaveLength(1);

    act(() => {
      result.current.openWorkspaceFile({
        lineNumber: null,
        path: "src/file.ts",
        source: { kind: "merge-base", ref: "abc1234" },
        statusLabel: "deleted",
      });
    });

    expect(store.get(openWorkspaceFileTabsAtom)).toBe(firstTabs);
  });
});
