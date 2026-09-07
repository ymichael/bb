// @vitest-environment jsdom

import type { ThreadListEntry } from "@bb/domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMobileRecentAncestorIds,
  getMobileRecentThreads,
  RootComposeMobileRecents,
} from "./RootComposeMobileRecents";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";

function makeThread(overrides: Partial<ThreadListEntry> = {}): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_mobile",
    projectId: "proj_mobile",
    title: "Mobile activity",
    titleFallback: "Mobile activity",
    status: "active",
    lastReadAt: 1,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 1,
      activeGoalCount: 1,
    },
    runtime: {
      displayStatus: "active",
      hostReconnectGraceExpiresAt: null,
    },
    ...overrides,
  });
}

const IDLE_ACTIVITY: ThreadListEntry["activity"] = {
  activeWorkflowCount: 0,
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activePlanModeCount: 0,
  activeGoalCount: 0,
};

function makeIdleThread(
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThread({
    status: "idle",
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    activity: IDLE_ACTIVITY,
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const NONE: ReadonlySet<string> = new Set();

describe("getMobileRecentThreads", () => {
  it("returns every active thread newest-first instead of a capped window", () => {
    const threads = Array.from({ length: 12 }, (_unused, index) =>
      makeThread({
        id: `thr_${index}`,
        latestAttentionAt: index,
        createdAt: index,
      }),
    );

    const rows = getMobileRecentThreads({
      collapsedThreadIds: NONE,
      draftThreadIds: NONE,
      threads,
    });

    expect(rows).toHaveLength(12);
    expect(rows.map((row) => row.thread.id)).toEqual([
      "thr_11",
      "thr_10",
      "thr_9",
      "thr_8",
      "thr_7",
      "thr_6",
      "thr_5",
      "thr_4",
      "thr_3",
      "thr_2",
      "thr_1",
      "thr_0",
    ]);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
  });

  it("nests a child under its parent instead of listing it as a peer", () => {
    const rows = getMobileRecentThreads({
      collapsedThreadIds: NONE,
      draftThreadIds: NONE,
      threads: [
        makeThread({ id: "thr_parent", latestAttentionAt: 10 }),
        makeThread({
          id: "thr_child",
          parentThreadId: "thr_parent",
          latestAttentionAt: 99,
        }),
        makeThread({ id: "thr_other", latestAttentionAt: 5 }),
      ],
    });

    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["thr_parent", 0],
      ["thr_child", 1],
      ["thr_other", 0],
    ]);
    expect(rows[0]?.hasChildren).toBe(true);
    expect(rows[1]?.hasChildren).toBe(false);
  });

  it("hides descendants of a collapsed parent but keeps the parent", () => {
    const threads = [
      makeThread({ id: "thr_parent", latestAttentionAt: 10 }),
      makeThread({
        id: "thr_child",
        parentThreadId: "thr_parent",
        latestAttentionAt: 9,
      }),
      makeThread({
        id: "thr_grandchild",
        parentThreadId: "thr_child",
        latestAttentionAt: 8,
      }),
    ];

    const rows = getMobileRecentThreads({
      collapsedThreadIds: new Set(["thr_parent"]),
      draftThreadIds: NONE,
      threads,
    });

    expect(rows.map((row) => row.thread.id)).toEqual(["thr_parent"]);
    expect(rows[0]?.isCollapsed).toBe(true);
    expect(rows[0]?.hasChildren).toBe(true);
  });

  it("promotes a child whose parent is absent to the top level", () => {
    const rows = getMobileRecentThreads({
      collapsedThreadIds: NONE,
      draftThreadIds: NONE,
      threads: [
        makeThread({
          id: "thr_orphan",
          parentThreadId: "thr_missing",
          latestAttentionAt: 3,
        }),
      ],
    });

    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["thr_orphan", 0],
    ]);
  });

  it("does not group worktree threads into environment rows", () => {
    const rows = getMobileRecentThreads({
      collapsedThreadIds: NONE,
      draftThreadIds: NONE,
      threads: [
        makeThread({
          id: "thr_wt_a",
          environmentId: "env_1",
          environmentWorkspaceDisplayKind: "managed-worktree",
          latestAttentionAt: 2,
        }),
        makeThread({
          id: "thr_wt_b",
          environmentId: "env_1",
          environmentWorkspaceDisplayKind: "managed-worktree",
          latestAttentionAt: 1,
        }),
      ],
    });

    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["thr_wt_a", 0],
      ["thr_wt_b", 0],
    ]);
  });
});

describe("getMobileRecentAncestorIds", () => {
  const tree = [
    makeThread({ id: "thr_root" }),
    makeThread({ id: "thr_mid", parentThreadId: "thr_root" }),
    makeThread({ id: "thr_leaf", parentThreadId: "thr_mid" }),
  ];

  it("walks the whole ancestor chain of a nested thread", () => {
    expect(
      getMobileRecentAncestorIds({ threadId: "thr_leaf", threads: tree }),
    ).toEqual(["thr_mid", "thr_root"]);
  });

  it("returns nothing for a root thread or an unknown id", () => {
    expect(
      getMobileRecentAncestorIds({ threadId: "thr_root", threads: tree }),
    ).toEqual([]);
    expect(
      getMobileRecentAncestorIds({ threadId: "thr_missing", threads: tree }),
    ).toEqual([]);
  });

  it("stops at an absent parent instead of looping", () => {
    expect(
      getMobileRecentAncestorIds({
        threadId: "thr_orphan",
        threads: [makeThread({ id: "thr_orphan", parentThreadId: "thr_gone" })],
      }),
    ).toEqual([]);
  });

  it("terminates on a parent cycle", () => {
    expect(
      getMobileRecentAncestorIds({
        threadId: "thr_a",
        threads: [
          makeThread({ id: "thr_a", parentThreadId: "thr_b" }),
          makeThread({ id: "thr_b", parentThreadId: "thr_a" }),
        ],
      }).length,
    ).toBeLessThanOrEqual(2);
  });
});

describe("mobile recents hierarchy interaction", () => {
  function renderTree() {
    return render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              id: "thr_parent",
              title: "Rework folder model",
              titleFallback: "Rework folder model",
              latestAttentionAt: 10,
            }),
            makeThread({
              id: "thr_child",
              title: "Audit folder query paths",
              titleFallback: "Audit folder query paths",
              parentThreadId: "thr_parent",
              latestAttentionAt: 9,
            }),
          ]}
        />
      </MemoryRouter>,
    );
  }

  it("collapses and expands children from the parent row chevron", () => {
    const { container } = renderTree();

    expect(container.querySelector("a button")).toBeNull();

    expect(screen.getByText("Audit folder query paths")).not.toBeNull();
    const collapse = screen.getByRole("button", {
      name: "Hide threads under Rework folder model",
    });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(collapse);

    expect(screen.queryByText("Audit folder query paths")).toBeNull();
    const expand = screen.getByRole("button", {
      name: "Show threads under Rework folder model",
    });
    expect(expand.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expand);
    expect(screen.getByText("Audit folder query paths")).not.toBeNull();
  });

  it.each([
    {
      label: "Thread needs user input",
      child: makeIdleThread({
        id: "thr_child",
        parentThreadId: "thr_parent",
        hasPendingInteraction: true,
      }),
    },
    {
      label: "Plan mode active",
      child: makeIdleThread({
        id: "thr_child",
        parentThreadId: "thr_parent",
        activity: {
          ...IDLE_ACTIVITY,
          activePlanModeCount: 1,
        },
      }),
    },
    {
      label: "Thread working",
      child: makeThread({
        id: "thr_child",
        parentThreadId: "thr_parent",
        activity: IDLE_ACTIVITY,
      }),
    },
  ])(
    "renders child-only $label state on a collapsed parent",
    ({ child, label }) => {
      window.localStorage.setItem(
        "bb.sidebar.collapsedThreads",
        JSON.stringify(["thr_parent"]),
      );

      render(
        <MemoryRouter>
          <RootComposeMobileRecents
            highlightedThreadId={null}
            projectNamesById={new Map()}
            providersById={new Map()}
            showCreatingRow={false}
            threads={[
              makeIdleThread({
                id: "thr_parent",
                lastReadAt: 10,
                latestAttentionAt: 5,
              }),
              child,
            ]}
          />
        </MemoryRouter>,
      );

      expect(screen.getByLabelText(label)).not.toBeNull();
      expect(
        screen.getByRole("link", {
          name: `Open Mobile activity — ${label}`,
        }),
      ).not.toBeNull();
    },
  );

  it("renders a child-only draft state on a collapsed parent", () => {
    window.localStorage.setItem(
      "bb.promptbox.contents-proj_mobile-thr_child-3",
      JSON.stringify({ text: "Continue child work", attachments: [] }),
    );
    window.localStorage.setItem(
      "bb.sidebar.collapsedThreads",
      JSON.stringify(["thr_parent"]),
    );

    render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeIdleThread({
              id: "thr_parent",
              lastReadAt: 10,
              latestAttentionAt: 5,
            }),
            makeIdleThread({
              id: "thr_child",
              parentThreadId: "thr_parent",
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByLabelText("Thread has unsubmitted draft"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", {
        name: "Open Mobile activity — Thread has unsubmitted draft",
      }),
    ).not.toBeNull();
  });

  it("reveals a highlighted thread whose parent is collapsed", () => {
    window.localStorage.setItem(
      "bb.sidebar.collapsedThreads",
      JSON.stringify(["thr_parent"]),
    );

    render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId="thr_child"
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              id: "thr_parent",
              title: "Rework folder model",
              titleFallback: "Rework folder model",
            }),
            makeThread({
              id: "thr_child",
              title: "Audit folder query paths",
              titleFallback: "Audit folder query paths",
              parentThreadId: "thr_parent",
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Audit folder query paths")).not.toBeNull();
    expect(window.localStorage.getItem("bb.sidebar.collapsedThreads")).toBe(
      "[]",
    );
  });

  it("de-emphasizes the provider tile on child rows only", () => {
    renderTree();

    const [parentRow, childRow] = screen.getAllByRole("link");
    const parentTile = parentRow?.firstElementChild;
    const childTile = childRow?.firstElementChild;
    if (
      !(parentTile instanceof HTMLElement) ||
      !(childTile instanceof HTMLElement)
    ) {
      throw new Error("Expected a tile on both rows");
    }

    expect(parentTile.className).not.toContain("opacity-60");
    expect(childTile.className).toContain("opacity-60");

    for (const tile of [parentTile, childTile]) {
      expect(tile.className).toContain("border-border-seam");
      expect(tile.className).toContain("bg-surface-raised");
    }

    for (const tile of [parentTile, childTile]) {
      expect(tile.className).toContain("size-7");
      expect(tile.className).toContain("border");
    }
  });

  it("centers provider tiles against the title and metadata block", () => {
    renderTree();

    const rows = screen.getAllByRole("link");
    for (const row of rows) {
      const tile = row.firstElementChild;
      if (!(tile instanceof HTMLElement)) {
        throw new Error("Expected a leading provider tile");
      }
      expect(row.className).toContain("items-center");
      expect(tile.className).not.toContain("self-start");
      expect(tile.className).not.toContain("mt-1");
    }
  });

  it("gives only the parent a toggle and indents the child", () => {
    renderTree();

    expect(screen.getAllByRole("button")).toHaveLength(1);
    const [parentRow, childRow] = screen.getAllByRole("link");
    if (!parentRow || !childRow) {
      throw new Error("Expected a parent and a child row");
    }
    expect(parentRow.style.paddingLeft).toBe("8px");
    expect(childRow.style.paddingLeft).toBe("32px");
  });
});

describe("mobile recents section", () => {
  it("keeps the Recent label pinned while the list scrolls under it", () => {
    render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[makeThread()]}
        />
      </MemoryRouter>,
    );

    const label = screen.getByText("Recent").parentElement;
    if (!(label instanceof HTMLElement)) {
      throw new Error("Expected a Recent label wrapper");
    }
    expect(label.className).toContain("sticky");
    expect(label.className).toContain("top-0");
    expect(label.className).toContain("bg-background");
    expect(label.querySelector('[data-overflow-fade="below"]')).not.toBeNull();
  });
});

describe("mobile recent thread rows", () => {
  it("shows project and relative activity on a metadata line", () => {
    render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map([["proj_mobile", "bb"]])}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              latestAttentionAt: Date.now() - 3 * 60 * 60 * 1000,
              activity: {
                activeWorkflowCount: 0,
                activeBackgroundAgentCount: 0,
                activeBackgroundCommandCount: 0,
                activePlanModeCount: 0,
                activeGoalCount: 0,
              },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("bb \u00b7 3h ago")).not.toBeNull();
  });

  it("includes the worktree branch when the thread has one", () => {
    render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map([["proj_mobile", "bb"]])}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              environmentBranchName: "bb/mobile-home",
              latestAttentionAt: Date.now() - 3 * 60 * 60 * 1000,
              activity: {
                activeWorkflowCount: 0,
                activeBackgroundAgentCount: 0,
                activeBackgroundCommandCount: 0,
                activePlanModeCount: 0,
                activeGoalCount: 0,
              },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText("bb \u00b7 bb/mobile-home \u00b7 3h ago"),
    ).not.toBeNull();
  });

  it("drops the status slot entirely when a thread has no indicator", () => {
    render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              status: "idle",
              lastReadAt: 10,
              latestAttentionAt: 5,
              runtime: {
                displayStatus: "idle",
                hostReconnectGraceExpiresAt: null,
              },
              activity: {
                activeWorkflowCount: 0,
                activeBackgroundAgentCount: 0,
                activeBackgroundCommandCount: 0,
                activePlanModeCount: 0,
                activeGoalCount: 0,
              },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
    expect(screen.queryByLabelText("Thread working")).toBeNull();
    expect(
      screen.getByRole("link").querySelectorAll("span.size-6"),
    ).toHaveLength(0);
  });
});

describe("RootComposeMobileRecents", () => {
  it("shows concurrent Plan activity before the runtime spinner", () => {
    render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[makeThread()]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Plan mode active")).not.toBeNull();
    expect(screen.queryByLabelText("Thread working")).toBeNull();
    expect(screen.queryByLabelText("Goal active")).toBeNull();
  });

  it("shows runtime activity before concurrent workflow activity", () => {
    render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              activity: {
                activeWorkflowCount: 1,
                activeBackgroundAgentCount: 1,
                activeBackgroundCommandCount: 1,
                activePlanModeCount: 0,
                activeGoalCount: 0,
              },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Thread working")).not.toBeNull();
    expect(screen.queryByLabelText("Workflow running")).toBeNull();
  });

  it("keeps the mobile working draft state ahead of runtime activity", () => {
    window.localStorage.setItem(
      "bb.promptbox.contents-proj_mobile-thr_mobile-3",
      JSON.stringify({ text: "Keep editing", attachments: [] }),
    );

    render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[makeThread()]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByLabelText("Thread working with unsubmitted draft"),
    ).not.toBeNull();
    expect(screen.queryByLabelText("Thread working")).toBeNull();
    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
  });

  it("includes only the resolved idle draft indicator in the link label", () => {
    window.localStorage.setItem(
      "bb.promptbox.contents-proj_mobile-thr_mobile-3",
      JSON.stringify({ text: "Keep editing", attachments: [] }),
    );

    render(
      <MemoryRouter>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              status: "idle",
              activity: {
                activeWorkflowCount: 0,
                activeBackgroundAgentCount: 0,
                activeBackgroundCommandCount: 0,
                activePlanModeCount: 0,
                activeGoalCount: 0,
              },
              runtime: {
                displayStatus: "idle",
                hostReconnectGraceExpiresAt: null,
              },
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", {
        name: "Open Mobile activity — Thread has unsubmitted draft",
      }),
    ).not.toBeNull();
    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
  });
});
