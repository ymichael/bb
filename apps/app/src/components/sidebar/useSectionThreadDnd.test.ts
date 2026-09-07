import type { ThreadListEntry } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  buildSectionThreadList,
  CHRONOLOGICAL_CONTAINER_ID,
} from "@bb/client-core";
import {
  collectSectionThreadDndLookup,
  PINNED_THREAD_PARENT_KEY,
  resolveSectionThreadDropDecision,
  resolveSectionThreadDropTarget,
  resolveSectionThreadSectionOverId,
  resolveProjectedSectionThreadDropTarget,
} from "./useSectionThreadDnd";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";

function createThread(overrides: Partial<ThreadListEntry>): ThreadListEntry {
  return makeThreadListEntry({
    id: "thread",
    projectId: "project",
    title: "Thread",
    titleFallback: "Thread",
    lastReadAt: 0,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

function createLookup() {
  return collectSectionThreadDndLookup(
    buildSectionThreadList(
      [
        createThread({ id: "in-a", sectionId: "a" }),
        createThread({ id: "loose", createdAt: 2 }),
      ],
      undefined,
      [
        { id: "a", name: "Section A" },
        { id: "b", name: "Empty Section B" },
      ],
    ),
    CHRONOLOGICAL_CONTAINER_ID,
  );
}

function createLookupWithPinnedThread(
  overrides: Partial<ThreadListEntry> = {},
) {
  return collectSectionThreadDndLookup(
    buildSectionThreadList(
      [
        createThread({ id: "in-a", sectionId: "a" }),
        createThread({ id: "loose", createdAt: 2 }),
      ],
      undefined,
      [
        { id: "a", name: "Section A" },
        { id: "b", name: "Empty Section B" },
      ],
    ),
    CHRONOLOGICAL_CONTAINER_ID,
    [
      createThread({
        id: "pinned-1",
        sectionId: "a",
        pinnedAt: 10,
        ...overrides,
      }),
      createThread({ id: "pinned-2", pinnedAt: 9 }),
    ],
  );
}

describe("section thread drop targets", () => {
  it("moves a loose thread onto an empty section header", () => {
    const lookup = createLookup();
    const sectionBKey = lookup.sectionParentKeyBySectionId.get("section:b");

    expect(sectionBKey).toBeDefined();
    expect(
      resolveSectionThreadDropTarget(lookup, "loose", sectionBKey ?? null),
    ).toEqual({
      activeId: "loose",
      fromParentKey: CHRONOLOGICAL_CONTAINER_ID,
      toParentKey: sectionBKey,
    });
  });

  it("accepts an empty section section itself as a target", () => {
    const lookup = createLookup();
    const sectionBKey = lookup.sectionParentKeyBySectionId.get("section:b");

    expect(
      resolveSectionThreadDropTarget(lookup, "loose", "section:b"),
    ).toEqual({
      activeId: "loose",
      fromParentKey: CHRONOLOGICAL_CONTAINER_ID,
      toParentKey: sectionBKey,
    });
  });

  it("moves a section thread back to the loose Threads section", () => {
    const lookup = createLookup();
    const sectionAKey = lookup.sectionParentKeyBySectionId.get("section:a");

    expect(resolveSectionThreadDropTarget(lookup, "in-a", "threads")).toEqual({
      activeId: "in-a",
      fromParentKey: sectionAKey,
      toParentKey: CHRONOLOGICAL_CONTAINER_ID,
    });
  });

  it("preserves a projected destination through self-collision", () => {
    const lookup = createLookup();
    const sectionBKey = lookup.sectionParentKeyBySectionId.get("section:b");

    expect(sectionBKey).toBeDefined();
    expect(
      resolveProjectedSectionThreadDropTarget(
        lookup,
        "loose",
        sectionBKey ?? null,
      ),
    ).toEqual({
      activeId: "loose",
      fromParentKey: CHRONOLOGICAL_CONTAINER_ID,
      toParentKey: sectionBKey,
    });
  });

  it("rejects same-parent and non-thread moves", () => {
    const lookup = createLookup();
    const sectionAKey = lookup.sectionParentKeyBySectionId.get("section:a");

    expect(
      resolveSectionThreadDropTarget(lookup, "in-a", sectionAKey ?? null),
    ).toBeNull();
    expect(
      resolveSectionThreadDropTarget(
        lookup,
        sectionAKey ?? "section:a",
        "threads",
      ),
    ).toBeNull();
  });
});

describe("section thread section drop targets", () => {
  it("resolves a section section", () => {
    const lookup = createLookup();
    const sectionAKey = lookup.sectionParentKeyBySectionId.get("section:a");

    expect(sectionAKey).toBeDefined();
    expect(
      resolveSectionThreadSectionOverId(lookup, sectionAKey ?? "section:a"),
    ).toBe("section:a");
  });

  it("resolves a thread inside a section", () => {
    expect(resolveSectionThreadSectionOverId(createLookup(), "in-a")).toBe(
      "section:a",
    );
  });

  it("resolves the chronological container to the Threads section", () => {
    expect(
      resolveSectionThreadSectionOverId(
        createLookup(),
        CHRONOLOGICAL_CONTAINER_ID,
      ),
    ).toBe("threads");
  });

  it("preserves another top-level section id", () => {
    expect(resolveSectionThreadSectionOverId(createLookup(), "pinned")).toBe(
      "pinned",
    );
  });
});

describe("section thread pin drop decisions", () => {
  it("pins an unpinned thread dropped on the Pinned container", () => {
    expect(
      resolveSectionThreadDropDecision(
        createLookupWithPinnedThread(),
        "loose",
        "pinned",
      ),
    ).toEqual({ kind: "pin", activeId: "loose" });
  });

  it("preserves a projected Pinned destination through self-collision", () => {
    expect(
      resolveSectionThreadDropDecision(
        createLookupWithPinnedThread(),
        "loose",
        "loose",
        PINNED_THREAD_PARENT_KEY,
      ),
    ).toEqual({ kind: "pin", activeId: "loose" });
  });

  it("unpins a pinned thread into Threads and clears its section", () => {
    expect(
      resolveSectionThreadDropDecision(
        createLookupWithPinnedThread(),
        "pinned-1",
        "threads",
      ),
    ).toEqual({
      kind: "unpin",
      activeId: "pinned-1",
      sectionId: null,
      move: true,
    });
  });

  it("unpins a pinned thread into a section without a redundant move", () => {
    expect(
      resolveSectionThreadDropDecision(
        createLookupWithPinnedThread(),
        "pinned-1",
        "section:a",
      ),
    ).toEqual({
      kind: "unpin",
      activeId: "pinned-1",
      sectionId: "a",
      move: false,
    });
  });

  it("keeps reorder-within-Pinned as a pinned reorder", () => {
    expect(
      resolveSectionThreadDropDecision(
        createLookupWithPinnedThread(),
        "pinned-1",
        "pinned-2",
      ),
    ).toEqual({
      kind: "reorder-pinned",
      activeId: "pinned-1",
      overId: "pinned-2",
    });
  });
});
