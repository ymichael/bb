import type { ThreadListEntry } from "@bb/domain";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { describe, expect, it } from "vitest";
import { buildPinnedSidebarState } from "../src/sidebar/pinnedSidebarThreads.js";

type ThreadListEntryOverrides = Partial<ThreadListEntry>;

function createThread(
  overrides: ThreadListEntryOverrides = {},
): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_1",
    projectId: "proj_1",
    title: "Thread",
    titleFallback: "Thread",
    lastReadAt: 0,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

function rootIds(state: ReturnType<typeof buildPinnedSidebarState>): string[] {
  return state.rootNodes.map((node) => node.thread.id);
}

describe("buildPinnedSidebarState", () => {
  it("sorts visible pinned roots by global pin sort key", () => {
    const state = buildPinnedSidebarState({
      threads: [
        createThread({
          id: "unpinned",
          createdAt: 4,
        }),
        createThread({
          id: "pinned-late",
          pinnedAt: 1_000,
          pinSortKey: "b",
        }),
        createThread({
          id: "pinned-early",
          pinnedAt: 2_000,
          pinSortKey: "a",
        }),
      ],
    });

    expect(rootIds(state)).toEqual(["pinned-early", "pinned-late"]);
    expect([...state.effectivePinnedThreadIds].sort()).toEqual([
      "pinned-early",
      "pinned-late",
    ]);
  });

  it("orders pin sort keys by codepoint, not locale", () => {
    const state = buildPinnedSidebarState({
      threads: [
        createThread({
          id: "pinned-lower",
          pinnedAt: 1_000,
          pinSortKey: "a",
        }),
        createThread({
          id: "pinned-upper",
          pinnedAt: 2_000,
          pinSortKey: "Z",
        }),
      ],
    });

    expect(rootIds(state)).toEqual(["pinned-upper", "pinned-lower"]);
  });

  it("moves every descendant with a pinned parent regardless of type", () => {
    const state = buildPinnedSidebarState({
      threads: [
        createThread({
          id: "standard-parent",
          pinnedAt: 1_000,
          pinSortKey: "a",
        }),
        createThread({
          id: "manager-child",
          parentThreadId: "standard-parent",
        }),
        createThread({
          id: "standard-grandchild",
          parentThreadId: "manager-child",
        }),
        createThread({
          id: "root",
        }),
      ],
    });

    expect([...state.effectivePinnedThreadIds].sort()).toEqual([
      "manager-child",
      "standard-grandchild",
      "standard-parent",
    ]);
    expect(rootIds(state)).toEqual(["standard-parent"]);
    expect(state.rootNodes[0]?.stats.childCount).toBe(2);
  });

  it("renders an explicitly pinned child as a root when its parent is not pinned", () => {
    const state = buildPinnedSidebarState({
      threads: [
        createThread({
          id: "parent",
        }),
        createThread({
          id: "child",
          parentThreadId: "parent",
          pinnedAt: 1_000,
          pinSortKey: "a",
        }),
      ],
    });

    expect(rootIds(state)).toEqual(["child"]);
  });

  it("does not pull source-derived forks in as pinned descendants", () => {
    const state = buildPinnedSidebarState({
      threads: [
        createThread({
          id: "parent",
          pinnedAt: 1_000,
          pinSortKey: "a",
        }),
        createThread({
          id: "fork",
          sourceThreadId: "parent",
          originKind: "fork",
        }),
      ],
    });

    expect(rootIds(state)).toEqual(["parent"]);
    expect(state.rootNodes[0]?.stats.childCount).toBe(0);
  });

  it("hides an explicitly pinned child under its pinned ancestor root", () => {
    const state = buildPinnedSidebarState({
      threads: [
        createThread({
          id: "parent",
          pinnedAt: 2_000,
          pinSortKey: "a",
        }),
        createThread({
          id: "child",
          parentThreadId: "parent",
          pinnedAt: 1_000,
          pinSortKey: "b",
        }),
      ],
    });

    expect(rootIds(state)).toEqual(["parent"]);
    expect(state.rootNodes[0]?.children[0]).toMatchObject({
      kind: "thread",
    });
    expect(state.rootNodes[0]?.stats.childCount).toBe(1);
  });

  it("keeps pinned roots flat even when they have sections", () => {
    const state = buildPinnedSidebarState({
      threads: [
        createThread({
          id: "a",
          title: "Alpha",
          sectionId: "sec_work",
          pinnedAt: 1_000,
          pinSortKey: "a",
        }),
      ],
    });

    expect(rootIds(state)).toEqual(["a"]);
  });
});
