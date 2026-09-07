import { describe, expect, it } from "vitest";
import {
  findPaneByContent,
  findPaneByThread,
  listPanes,
  MAX_PANES,
  splitPane,
} from "@/lib/split-layout";
import type { SplitLayout } from "@/lib/split-layout";
import {
  applyThreadOpenToLayout,
  applyThreadPaneActionToLayout,
  createSinglePaneLayout,
  focusedPaneRoute,
  reconcileLayoutForContent,
} from "./splitThreadNavigation";

function twoPaneLayout(): SplitLayout {
  return splitPane(
    createSinglePaneLayout({ projectId: "p1", threadId: "thread-1" }),
    "pane-1",
    "right",
    {
      kind: "thread",
      projectId: "p1",
      threadId: "thread-2",
    },
  );
}

function eightPaneLayout(): SplitLayout {
  let layout = twoPaneLayout();
  for (let index = 3; index <= MAX_PANES; index += 1) {
    layout = applyThreadOpenToLayout(
      layout,
      { projectId: "p1", threadId: `thread-${index}` },
      "right",
    );
  }
  return layout;
}

describe("mixed page navigation", () => {
  it("keeps New Thread as a singleton and focuses its existing pane", () => {
    const withCompose = splitPane(twoPaneLayout(), "pane-2", "bottom", {
      kind: "new-thread",
    });

    const after = reconcileLayoutForContent(withCompose, {
      kind: "new-thread",
    });

    expect(listPanes(after.root)).toHaveLength(3);
    expect(after.focusedPaneId).toBe(
      findPaneByContent(after.root, { kind: "new-thread" })?.paneId,
    );
    expect(focusedPaneRoute(after)).toBe("/");
  });

  it("updates a plugin pane's subpath without duplicating the panel", () => {
    const plugin = {
      kind: "plugin-panel",
      pluginId: "notes",
      panelPath: "notes",
      subPath: "inbox.md",
    } as const;
    const before = splitPane(twoPaneLayout(), "pane-1", "bottom", plugin);

    const after = reconcileLayoutForContent(before, {
      ...plugin,
      subPath: "work/today.md",
    });

    expect(listPanes(after.root)).toHaveLength(3);
    expect(findPaneByContent(after.root, plugin)?.content).toEqual({
      ...plugin,
      subPath: "work/today.md",
    });
    expect(focusedPaneRoute(after)).toBe("/plugins/notes/notes/work/today.md");
  });
});

describe("applyThreadOpenToLayout", () => {
  it("splits from the focused pane and focuses the opened thread", () => {
    const before = twoPaneLayout();
    const after = applyThreadOpenToLayout(
      before,
      { projectId: "p2", threadId: "thread-3" },
      "down",
    );

    expect(listPanes(after.root)).toHaveLength(3);
    expect(findPaneByThread(after.root, "p2", "thread-3")?.paneId).toBe(
      after.focusedPaneId,
    );
  });

  it("focuses an already-open thread instead of duplicating it", () => {
    const before = twoPaneLayout();
    const after = applyThreadOpenToLayout(
      before,
      { projectId: "p1", threadId: "thread-1" },
      "right",
    );

    expect(listPanes(after.root)).toHaveLength(2);
    expect(after.focusedPaneId).toBe("pane-1");
  });

  it("creates panes five through eight, then replaces the focused pane for a ninth open", () => {
    const eight = eightPaneLayout();
    const focusedPaneId = eight.focusedPaneId;

    expect(listPanes(eight.root)).toHaveLength(MAX_PANES);
    expect(eight.root).toMatchObject({
      type: "split",
      dir: "row",
      sizes: Array.from({ length: MAX_PANES }, () => 1 / MAX_PANES),
    });
    for (let index = 5; index <= MAX_PANES; index += 1) {
      expect(
        findPaneByThread(eight.root, "p1", `thread-${index}`),
      ).not.toBeNull();
    }

    const after = applyThreadOpenToLayout(
      eight,
      { projectId: "p2", threadId: "thread-9" },
      "left",
    );

    expect(listPanes(after.root)).toHaveLength(MAX_PANES);
    expect(after.focusedPaneId).toBe(focusedPaneId);
    expect(findPaneByThread(after.root, "p2", "thread-9")?.paneId).toBe(
      focusedPaneId,
    );
    expect(findPaneByThread(after.root, "p1", "thread-8")).toBeNull();
  });
});

describe("applyThreadPaneActionToLayout", () => {
  it("focuses and maximizes the targeted open thread without changing the tree", () => {
    const before = twoPaneLayout();
    const result = applyThreadPaneActionToLayout(
      before,
      null,
      { projectId: "p1", threadId: "thread-1" },
      "maximize",
    );

    expect(result.layout.root).toEqual(before.root);
    expect(result.layout.focusedPaneId).toBe("pane-1");
    expect(result.maximizedPaneId).toBe("pane-1");
    expect(result.dimInactiveSplits).toBeNull();
  });

  it("restores only the targeted maximized pane and toggles it back", () => {
    const before = twoPaneLayout();
    const restored = applyThreadPaneActionToLayout(
      before,
      "pane-2",
      { projectId: "p1", threadId: "thread-2" },
      "restore",
    );
    expect(restored).toEqual({
      layout: before,
      maximizedPaneId: null,
      dimInactiveSplits: null,
    });

    const toggled = applyThreadPaneActionToLayout(
      restored.layout,
      restored.maximizedPaneId,
      { projectId: "p1", threadId: "thread-2" },
      "toggle",
    );
    expect(toggled.maximizedPaneId).toBe("pane-2");
  });

  it.each([
    ["spotlight", true],
    ["clear-spotlight", false],
  ] as const)(
    "focuses the target for %s and returns the preference",
    (action, expected) => {
      const before = twoPaneLayout();
      const result = applyThreadPaneActionToLayout(
        before,
        null,
        { projectId: "p1", threadId: "thread-1" },
        action,
      );

      expect(result.layout.root).toEqual(before.root);
      expect(result.layout.focusedPaneId).toBe("pane-1");
      expect(result.maximizedPaneId).toBeNull();
      expect(result.dimInactiveSplits).toBe(expected);
    },
  );

  it("is a no-op when the target is not open", () => {
    const before = twoPaneLayout();
    expect(
      applyThreadPaneActionToLayout(
        before,
        "pane-2",
        { projectId: "p1", threadId: "missing" },
        "maximize",
      ),
    ).toEqual({
      layout: before,
      maximizedPaneId: "pane-2",
      dimInactiveSplits: null,
    });
  });
});
