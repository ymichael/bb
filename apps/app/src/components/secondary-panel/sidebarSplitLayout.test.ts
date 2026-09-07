import { describe, expect, it } from "vitest";
import { MAX_PANES, countPanes, listPanes } from "@/lib/split-layout";
import {
  FIXED_PANEL_TABS_IDLE_EXPIRY_MS,
  createGitDiffFixedPanelTab,
  createThreadInfoFixedPanelTab,
  getFixedPanelTabsStateStorageKey,
} from "@/lib/fixed-panel-tabs-state";
import {
  SIDEBAR_FIXED_DIFF_TAB_ID,
  SIDEBAR_FIXED_INFO_TAB_ID,
  createSidebarSplitState,
  getSidebarTabPlacement,
  focusSidebarPane,
  getSidebarGroupForPane,
  isCanonicalSidebarSplitState,
  moveSidebarPaneToSide,
  moveSidebarTab,
  parseSidebarSplitState,
  pruneSidebarSplitStorage,
  reconcileSidebarSplitState,
  removeSidebarSplit,
  reorderSidebarTab,
  restoreSidebarTabPlacement,
  replaceSidebarTab,
  resizeSidebarSplit,
  selectSidebarTab,
  serializeSidebarSplitState,
  setSidebarPaneMaximized,
  sidebarPaneNode,
  sidebarSplitStorageKey,
  type SidebarSplitState,
  type SidebarSplitStorage,
} from "./sidebarSplitLayout";

const TABS = [SIDEBAR_FIXED_INFO_TAB_ID, SIDEBAR_FIXED_DIFF_TAB_ID, "file-a"];

function createMemoryStorage(
  initialEntries: Record<string, string>,
): SidebarSplitStorage & { has(key: string): boolean } {
  const entries = new Map(Object.entries(initialEntries));
  return {
    get length() {
      return entries.size;
    },
    getItem: (key) => entries.get(key) ?? null,
    has: (key) => entries.has(key),
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function persistedStateWithPaneCount(count: number): SidebarSplitState {
  const groups = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const groupId = `group-${index}`;
      const tabId = `tab-${index}`;
      return [groupId, { id: groupId, tabIds: [tabId], activeTabId: tabId }];
    }),
  );
  return {
    version: 1,
    groups,
    layout: {
      root: {
        type: "split",
        dir: "row",
        sizes: Array.from({ length: count }, () => 1 / count),
        children: Array.from({ length: count }, (_, index) =>
          sidebarPaneNode(`pane-${index}`, `group-${index}`),
        ),
      },
      focusedPaneId: "pane-0",
    },
    maximizedPaneId: null,
  };
}

function splitOff(
  state: ReturnType<typeof createSidebarSplitState>,
  tabId: string,
  side: "left" | "right" | "top" | "bottom" = "right",
) {
  return moveSidebarTab(
    state,
    state.layout.focusedPaneId,
    tabId,
    { paneId: state.layout.focusedPaneId, zone: side },
    { groupId: `group-${tabId}` },
  );
}

describe("sidebar split layout", () => {
  it("derives fixed sidebar identities from the canonical fixed-panel tabs", () => {
    expect(SIDEBAR_FIXED_INFO_TAB_ID).toBe(createThreadInfoFixedPanelTab().id);
    expect(SIDEBAR_FIXED_DIFF_TAB_ID).toBe(createGitDiffFixedPanelTab().id);
  });

  it("defaults old or invalid persisted state to the unchanged single pane", () => {
    const state = parseSidebarSplitState(
      JSON.stringify({ version: 0 }),
      TABS,
      SIDEBAR_FIXED_INFO_TAB_ID,
    );
    expect(countPanes(state.layout.root)).toBe(1);
    expect(
      getSidebarGroupForPane(state, state.layout.focusedPaneId)?.tabIds,
    ).toEqual(TABS);
  });

  it("parses raw v1 states written both with and without maximize state", () => {
    const split = splitOff(
      createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID),
      "file-a",
    );
    const withoutMaximize = parseSidebarSplitState(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(split).filter(([key]) => key !== "maximizedPaneId"),
        ),
      ),
      TABS,
      SIDEBAR_FIXED_INFO_TAB_ID,
    );
    const withNullMaximize = parseSidebarSplitState(
      JSON.stringify({ ...split, maximizedPaneId: null }),
      TABS,
      SIDEBAR_FIXED_INFO_TAB_ID,
    );
    expect(withoutMaximize).toEqual(split);
    expect(withNullMaximize).toEqual(split);
  });

  it("restores a valid maximized pane and clears only a stale maximize id", () => {
    const split = splitOff(
      createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID),
      "file-a",
    );
    const maximized = setSidebarPaneMaximized(
      split,
      split.layout.focusedPaneId,
    );
    expect(
      parseSidebarSplitState(
        serializeSidebarSplitState(maximized),
        TABS,
        SIDEBAR_FIXED_INFO_TAB_ID,
      ),
    ).toEqual(maximized);

    const stale = parseSidebarSplitState(
      JSON.stringify({ ...maximized, maximizedPaneId: "pane-missing" }),
      TABS,
      SIDEBAR_FIXED_INFO_TAB_ID,
    );
    expect(stale.layout).toEqual(split.layout);
    expect(stale.groups).toEqual(split.groups);
    expect(stale.maximizedPaneId).toBeNull();
  });

  it("preserves state identity for no-op reconciliation, selection, and focus", () => {
    const state = createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID);
    expect(
      reconcileSidebarSplitState(state, TABS, SIDEBAR_FIXED_INFO_TAB_ID),
    ).toBe(state);
    expect(
      selectSidebarTab(
        state,
        state.layout.focusedPaneId,
        SIDEBAR_FIXED_INFO_TAB_ID,
      ),
    ).toBe(state);
    expect(focusSidebarPane(state, state.layout.focusedPaneId)).toBe(state);
  });

  it("recognizes only the exact reconstructible unsplit default", () => {
    const canonical = createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID);
    expect(
      isCanonicalSidebarSplitState(canonical, TABS, SIDEBAR_FIXED_INFO_TAB_ID),
    ).toBe(true);

    const differentIdentity = createSidebarSplitState(
      TABS,
      SIDEBAR_FIXED_INFO_TAB_ID,
      { groupId: "group-restored", paneId: "pane-restored" },
    );
    expect(
      isCanonicalSidebarSplitState(
        differentIdentity,
        TABS,
        SIDEBAR_FIXED_INFO_TAB_ID,
      ),
    ).toBe(false);

    const reordered = createSidebarSplitState(
      [...TABS].reverse(),
      SIDEBAR_FIXED_INFO_TAB_ID,
    );
    expect(
      isCanonicalSidebarSplitState(reordered, TABS, SIDEBAR_FIXED_INFO_TAB_ID),
    ).toBe(false);
  });

  it("prunes split records with the fixed-tab cache's 14-day retention", () => {
    const now = 50 * 24 * 60 * 60 * 1000;
    const freshThreadId = "thread-fresh";
    const boundaryThreadId = "thread-boundary";
    const expiredThreadId = "thread-expired";
    const missingThreadId = "thread-missing";
    const freshSplitKey = sidebarSplitStorageKey(freshThreadId);
    const boundarySplitKey = sidebarSplitStorageKey(boundaryThreadId);
    const expiredSplitKey = sidebarSplitStorageKey(expiredThreadId);
    const missingSplitKey = sidebarSplitStorageKey(missingThreadId);
    const storage = createMemoryStorage({
      [freshSplitKey]: "fresh-layout",
      [boundarySplitKey]: "boundary-layout",
      [expiredSplitKey]: "expired-layout",
      [missingSplitKey]: "orphaned-layout",
      [getFixedPanelTabsStateStorageKey({ threadId: freshThreadId })]:
        JSON.stringify({ lastUsedAt: now - 1_000 }),
      [getFixedPanelTabsStateStorageKey({ threadId: boundaryThreadId })]:
        JSON.stringify({
          lastUsedAt: now - FIXED_PANEL_TABS_IDLE_EXPIRY_MS,
        }),
      [getFixedPanelTabsStateStorageKey({ threadId: expiredThreadId })]:
        JSON.stringify({
          lastUsedAt: now - FIXED_PANEL_TABS_IDLE_EXPIRY_MS - 1,
        }),
      unrelated: "keep-me",
    });

    pruneSidebarSplitStorage({ storage, now });

    expect(storage.has(freshSplitKey)).toBe(true);
    expect(storage.has(boundarySplitKey)).toBe(true);
    expect(storage.has(expiredSplitKey)).toBe(false);
    expect(storage.has(missingSplitKey)).toBe(false);
    expect(storage.has("unrelated")).toBe(true);
  });

  it("rejects persisted layouts that exceed the shared pane cap", () => {
    const oversized = persistedStateWithPaneCount(MAX_PANES + 1);
    const availableTabIds = Array.from(
      { length: MAX_PANES + 1 },
      (_, index) => `tab-${index}`,
    );
    const parsed = parseSidebarSplitState(
      JSON.stringify(oversized),
      availableTabIds,
      "tab-0",
    );
    expect(isCanonicalSidebarSplitState(parsed, availableTabIds, "tab-0")).toBe(
      true,
    );
  });

  it.each([
    {
      name: "duplicate pane ids",
      mutate: (state: SidebarSplitState) => {
        if (state.layout.root.type === "split") {
          const second = state.layout.root.children[1];
          if (second?.type === "pane") second.paneId = "pane-0";
        }
      },
    },
    {
      name: "duplicate group references",
      mutate: (state: SidebarSplitState) => {
        if (state.layout.root.type === "split") {
          state.layout.root.children[1] = sidebarPaneNode("pane-1", "group-0");
        }
      },
    },
    {
      name: "a stale focused pane",
      mutate: (state: SidebarSplitState) => {
        state.layout.focusedPaneId = "pane-missing";
      },
    },
    {
      name: "a mismatched group key and id",
      mutate: (state: SidebarSplitState) => {
        const group = state.groups["group-0"];
        if (group !== undefined) group.id = "group-renamed";
      },
    },
    {
      name: "an orphan group",
      mutate: (state: SidebarSplitState) => {
        state.groups.orphan = {
          id: "orphan",
          tabIds: ["orphan-tab"],
          activeTabId: "orphan-tab",
        };
      },
    },
    {
      name: "non-normalized split sizes",
      mutate: (state: SidebarSplitState) => {
        if (state.layout.root.type === "split") {
          state.layout.root.sizes = [0.75, 0.75];
        }
      },
    },
  ])("falls back safely for $name", ({ mutate }) => {
    const malformed = persistedStateWithPaneCount(2);
    mutate(malformed);
    const availableTabIds = ["tab-0", "tab-1"];
    const parsed = parseSidebarSplitState(
      JSON.stringify(malformed),
      availableTabIds,
      "tab-0",
    );
    expect(isCanonicalSidebarSplitState(parsed, availableTabIds, "tab-0")).toBe(
      true,
    );
  });

  it("round-trips a split and reconciles newly opened tabs into the focused pane", () => {
    const split = splitOff(
      createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID),
      "file-a",
    );
    const restored = parseSidebarSplitState(
      serializeSidebarSplitState(split),
      [...TABS, "terminal-a"],
      "terminal-a",
    );
    expect(countPanes(restored.layout.root)).toBe(2);
    expect(
      getSidebarGroupForPane(restored, restored.layout.focusedPaneId)?.tabIds,
    ).toContain("terminal-a");
  });

  it("restores closed tabs to their prior visible order", () => {
    const firstTabId = "browser:first";
    const secondTabId = "browser:second";
    let state = createSidebarSplitState(
      [SIDEBAR_FIXED_INFO_TAB_ID, firstTabId, secondTabId],
      secondTabId,
    );
    const firstPlacement = getSidebarTabPlacement(state, firstTabId);
    if (firstPlacement === null) throw new Error("Missing first tab placement");

    state = reconcileSidebarSplitState(
      state,
      [SIDEBAR_FIXED_INFO_TAB_ID, secondTabId],
      secondTabId,
    );
    const secondPlacement = getSidebarTabPlacement(state, secondTabId);
    if (secondPlacement === null)
      throw new Error("Missing second tab placement");
    state = reconcileSidebarSplitState(
      state,
      [SIDEBAR_FIXED_INFO_TAB_ID],
      SIDEBAR_FIXED_INFO_TAB_ID,
    );
    state = restoreSidebarTabPlacement(
      reconcileSidebarSplitState(
        state,
        [SIDEBAR_FIXED_INFO_TAB_ID, secondTabId],
        secondTabId,
      ),
      secondTabId,
      secondPlacement,
    );
    state = restoreSidebarTabPlacement(
      reconcileSidebarSplitState(
        state,
        [SIDEBAR_FIXED_INFO_TAB_ID, secondTabId, firstTabId],
        firstTabId,
      ),
      firstTabId,
      firstPlacement,
    );

    expect(
      getSidebarGroupForPane(state, state.layout.focusedPaneId)?.tabIds,
    ).toEqual([SIDEBAR_FIXED_INFO_TAB_ID, firstTabId, secondTabId]);
  });

  it("keeps a New Tab replacement in its existing split pane", () => {
    const newTabId = "new-tab:launcher";
    const terminalTabId = "terminal:term-a:none";
    const split = splitOff(
      createSidebarSplitState([SIDEBAR_FIXED_INFO_TAB_ID, newTabId], newTabId),
      newTabId,
      "bottom",
    );
    const replaced = replaceSidebarTab(split, newTabId, terminalTabId);
    const reconciled = reconcileSidebarSplitState(
      replaced,
      [SIDEBAR_FIXED_INFO_TAB_ID, terminalTabId],
      terminalTabId,
    );

    expect(countPanes(reconciled.layout.root)).toBe(2);
    expect(
      getSidebarGroupForPane(reconciled, reconciled.layout.focusedPaneId)
        ?.tabIds,
    ).toEqual([terminalTabId]);
  });

  it("preserves browser, terminal, and plugin tabs across persistence", () => {
    const liveTabIds = [
      SIDEBAR_FIXED_INFO_TAB_ID,
      "browser:docs:env-a",
      "terminal:term-a:none",
      "plugin-panel:side-chat:thread-a",
    ];
    let state = splitOff(
      createSidebarSplitState(liveTabIds, liveTabIds[1] ?? ""),
      liveTabIds[1] ?? "",
      "bottom",
    );
    const browserPaneId = state.layout.focusedPaneId;
    const sourcePane = listPanes(state.layout.root).find(
      (pane) => pane.paneId !== browserPaneId,
    );
    expect(sourcePane).toBeDefined();
    if (sourcePane === undefined) return;
    state = moveSidebarTab(
      state,
      sourcePane.paneId,
      liveTabIds[2] ?? "",
      { paneId: browserPaneId, zone: "right" },
      { groupId: "group-terminal" },
    );

    const restored = parseSidebarSplitState(
      serializeSidebarSplitState(state),
      liveTabIds,
      liveTabIds[2] ?? "",
    );
    const restoredTabIds = listPanes(restored.layout.root).flatMap(
      (pane) => getSidebarGroupForPane(restored, pane.paneId)?.tabIds ?? [],
    );
    expect(new Set(restoredTabIds)).toEqual(new Set(liveTabIds));
    expect(restoredTabIds).toHaveLength(liveTabIds.length);
  });

  it("keeps fixed tabs singleton while removing closed tabs", () => {
    const split = splitOff(
      createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID),
      SIDEBAR_FIXED_DIFF_TAB_ID,
    );
    const duplicate = {
      ...split,
      groups: Object.fromEntries(
        Object.entries(split.groups).map(([id, group]) => [
          id,
          { ...group, tabIds: [...group.tabIds, SIDEBAR_FIXED_INFO_TAB_ID] },
        ]),
      ),
    };
    const reconciled = reconcileSidebarSplitState(
      duplicate,
      [SIDEBAR_FIXED_INFO_TAB_ID, SIDEBAR_FIXED_DIFF_TAB_ID],
      SIDEBAR_FIXED_INFO_TAB_ID,
    );
    const allIds = listPanes(reconciled.layout.root).flatMap(
      (pane) => getSidebarGroupForPane(reconciled, pane.paneId)?.tabIds ?? [],
    );
    expect(
      allIds.filter((id) => id === SIDEBAR_FIXED_INFO_TAB_ID),
    ).toHaveLength(1);
    expect(allIds).not.toContain("file-a");
    const activeTabId = getSidebarGroupForPane(
      reconciled,
      reconciled.layout.focusedPaneId,
    )?.activeTabId;
    expect(allIds).toContain(activeTabId);
  });

  it("repairs the surviving active tab after a stale focused pane is pruned", () => {
    const split = splitOff(
      createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID),
      "file-a",
    );
    const reconciled = reconcileSidebarSplitState(
      split,
      [SIDEBAR_FIXED_INFO_TAB_ID, SIDEBAR_FIXED_DIFF_TAB_ID],
      SIDEBAR_FIXED_INFO_TAB_ID,
    );
    const survivor = getSidebarGroupForPane(
      reconciled,
      reconciled.layout.focusedPaneId,
    );
    expect(countPanes(reconciled.layout.root)).toBe(1);
    expect(survivor?.activeTabId).toBe(SIDEBAR_FIXED_INFO_TAB_ID);
  });

  it("moves one tab, groups on center, and preserves pane-local reorder", () => {
    let state = splitOff(
      createSidebarSplitState([...TABS, "file-b"], SIDEBAR_FIXED_INFO_TAB_ID),
      "file-b",
    );
    const destinationPaneId = state.layout.focusedPaneId;
    const sourcePaneId = listPanes(state.layout.root).find(
      (pane) => pane.paneId !== destinationPaneId,
    )?.paneId;
    expect(sourcePaneId).toBeDefined();
    if (sourcePaneId === undefined) return;
    state = moveSidebarTab(
      state,
      sourcePaneId,
      "file-a",
      { paneId: destinationPaneId, zone: "center" },
      { groupId: "unused" },
    );
    state = reorderSidebarTab(state, destinationPaneId, "file-a", "file-b");
    expect(getSidebarGroupForPane(state, destinationPaneId)?.tabIds).toEqual([
      "file-a",
      "file-b",
    ]);
  });

  it("does not overwrite a restored group when a split id collides", () => {
    const state = splitOff(
      createSidebarSplitState([...TABS, "file-b"], SIDEBAR_FIXED_INFO_TAB_ID),
      "file-a",
    );
    const sourcePane = listPanes(state.layout.root).find((pane) =>
      getSidebarGroupForPane(state, pane.paneId)?.tabIds.includes("file-b"),
    );
    expect(sourcePane).toBeDefined();
    if (sourcePane === undefined) return;
    const collided = moveSidebarTab(
      state,
      sourcePane.paneId,
      "file-b",
      { paneId: sourcePane.paneId, zone: "bottom" },
      { groupId: "group-file-a" },
    );
    expect(collided).toBe(state);
  });

  it("removes the focused split while rehoming every tab and its active selection", () => {
    const split = splitOff(
      createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID),
      "file-a",
    );
    const removedPaneId = split.layout.focusedPaneId;

    const unsplit = removeSidebarSplit(split, removedPaneId);
    const survivor = getSidebarGroupForPane(
      unsplit,
      unsplit.layout.focusedPaneId,
    );

    expect(countPanes(unsplit.layout.root)).toBe(1);
    expect(survivor?.tabIds).toEqual([
      SIDEBAR_FIXED_INFO_TAB_ID,
      SIDEBAR_FIXED_DIFF_TAB_ID,
      "file-a",
    ]);
    expect(survivor?.activeTabId).toBe("file-a");
  });

  it("removes an unfocused split without stealing focus or active selection", () => {
    const split = splitOff(
      createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID),
      "file-a",
    );
    const focusedPaneId = split.layout.focusedPaneId;
    const removedPaneId = listPanes(split.layout.root).find(
      (pane) => pane.paneId !== focusedPaneId,
    )?.paneId;
    expect(removedPaneId).toBeDefined();
    if (removedPaneId === undefined) return;

    const unsplit = removeSidebarSplit(split, removedPaneId);
    const survivor = getSidebarGroupForPane(unsplit, focusedPaneId);

    expect(unsplit.layout.focusedPaneId).toBe(focusedPaneId);
    expect(survivor?.tabIds).toEqual([
      "file-a",
      SIDEBAR_FIXED_INFO_TAB_ID,
      SIDEBAR_FIXED_DIFF_TAB_ID,
    ]);
    expect(survivor?.activeTabId).toBe("file-a");
  });

  it("does not remove the only sidebar pane or an unknown pane", () => {
    const state = createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID);

    expect(removeSidebarSplit(state, state.layout.focusedPaneId)).toBe(state);
    expect(removeSidebarSplit(state, "pane-missing")).toBe(state);
  });

  it("clears maximize state when removing a split leaves one pane", () => {
    const split = splitOff(
      createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID),
      "file-a",
    );
    const maximized = setSidebarPaneMaximized(
      split,
      split.layout.focusedPaneId,
    );

    const unsplit = removeSidebarSplit(
      maximized,
      maximized.layout.focusedPaneId,
    );

    expect(countPanes(unsplit.layout.root)).toBe(1);
    expect(unsplit.maximizedPaneId).toBeNull();
  });

  it("carries maximize state to the focused survivor during reconciliation", () => {
    let state = splitOff(
      createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID),
      "file-a",
    );
    const source = listPanes(state.layout.root).find((pane) =>
      getSidebarGroupForPane(state, pane.paneId)?.tabIds.includes(
        SIDEBAR_FIXED_DIFF_TAB_ID,
      ),
    );
    expect(source).toBeDefined();
    if (source === undefined) return;
    state = moveSidebarTab(
      state,
      source.paneId,
      SIDEBAR_FIXED_DIFF_TAB_ID,
      { paneId: source.paneId, zone: "bottom" },
      { groupId: "group-diff" },
    );
    state = setSidebarPaneMaximized(state, state.layout.focusedPaneId);

    const reconciled = reconcileSidebarSplitState(
      state,
      [SIDEBAR_FIXED_INFO_TAB_ID, "file-a"],
      "file-a",
    );

    expect(countPanes(reconciled.layout.root)).toBe(2);
    expect(reconciled.maximizedPaneId).toBe(reconciled.layout.focusedPaneId);
  });

  it("moves panes through the shared split operations", () => {
    const split = splitOff(
      createSidebarSplitState(TABS, SIDEBAR_FIXED_INFO_TAB_ID),
      "file-a",
    );
    const panes = listPanes(split.layout.root);
    const sourcePaneId = panes[0]?.paneId;
    const targetPaneId = panes[1]?.paneId;
    expect(sourcePaneId).toBeDefined();
    expect(targetPaneId).toBeDefined();
    if (sourcePaneId === undefined || targetPaneId === undefined) return;

    const moved = moveSidebarPaneToSide(
      setSidebarPaneMaximized(split, sourcePaneId),
      sourcePaneId,
      targetPaneId,
      "top",
    );
    expect(moved.layout.root.type).toBe("split");
    if (moved.layout.root.type !== "split") return;
    expect(moved.layout.root.dir).toBe("col");
    expect(moved.maximizedPaneId).toBe(sourcePaneId);
  });

  it("uses the existing split cap and clamps divider fractions", () => {
    let state = createSidebarSplitState(
      Array.from({ length: MAX_PANES + 1 }, (_, index) => `tab-${index}`),
      "tab-0",
    );
    for (let index = 1; index <= MAX_PANES; index += 1) {
      const sourcePane = listPanes(state.layout.root).find((pane) =>
        getSidebarGroupForPane(state, pane.paneId)?.tabIds.includes(
          `tab-${index}`,
        ),
      );
      if (sourcePane === undefined) continue;
      state = moveSidebarTab(
        state,
        sourcePane.paneId,
        `tab-${index}`,
        { paneId: state.layout.focusedPaneId, zone: "bottom" },
        { groupId: `group-${index}` },
      );
    }
    expect(countPanes(state.layout.root)).toBe(MAX_PANES);
    const resized = resizeSidebarSplit(state, [], 0, 0.01);
    if (resized.layout.root.type !== "split") throw new Error("expected split");
    const pairTotal =
      (resized.layout.root.sizes[0] ?? 0) + (resized.layout.root.sizes[1] ?? 0);
    expect(
      (resized.layout.root.sizes[0] ?? 0) / pairTotal,
    ).toBeGreaterThanOrEqual(0.15);
  });
});
