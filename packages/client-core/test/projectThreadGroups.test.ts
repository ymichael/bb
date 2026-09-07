import type { ThreadListEntry } from "@bb/domain";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { describe, expect, it } from "vitest";
import {
  buildChronologicalThreadList,
  buildSectionThreadList,
  buildProjectThreadGroups,
  compareByCreatedAtDescending,
  compareStandardThreads,
  createSidebarProjectIdResolver,
  resolveSidebarProjectId,
  type ProjectThreadItem,
  type ProjectThreadNode,
  type ThreadComparator,
} from "../src/sidebar/projectThreadGroups.js";

type ThreadListEntryOverrides = Partial<ThreadListEntry>;
type TreeSummary =
  | string
  | { id: string; children: TreeSummary[] }
  | { env: string; threads: TreeSummary[] }
  | { section: string; name: string; items: TreeSummary[] };

function getItemAlphaLabel(item: ProjectThreadItem): string {
  switch (item.kind) {
    case "section":
      return item.group.name;
    case "thread":
      return item.node.thread.title ?? item.node.thread.titleFallback ?? "";
    case "environment":
      return (
        item.group.nodes[0]?.thread.title ??
        item.group.nodes[0]?.thread.titleFallback ??
        ""
      );
  }
}

const compareAlphaDescending = ((left, right) =>
  (right.title ?? right.titleFallback ?? "").localeCompare(
    left.title ?? left.titleFallback ?? "",
  )) as ThreadComparator;
compareAlphaDescending.compareItems = (left, right) =>
  getItemAlphaLabel(right).localeCompare(getItemAlphaLabel(left));

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

function summarizeNode(node: ProjectThreadNode): TreeSummary {
  if (node.children.length === 0) {
    return node.thread.id;
  }

  return {
    id: node.thread.id,
    children: summarizeItems(node.children),
  };
}

function summarizeItems(items: readonly ProjectThreadItem[]): TreeSummary[] {
  return items.map((item) => {
    switch (item.kind) {
      case "thread":
        return summarizeNode(item.node);
      case "environment":
        return {
          env: item.group.environmentId,
          threads: item.group.nodes.map(summarizeNode),
        };
      case "section":
        return {
          section: item.group.key,
          name: item.group.name,
          items: summarizeItems(item.group.items),
        };
    }
  });
}

function findNode(
  items: readonly ProjectThreadItem[],
  threadId: string,
): ProjectThreadNode | null {
  for (const item of items) {
    if (item.kind === "section") {
      const sectionNode = findNode(item.group.items, threadId);
      if (sectionNode) {
        return sectionNode;
      }
      continue;
    }
    const nodes = item.kind === "thread" ? [item.node] : item.group.nodes;
    for (const node of nodes) {
      if (node.thread.id === threadId) {
        return node;
      }
      const childNode = findNode(node.children, threadId);
      if (childNode) {
        return childNode;
      }
    }
  }

  return null;
}

describe("buildProjectThreadGroups", () => {
  it("nests threads recursively from parentThreadId regardless of thread type", () => {
    const rootItems = buildProjectThreadGroups([
      createThread({
        id: "manager-root",
        createdAt: 10,
      }),
      createThread({
        id: "standard-child",
        parentThreadId: "manager-root",
        createdAt: 20,
      }),
      createThread({
        id: "standard-grandchild",
        parentThreadId: "standard-child",
        createdAt: 30,
      }),
      createThread({
        id: "manager-grandchild",
        parentThreadId: "standard-grandchild",
        createdAt: 40,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual([
      {
        id: "manager-root",
        children: [
          {
            id: "standard-child",
            children: [
              {
                id: "standard-grandchild",
                children: ["manager-grandchild"],
              },
            ],
          },
        ],
      },
    ]);
    expect(findNode(rootItems, "manager-grandchild")?.depth).toBe(3);
  });

  it("renders forks as roots and excludes side chats", () => {
    const rootItems = buildProjectThreadGroups([
      createThread({
        id: "thr_parent",
        createdAt: 10,
        latestAttentionAt: 30,
      }),
      createThread({
        id: "thr_fork",
        sourceThreadId: "thr_parent",
        originKind: "fork",
        createdAt: 20,
        latestAttentionAt: 20,
      }),
      createThread({
        id: "thr_sidechat",
        sourceThreadId: "thr_parent",
        visibility: "hidden",
        createdAt: 30,
        latestAttentionAt: 40,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual(["thr_parent", "thr_fork"]);
    expect(findNode(rootItems, "thr_parent")?.children).toEqual([]);
    expect(findNode(rootItems, "thr_fork")?.depth).toBe(0);
    expect(findNode(rootItems, "thr_sidechat")).toBeNull();
  });

  it("keeps orphaned children as project roots", () => {
    const rootItems = buildProjectThreadGroups([
      createThread({
        id: "orphan-child",
        parentThreadId: "missing-parent",
        createdAt: 20,
        latestAttentionAt: 20,
      }),
      createThread({
        id: "root-thread",
        createdAt: 10,
        latestAttentionAt: 10,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual(["orphan-child", "root-thread"]);
  });

  it("cuts cycles without duplicating or dropping every cycle member", () => {
    const rootItems = buildProjectThreadGroups([
      createThread({
        id: "cycle-a",
        parentThreadId: "cycle-b",
        createdAt: 10,
      }),
      createThread({
        id: "cycle-b",
        parentThreadId: "cycle-a",
        createdAt: 20,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual([
      {
        id: "cycle-a",
        children: ["cycle-b"],
      },
    ]);
  });

  it("groups shared worktree environments at nested sibling levels", () => {
    const rootItems = buildProjectThreadGroups([
      createThread({
        id: "parent",
        createdAt: 100,
      }),
      createThread({
        id: "worktree-a",
        parentThreadId: "parent",
        environmentId: "env_shared",
        queuedWork: "none",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 10,
        latestAttentionAt: 100,
      }),
      createThread({
        id: "worktree-b",
        parentThreadId: "parent",
        environmentId: "env_shared",
        queuedWork: "none",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 20,
        latestAttentionAt: 200,
      }),
      createThread({
        id: "loose-child",
        parentThreadId: "parent",
        createdAt: 5,
        latestAttentionAt: 50,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual([
      {
        id: "parent",
        children: [
          { env: "env_shared", threads: ["worktree-b", "worktree-a"] },
          "loose-child",
        ],
      },
    ]);
  });

  it("sorts siblings with active rows first, then inactive attention recency", () => {
    const rootItems = buildProjectThreadGroups([
      createThread({
        id: "root",
      }),
      createThread({
        id: "active-older-created",
        parentThreadId: "root",
        status: "active",
        createdAt: 10,
        latestAttentionAt: 2_000,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "active-newer-created",
        parentThreadId: "root",
        status: "active",
        createdAt: 20,
        latestAttentionAt: 1_500,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "idle-newer-attention",
        parentThreadId: "root",
        createdAt: 40,
        latestAttentionAt: 900,
      }),
      createThread({
        id: "idle-older-attention",
        parentThreadId: "root",
        createdAt: 30,
        latestAttentionAt: 750,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual([
      {
        id: "root",
        children: [
          "active-newer-created",
          "active-older-created",
          "idle-newer-attention",
          "idle-older-attention",
        ],
      },
    ]);
  });

  it("rolls collapsed child activity up from all descendants", () => {
    const rootItems = buildProjectThreadGroups([
      createThread({
        id: "parent",
      }),
      createThread({
        id: "quiet-child",
        parentThreadId: "parent",
      }),
      createThread({
        id: "busy-grandchild",
        parentThreadId: "quiet-child",
        status: "active",
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "pending-grandchild",
        parentThreadId: "quiet-child",
        hasPendingInteraction: true,
      }),
    ]);

    expect(findNode(rootItems, "parent")?.stats).toEqual({
      childActivity: {
        pending: true,
        working: true,
        hasUnsubmittedDraft: false,
        runtimeWorking: true,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: false,
      },
      childCount: 3,
    });
    expect(findNode(rootItems, "quiet-child")?.stats).toEqual({
      childActivity: {
        pending: true,
        working: true,
        hasUnsubmittedDraft: false,
        runtimeWorking: true,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: false,
      },
      childCount: 2,
    });
  });

  it("orders roots by literal createdAt when given the created comparator", () => {
    const threads = [
      createThread({
        id: "active-old",
        status: "active",
        createdAt: 10,
        latestAttentionAt: 5,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "idle-new",
        status: "idle",
        createdAt: 50,
        latestAttentionAt: 5,
      }),
    ];

    expect(summarizeItems(buildProjectThreadGroups(threads))).toEqual([
      "active-old",
      "idle-new",
    ]);

    expect(
      summarizeItems(
        buildProjectThreadGroups(threads, compareByCreatedAtDescending),
      ),
    ).toEqual(["idle-new", "active-old"]);
  });

  describe("buildChronologicalThreadList", () => {
    it("nests parent/child threads under globally sorted roots", () => {
      const items = buildChronologicalThreadList(
        [
          createThread({ id: "parent", createdAt: 10, latestAttentionAt: 10 }),
          createThread({
            id: "child",
            parentThreadId: "parent",
            createdAt: 30,
            latestAttentionAt: 30,
          }),
          createThread({ id: "other", createdAt: 20, latestAttentionAt: 20 }),
        ],
        compareByCreatedAtDescending,
      );

      expect(summarizeItems(items)).toEqual([
        "other",
        { id: "parent", children: ["child"] },
      ]);
    });

    it("keeps worktree siblings as thread rows", () => {
      const items = buildChronologicalThreadList(
        [
          createThread({ id: "parent", createdAt: 100 }),
          createThread({
            id: "worktree-a",
            parentThreadId: "parent",
            environmentId: "env_shared",
            queuedWork: "none",
            environmentWorkspaceDisplayKind: "managed-worktree",
            createdAt: 10,
            latestAttentionAt: 100,
          }),
          createThread({
            id: "worktree-b",
            parentThreadId: "parent",
            environmentId: "env_shared",
            queuedWork: "none",
            environmentWorkspaceDisplayKind: "managed-worktree",
            createdAt: 20,
            latestAttentionAt: 200,
          }),
        ],
        compareByCreatedAtDescending,
      );

      expect(summarizeItems(items)).toEqual([
        {
          id: "parent",
          children: ["worktree-b", "worktree-a"],
        },
      ]);
    });

    it("excludes side chats", () => {
      const items = buildChronologicalThreadList([
        createThread({ id: "root", createdAt: 10 }),
        createThread({
          id: "side",
          parentThreadId: "root",
          visibility: "hidden",
          createdAt: 20,
        }),
      ]);

      expect(summarizeItems(items)).toEqual(["root"]);
    });
  });

  it("sorts top-level manager roots with the regular root ordering", () => {
    const rootItems = buildProjectThreadGroups([
      createThread({
        id: "root-thread",
        createdAt: 100,
        latestAttentionAt: 100,
      }),
      createThread({
        id: "manager-old",
        createdAt: 10,
        latestAttentionAt: 10,
      }),
      createThread({
        id: "manager-new",
        createdAt: 20,
        latestAttentionAt: 20,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual([
      "root-thread",
      "manager-new",
      "manager-old",
    ]);
  });
});

describe("section bucketing", () => {
  it("buckets threads into flat sections by section id, sections above loose threads", () => {
    const items = buildSectionThreadList(
      [
        createThread({ id: "a", title: "Plan", sectionId: "sec_work_q3" }),
        createThread({ id: "b", title: "Notes", sectionId: "sec_work_q3" }),
        createThread({ id: "c", title: "Q4", sectionId: "sec_work" }),
        createThread({ id: "d", title: "Standalone" }),
      ],
      compareStandardThreads,
      [
        { id: "sec_work", name: "Work" },
        { id: "sec_work_q3", name: "Work/Q3" },
      ],
    );

    expect(summarizeItems(items)).toEqual([
      { section: "chronological::sec_work", name: "Work", items: ["c"] },
      {
        section: "chronological::sec_work_q3",
        name: "Work/Q3",
        items: ["a", "b"],
      },
      "d",
    ]);
  });

  it("does not derive sections from slashes in titles", () => {
    const items = buildSectionThreadList([
      createThread({ id: "a", title: "Work/Q3/Plan" }),
      createThread({ id: "b", title: "Work/Notes" }),
    ]);

    expect(summarizeItems(items)).toEqual(["a", "b"]);
  });

  it("renders explicit empty sections without a thread using that id", () => {
    const items = buildSectionThreadList(
      [createThread({ id: "a", title: "Standalone" })],
      compareStandardThreads,
      [{ id: "sec_work_q3", name: "Work/Q3" }],
    );

    expect(summarizeItems(items)).toEqual([
      {
        section: "chronological::sec_work_q3",
        name: "Work/Q3",
        items: [],
      },
      "a",
    ]);
  });

  it("keeps a section thread's own children nested under it and ignores child sections", () => {
    const items = buildSectionThreadList(
      [
        createThread({
          id: "parent",
          title: "Project",
          sectionId: "sec_work",
        }),
        createThread({
          id: "child",
          parentThreadId: "parent",
          title: "Path",
          sectionId: "sec_ignored",
        }),
      ],
      compareStandardThreads,
      [
        { id: "sec_work", name: "Work" },
        { id: "sec_ignored", name: "Ignored/Child" },
      ],
    );

    expect(summarizeItems(items)).toEqual([
      {
        section: "chronological::sec_work",
        name: "Work",
        items: [{ id: "parent", children: ["child"] }],
      },
      {
        section: "chronological::sec_ignored",
        name: "Ignored/Child",
        items: [],
      },
    ]);
  });

  it("orders explicit sections by name rather than descendant recency", () => {
    const threads = [
      createThread({
        id: "old-active",
        title: "x",
        sectionId: "sec_archive",
        status: "active",
        createdAt: 10,
        latestAttentionAt: 5,
        runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
      }),
      createThread({
        id: "new-idle",
        title: "y",
        sectionId: "sec_work",
        status: "idle",
        createdAt: 50,
        latestAttentionAt: 5,
      }),
    ];

    const sections = [
      { id: "sec_archive", name: "Archive" },
      { id: "sec_empty", name: "Empty" },
      { id: "sec_work", name: "Work" },
    ];

    expect(
      summarizeItems(
        buildSectionThreadList(threads, compareStandardThreads, sections),
      ),
    ).toEqual([
      {
        section: "chronological::sec_archive",
        name: "Archive",
        items: ["old-active"],
      },
      { section: "chronological::sec_empty", name: "Empty", items: [] },
      {
        section: "chronological::sec_work",
        name: "Work",
        items: ["new-idle"],
      },
    ]);

    expect(
      summarizeItems(
        buildSectionThreadList(threads, compareByCreatedAtDescending, sections),
      ),
    ).toEqual([
      {
        section: "chronological::sec_archive",
        name: "Archive",
        items: ["old-active"],
      },
      { section: "chronological::sec_empty", name: "Empty", items: [] },
      {
        section: "chronological::sec_work",
        name: "Work",
        items: ["new-idle"],
      },
    ]);
  });

  it("applies alpha descending order to section rows", () => {
    const items = buildSectionThreadList([], compareAlphaDescending, [
      { id: "sec_archive", name: "Archive" },
      { id: "sec_empty", name: "Empty" },
      { id: "sec_work", name: "Work" },
    ]);

    expect(summarizeItems(items)).toEqual([
      { section: "chronological::sec_work", name: "Work", items: [] },
      { section: "chronological::sec_empty", name: "Empty", items: [] },
      { section: "chronological::sec_archive", name: "Archive", items: [] },
    ]);
  });

  it("rolls descendant count + activity up onto the section group", () => {
    const items = buildSectionThreadList(
      [
        createThread({
          id: "busy",
          title: "Busy",
          sectionId: "sec_work",
          hasPendingInteraction: true,
        }),
        createThread({ id: "quiet", title: "Quiet", sectionId: "sec_work" }),
      ],
      compareStandardThreads,
      [{ id: "sec_work", name: "Work" }],
    );

    expect(items).toHaveLength(1);
    const section = items[0];
    if (section.kind !== "section") {
      throw new Error("expected a section item");
    }
    expect(section.group.threadCount).toBe(2);
    expect(section.group.activity.pending).toBe(true);
  });

  it("folds the chronological list into sections", () => {
    const items = buildSectionThreadList(
      [
        createThread({
          id: "a",
          title: "One",
          sectionId: "sec_work",
          createdAt: 20,
        }),
        createThread({
          id: "b",
          title: "Two",
          sectionId: "sec_personal",
          createdAt: 10,
        }),
      ],
      compareByCreatedAtDescending,
      [
        { id: "sec_personal", name: "Personal" },
        { id: "sec_work", name: "Work" },
      ],
    );

    expect(summarizeItems(items)).toEqual([
      {
        section: "chronological::sec_personal",
        name: "Personal",
        items: ["b"],
      },
      { section: "chronological::sec_work", name: "Work", items: ["a"] },
    ]);
  });

  it("nests a child thread under its parent root inside a section", () => {
    const items = buildSectionThreadList(
      [
        createThread({
          id: "parent",
          title: "Parent",
          sectionId: "sec_work",
          createdAt: 20,
        }),
        createThread({
          id: "child",
          parentThreadId: "parent",
          title: "Child",
          createdAt: 10,
        }),
      ],
      compareByCreatedAtDescending,
      [{ id: "sec_work", name: "Work" }],
    );

    expect(summarizeItems(items)).toEqual([
      {
        section: "chronological::sec_work",
        name: "Work",
        items: [{ id: "parent", children: ["child"] }],
      },
    ]);
  });

  it("combines threads from different projects that share the same section id", () => {
    const items = buildSectionThreadList(
      [
        createThread({
          id: "a",
          projectId: "proj_1",
          title: "One",
          sectionId: "sec_work",
          createdAt: 20,
        }),
        createThread({
          id: "b",
          projectId: "proj_2",
          title: "Two",
          sectionId: "sec_work",
          createdAt: 10,
        }),
      ],
      compareByCreatedAtDescending,
      [{ id: "sec_work", name: "Work" }],
    );

    expect(summarizeItems(items)).toEqual([
      { section: "chronological::sec_work", name: "Work", items: ["a", "b"] },
    ]);
  });
});

describe("resolveSidebarProjectId", () => {
  it("files a child from another project under its root ancestor's project", () => {
    const root = createThread({ id: "thr_root", projectId: "proj_a" });
    const child = createThread({
      id: "thr_child",
      parentThreadId: "thr_root",
      projectId: "proj_b",
    });
    const grandchild = createThread({
      id: "thr_grandchild",
      parentThreadId: "thr_child",
      projectId: "proj_c",
    });
    const threadById = new Map(
      [root, child, grandchild].map((thread) => [thread.id, thread]),
    );

    expect(resolveSidebarProjectId(root, threadById)).toBe("proj_a");
    expect(resolveSidebarProjectId(child, threadById)).toBe("proj_a");
    expect(resolveSidebarProjectId(grandchild, threadById)).toBe("proj_a");
  });

  it("falls back to the thread's own project when the parent is not listed", () => {
    const orphan = createThread({
      id: "thr_orphan",
      parentThreadId: "thr_missing",
      projectId: "proj_b",
    });
    expect(
      resolveSidebarProjectId(orphan, new Map([[orphan.id, orphan]])),
    ).toBe("proj_b");
  });

  it("stops at a cycle instead of looping", () => {
    const left = createThread({
      id: "thr_left",
      parentThreadId: "thr_right",
      projectId: "proj_a",
    });
    const right = createThread({
      id: "thr_right",
      parentThreadId: "thr_left",
      projectId: "proj_b",
    });
    const threadById = new Map([
      [left.id, left],
      [right.id, right],
    ]);
    expect(resolveSidebarProjectId(left, threadById)).toBe("proj_b");
  });

  it("memoizes ancestor walks across siblings and descendants", () => {
    const root = createThread({ id: "thr_root", projectId: "proj_a" });
    const child = createThread({
      id: "thr_child",
      parentThreadId: "thr_root",
      projectId: "proj_b",
    });
    const grandchildren = Array.from({ length: 5 }, (_, index) =>
      createThread({
        id: `thr_grandchild_${index}`,
        parentThreadId: "thr_child",
        projectId: "proj_c",
      }),
    );
    const all = [root, child, ...grandchildren];
    const lookups: string[] = [];
    const threadById = new Map(all.map((thread) => [thread.id, thread]));
    const spyingMap: ReadonlyMap<string, ThreadListEntry> = {
      ...threadById,
      get: (id: string) => {
        lookups.push(id);
        return threadById.get(id);
      },
    } as unknown as ReadonlyMap<string, ThreadListEntry>;
    const resolve = createSidebarProjectIdResolver(spyingMap);

    expect(all.map(resolve)).toEqual(Array(all.length).fill("proj_a"));
    expect(lookups).toEqual([
      "thr_root",
      "thr_child",
      "thr_child",
      "thr_child",
      "thr_child",
      "thr_child",
    ]);
  });
});
