import type { ThreadListEntry } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import {
  buildParentSelectorOptions,
  isRootThread,
} from "./threadParentSelectorOptions";

type ThreadListEntryOverrides = Partial<ThreadListEntry>;

function makeThread(overrides: ThreadListEntryOverrides = {}): ThreadListEntry {
  return makeThreadListEntry({
    createdAt: 1,
    id: "thr_1",
    lastReadAt: null,
    latestAttentionAt: 1,
    projectId: "proj_1",
    title: "Thread",
    titleFallback: "Thread",
    updatedAt: 1,
    ...overrides,
  });
}

describe("thread parent selector options", () => {
  it("allows threads as parent candidates", () => {
    const options = buildParentSelectorOptions({
      currentThreadId: "thr_child",
      parentThreadDisplayName: null,
      parentThreadId: null,
      parentThreads: [
        makeThread({ id: "thr_standard_parent", title: "Standard parent" }),
        makeThread({
          id: "thr_review_parent",
          title: "Review parent",
        }),
      ],
    });

    expect(options).toEqual([
      { value: "none", label: "None" },
      { value: "thr_standard_parent", label: "Standard parent" },
      { value: "thr_review_parent", label: "Review parent" },
    ]);
  });

  it("prioritizes threads with children while preserving group order", () => {
    const options = buildParentSelectorOptions({
      currentThreadId: "thr_current",
      parentThreadDisplayName: null,
      parentThreadId: null,
      parentThreads: [
        makeThread({ id: "thr_leaf_new", title: "New leaf" }),
        makeThread({
          id: "thr_child_two",
          parentThreadId: "thr_parent_two",
          title: "Child two",
        }),
        makeThread({ id: "thr_parent_two", title: "Parent two" }),
        makeThread({ id: "thr_parent_one", title: "Parent one" }),
        makeThread({
          id: "thr_child_one",
          parentThreadId: "thr_parent_one",
          title: "Child one",
        }),
        makeThread({ id: "thr_leaf_old", title: "Old leaf" }),
      ],
    });

    expect(options).toEqual([
      { value: "none", label: "None" },
      { value: "thr_parent_two", label: "Parent two" },
      { value: "thr_parent_one", label: "Parent one" },
      { value: "thr_leaf_new", label: "New leaf" },
      { value: "thr_child_two", label: "Child two" },
      { value: "thr_child_one", label: "Child one" },
      { value: "thr_leaf_old", label: "Old leaf" },
    ]);
  });

  it("excludes the current thread and descendants from parent candidates", () => {
    const options = buildParentSelectorOptions({
      currentThreadId: "thr_parent",
      parentThreadDisplayName: null,
      parentThreadId: null,
      parentThreads: [
        makeThread({ id: "thr_parent", title: "Current thread" }),
        makeThread({
          id: "thr_child",
          parentThreadId: "thr_parent",
          title: "Child",
        }),
        makeThread({
          id: "thr_grandchild",
          parentThreadId: "thr_child",
          title: "Grandchild",
        }),
        makeThread({ id: "thr_sibling", title: "Sibling" }),
      ],
    });

    expect(options).toEqual([
      { value: "none", label: "None" },
      { value: "thr_sibling", label: "Sibling" },
    ]);
  });

  it("excludes side chats from parent candidates", () => {
    const options = buildParentSelectorOptions({
      currentThreadId: "thr_child",
      parentThreadDisplayName: null,
      parentThreadId: null,
      parentThreads: [
        makeThread({ id: "thr_parent", title: "Parent" }),
        makeThread({
          id: "thr_side_chat",
          visibility: "hidden",
          title: "Side chat",
        }),
      ],
    });

    expect(options).toEqual([
      { value: "none", label: "None" },
      { value: "thr_parent", label: "Parent" },
    ]);
  });

  it("only marks root threads as assignable", () => {
    expect(isRootThread(makeThread({ parentThreadId: null }))).toBe(true);
    expect(isRootThread(makeThread({ parentThreadId: "thr_parent" }))).toBe(
      false,
    );
    expect(isRootThread(makeThread({ visibility: "hidden" }))).toBe(false);
  });
});
