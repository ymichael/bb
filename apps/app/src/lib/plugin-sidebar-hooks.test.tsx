// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import {
  useSidebarThreadActions,
  useSidebarThreads,
} from "./plugin-sidebar-hooks";

const actions = vi.hoisted(() => ({
  navigate: vi.fn(),
  setRootComposeProjectId: vi.fn(),
}));

const state = vi.hoisted(() => ({
  data: undefined as
    | {
        sections: never[];
        projects: { id: string; name: string; threads: ThreadListEntry[] }[];
        personalProject: {
          id: string;
          name: string;
          threads: ThreadListEntry[];
        };
      }
    | undefined,
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({ data: state.data, isError: false }),
}));

vi.mock("@/hooks/queries/host-queries", () => {
  const hosts: never[] = [];
  return { useHosts: () => ({ data: hosts }) };
});

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    archiveThreadAndChildren: vi.fn(),
    requestDelete: vi.fn(),
    togglePin: vi.fn(),
    toggleRead: vi.fn(),
  }),
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => ({
  useUpdateThread: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/components/ui/app-route-anchor", () => ({
  useRouteNavigate: () => actions.navigate,
}));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => false,
}));

vi.mock("./root-compose-selection", () => ({
  useSetRootComposeProjectId: () => actions.setRootComposeProjectId,
}));

function payload(threads: ThreadListEntry[]) {
  return {
    sections: [],
    projects: [{ id: "proj_app", name: "App", threads }],
    personalProject: { id: PERSONAL_PROJECT_ID, name: "Personal", threads: [] },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.data = undefined;
});

describe("useSidebarThreads", () => {
  it("keeps DTO identity for entries that did not change across a sidebar update", () => {
    const stable = makeThreadListEntry({ id: "thr_stable", title: "Stable" });
    const changing = makeThreadListEntry({ id: "thr_changing", title: "One" });
    state.data = payload([stable, changing]);
    const { result, rerender } = renderHook(() => useSidebarThreads());
    const before = result.current.threads;
    expect(before.map((thread) => thread.id)).toEqual([
      "thr_stable",
      "thr_changing",
    ]);

    state.data = payload([
      stable,
      makeThreadListEntry({ id: "thr_changing", title: "Two" }),
    ]);
    rerender();
    const after = result.current.threads;
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]?.title).toBe("Two");
  });

  it("shares DTO identity between two consumers of the same payload", () => {
    const stable = makeThreadListEntry({ id: "thr_stable", title: "Stable" });
    state.data = payload([stable]);
    const first = renderHook(() => useSidebarThreads());
    const second = renderHook(() => useSidebarThreads());
    expect(second.result.current.threads[0]).toBe(
      first.result.current.threads[0],
    );
    const before = first.result.current.threads[0];
    first.rerender();
    second.rerender();
    expect(first.result.current.threads[0]).toBe(before);
    expect(second.result.current.threads[0]).toBe(before);
  });
});

describe("useSidebarThreadActions", () => {
  it("opens a project composer without a legacy route transition", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());

    act(() => {
      result.current.openNewThread({
        projectId: "proj_target",
        focusPrompt: true,
      });
    });

    expect(actions.setRootComposeProjectId).toHaveBeenCalledWith("proj_target");
    expect(actions.navigate).toHaveBeenCalledWith("/", {
      state: { focusPrompt: true },
    });
  });
});
