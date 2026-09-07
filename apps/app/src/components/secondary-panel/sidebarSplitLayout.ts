import { z } from "zod";
import {
  MAX_PANES,
  countPanes,
  findPane,
  listPanes,
  movePane,
  removePane,
  resizeSplit,
  setFocus,
  splitPane,
  type LayoutNode,
  type PaneContent,
  type PaneNode,
  type SplitLayout,
  type SplitPath,
  type SplitSide,
} from "@/lib/split-layout";
import type { SplitDropTarget } from "@/lib/split-drag";
import {
  FIXED_PANEL_TABS_IDLE_EXPIRY_MS,
  createGitDiffFixedPanelTab,
  createThreadInfoFixedPanelTab,
  getFixedPanelTabsStateStorageKey,
} from "@/lib/fixed-panel-tabs-state";

const SIDEBAR_SPLIT_LAYOUT_STORAGE_VERSION = 1;
const SIDEBAR_SPLIT_LAYOUT_STORAGE_PREFIX =
  "bb.thread.secondaryPanelSplitLayout";
export const SIDEBAR_FIXED_INFO_TAB_ID = createThreadInfoFixedPanelTab().id;
export const SIDEBAR_FIXED_DIFF_TAB_ID = createGitDiffFixedPanelTab().id;

const SIDEBAR_SPLIT_PLUGIN_ID = "bb-secondary-panel-split";
const NORMALIZED_SPLIT_SIZE_EPSILON = 1e-9;

export interface SidebarSplitStorage {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
}

export interface SidebarTabGroup {
  id: string;
  tabIds: string[];
  activeTabId: string;
}

export interface SidebarSplitState {
  version: typeof SIDEBAR_SPLIT_LAYOUT_STORAGE_VERSION;
  groups: Record<string, SidebarTabGroup>;
  layout: SplitLayout;
  maximizedPaneId: string | null;
}

export interface SidebarTabPlacement {
  followingTabId: string | null;
  groupId: string;
  index: number;
  precedingTabId: string | null;
}

interface SidebarSplitIds {
  groupId: string;
  paneId: string;
}

function groupContent(groupId: string): PaneContent {
  return {
    kind: "plugin-panel",
    pluginId: SIDEBAR_SPLIT_PLUGIN_ID,
    panelPath: groupId,
    subPath: "",
  };
}

export function sidebarPaneNode(paneId: string, groupId: string): PaneNode {
  return { type: "pane", paneId, content: groupContent(groupId) };
}

export function sidebarPaneGroupId(pane: PaneNode): string | null {
  return pane.content.kind === "plugin-panel" &&
    pane.content.pluginId === SIDEBAR_SPLIT_PLUGIN_ID
    ? pane.content.panelPath
    : null;
}

export function createSidebarSplitState(
  tabIds: readonly string[],
  activeTabId: string,
  ids: SidebarSplitIds = { groupId: "group-primary", paneId: "pane-primary" },
): SidebarSplitState {
  const normalizedTabs = [...new Set(tabIds)];
  const resolvedActive = normalizedTabs.includes(activeTabId)
    ? activeTabId
    : (normalizedTabs[0] ?? SIDEBAR_FIXED_INFO_TAB_ID);
  return {
    version: SIDEBAR_SPLIT_LAYOUT_STORAGE_VERSION,
    groups: {
      [ids.groupId]: {
        id: ids.groupId,
        tabIds: normalizedTabs,
        activeTabId: resolvedActive,
      },
    },
    layout: {
      root: sidebarPaneNode(ids.paneId, ids.groupId),
      focusedPaneId: ids.paneId,
    },
    maximizedPaneId: null,
  };
}

function areStringArraysEqual(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

function areLayoutNodesEqual(first: LayoutNode, second: LayoutNode): boolean {
  if (first.type !== second.type) return false;
  if (first.type === "pane" || second.type === "pane") {
    return (
      first.type === "pane" &&
      second.type === "pane" &&
      first.paneId === second.paneId &&
      sidebarPaneGroupId(first) === sidebarPaneGroupId(second)
    );
  }
  return (
    first.dir === second.dir &&
    first.sizes.length === second.sizes.length &&
    first.sizes.every((size, index) => size === second.sizes[index]) &&
    first.children.length === second.children.length &&
    first.children.every((child, index) => {
      const otherChild = second.children[index];
      return otherChild !== undefined && areLayoutNodesEqual(child, otherChild);
    })
  );
}

function areSidebarSplitStatesEqual(
  first: SidebarSplitState,
  second: SidebarSplitState,
): boolean {
  const firstGroupIds = Object.keys(first.groups);
  const secondGroupIds = Object.keys(second.groups);
  if (
    first.version !== second.version ||
    first.layout.focusedPaneId !== second.layout.focusedPaneId ||
    first.maximizedPaneId !== second.maximizedPaneId ||
    !areStringArraysEqual(firstGroupIds, secondGroupIds) ||
    !areLayoutNodesEqual(first.layout.root, second.layout.root)
  ) {
    return false;
  }
  return firstGroupIds.every((groupId) => {
    const firstGroup = first.groups[groupId];
    const secondGroup = second.groups[groupId];
    return (
      firstGroup !== undefined &&
      secondGroup !== undefined &&
      firstGroup.id === secondGroup.id &&
      firstGroup.activeTabId === secondGroup.activeTabId &&
      areStringArraysEqual(firstGroup.tabIds, secondGroup.tabIds)
    );
  });
}

function preserveSidebarSplitStateIdentity(
  current: SidebarSplitState,
  next: SidebarSplitState,
): SidebarSplitState {
  return areSidebarSplitStatesEqual(current, next) ? current : next;
}

export function getSidebarTabPlacement(
  state: SidebarSplitState,
  tabId: string,
): SidebarTabPlacement | null {
  const group = Object.values(state.groups).find((candidate) =>
    candidate.tabIds.includes(tabId),
  );
  if (group === undefined) return null;
  const index = group.tabIds.indexOf(tabId);
  return {
    followingTabId: group.tabIds[index + 1] ?? null,
    groupId: group.id,
    index,
    precedingTabId: group.tabIds[index - 1] ?? null,
  };
}

export function restoreSidebarTabPlacement(
  state: SidebarSplitState,
  tabId: string,
  placement: SidebarTabPlacement,
): SidebarSplitState {
  const currentGroup = Object.values(state.groups).find((group) =>
    group.tabIds.includes(tabId),
  );
  if (currentGroup === undefined) return state;
  const placedGroup = state.groups[placement.groupId];
  const targetGroup =
    placedGroup !== undefined &&
    (placedGroup.id === currentGroup.id || currentGroup.tabIds.length > 1)
      ? placedGroup
      : currentGroup;
  const groups = Object.fromEntries(
    Object.entries(state.groups).map(([groupId, group]) => {
      const tabIds = group.tabIds.filter((candidate) => candidate !== tabId);
      return [
        groupId,
        {
          ...group,
          tabIds,
          activeTabId:
            group.activeTabId === tabId
              ? (tabIds[0] ?? targetGroup.activeTabId)
              : group.activeTabId,
        },
      ];
    }),
  );
  const nextTargetGroup = groups[targetGroup.id];
  if (nextTargetGroup === undefined) return state;
  const followingIndex =
    placement.followingTabId === null
      ? -1
      : nextTargetGroup.tabIds.indexOf(placement.followingTabId);
  const precedingIndex =
    placement.precedingTabId === null
      ? -1
      : nextTargetGroup.tabIds.indexOf(placement.precedingTabId);
  const insertAt =
    followingIndex >= 0
      ? followingIndex
      : precedingIndex >= 0
        ? precedingIndex + 1
        : Math.min(placement.index, nextTargetGroup.tabIds.length);
  const tabIds = [...nextTargetGroup.tabIds];
  tabIds.splice(insertAt, 0, tabId);
  groups[targetGroup.id] = { ...nextTargetGroup, tabIds };
  return { ...state, groups };
}

function insertMissingTabsInAvailableOrder(
  tabIds: readonly string[],
  missingTabIds: readonly string[],
  availableTabIds: readonly string[],
): string[] {
  const next = [...tabIds];
  for (const missingTabId of missingTabIds) {
    const availableIndex = availableTabIds.indexOf(missingTabId);
    const followingTabId = availableTabIds
      .slice(availableIndex + 1)
      .find((tabId) => next.includes(tabId));
    if (followingTabId !== undefined) {
      next.splice(next.indexOf(followingTabId), 0, missingTabId);
      continue;
    }
    const precedingTabId = availableTabIds
      .slice(0, availableIndex)
      .reverse()
      .find((tabId) => next.includes(tabId));
    const insertAt =
      precedingTabId === undefined
        ? next.length
        : next.indexOf(precedingTabId) + 1;
    next.splice(insertAt, 0, missingTabId);
  }
  return next;
}

export function isCanonicalSidebarSplitState(
  state: SidebarSplitState,
  availableTabIds: readonly string[],
  activeTabId: string,
): boolean {
  return areSidebarSplitStatesEqual(
    state,
    createSidebarSplitState(availableTabIds, activeTabId),
  );
}

export function getSidebarGroupForPane(
  state: SidebarSplitState,
  paneId: string,
): SidebarTabGroup | null {
  const pane = findPane(state.layout.root, paneId);
  const groupId = pane === null ? null : sidebarPaneGroupId(pane);
  return groupId === null ? null : (state.groups[groupId] ?? null);
}

export function selectSidebarTab(
  state: SidebarSplitState,
  paneId: string,
  tabId: string,
): SidebarSplitState {
  const pane = findPane(state.layout.root, paneId);
  const groupId = pane === null ? null : sidebarPaneGroupId(pane);
  const group = groupId === null ? undefined : state.groups[groupId];
  if (
    groupId === null ||
    group === undefined ||
    !group.tabIds.includes(tabId)
  ) {
    return state;
  }
  const maximizedPaneId = state.maximizedPaneId === null ? null : paneId;
  if (
    group.activeTabId === tabId &&
    state.layout.focusedPaneId === paneId &&
    state.maximizedPaneId === maximizedPaneId
  ) {
    return state;
  }
  return {
    ...state,
    groups: {
      ...state.groups,
      [groupId]: { ...group, activeTabId: tabId },
    },
    layout: setFocus(state.layout, paneId),
    maximizedPaneId,
  };
}

export function focusSidebarPane(
  state: SidebarSplitState,
  paneId: string,
): SidebarSplitState {
  if (findPane(state.layout.root, paneId) === null) return state;
  const maximizedPaneId = state.maximizedPaneId === null ? null : paneId;
  if (
    state.layout.focusedPaneId === paneId &&
    state.maximizedPaneId === maximizedPaneId
  ) {
    return state;
  }
  return {
    ...state,
    layout: setFocus(state.layout, paneId),
    maximizedPaneId,
  };
}

export function replaceSidebarTab(
  state: SidebarSplitState,
  previousTabId: string,
  nextTabId: string,
): SidebarSplitState {
  if (previousTabId === nextTabId) return state;
  const groups = Object.values(state.groups);
  if (groups.some((group) => group.tabIds.includes(nextTabId))) return state;
  const owner = groups.find((group) => group.tabIds.includes(previousTabId));
  if (owner === undefined) return state;
  return {
    ...state,
    groups: {
      ...state.groups,
      [owner.id]: {
        ...owner,
        tabIds: owner.tabIds.map((tabId) =>
          tabId === previousTabId ? nextTabId : tabId,
        ),
        activeTabId:
          owner.activeTabId === previousTabId ? nextTabId : owner.activeTabId,
      },
    },
  };
}

export function reorderSidebarTab(
  state: SidebarSplitState,
  paneId: string,
  activeTabId: string,
  overTabId: string,
): SidebarSplitState {
  const pane = findPane(state.layout.root, paneId);
  const groupId = pane === null ? null : sidebarPaneGroupId(pane);
  const group = groupId === null ? undefined : state.groups[groupId];
  if (
    groupId === null ||
    group === undefined ||
    !group.tabIds.includes(activeTabId) ||
    !group.tabIds.includes(overTabId) ||
    activeTabId === overTabId
  ) {
    return state;
  }
  const from = group.tabIds.indexOf(activeTabId);
  const to = group.tabIds.indexOf(overTabId);
  const tabIds = [...group.tabIds];
  const [moved] = tabIds.splice(from, 1);
  if (moved === undefined) return state;
  tabIds.splice(to, 0, moved);
  return {
    ...state,
    groups: { ...state.groups, [groupId]: { ...group, tabIds } },
  };
}

export function moveSidebarTab(
  state: SidebarSplitState,
  sourcePaneId: string,
  tabId: string,
  target: SplitDropTarget,
  ids: Pick<SidebarSplitIds, "groupId">,
): SidebarSplitState {
  const sourcePane = findPane(state.layout.root, sourcePaneId);
  const targetPane = findPane(state.layout.root, target.paneId);
  if (sourcePane === null || targetPane === null) return state;
  const sourceGroupId = sidebarPaneGroupId(sourcePane);
  const targetGroupId = sidebarPaneGroupId(targetPane);
  const sourceGroup =
    sourceGroupId === null ? undefined : state.groups[sourceGroupId];
  const targetGroup =
    targetGroupId === null ? undefined : state.groups[targetGroupId];
  if (
    sourceGroupId === null ||
    targetGroupId === null ||
    sourceGroup === undefined ||
    targetGroup === undefined ||
    !sourceGroup.tabIds.includes(tabId)
  ) {
    return state;
  }

  if (target.zone === "center") {
    if (sourcePaneId === target.paneId) return state;
    const groups = { ...state.groups };
    groups[targetGroupId] = {
      ...targetGroup,
      tabIds: [...targetGroup.tabIds.filter((id) => id !== tabId), tabId],
      activeTabId: tabId,
    };
    if (sourceGroup.tabIds.length === 1) {
      delete groups[sourceGroupId];
      const layout = removePane(state.layout, sourcePaneId);
      return {
        ...state,
        groups,
        layout: setFocus(layout, target.paneId),
        maximizedPaneId:
          countPanes(layout.root) > 1 && state.maximizedPaneId !== null
            ? target.paneId
            : null,
      };
    }
    const remainingTabs = sourceGroup.tabIds.filter((id) => id !== tabId);
    groups[sourceGroupId] = {
      ...sourceGroup,
      tabIds: remainingTabs,
      activeTabId:
        sourceGroup.activeTabId === tabId
          ? (remainingTabs[0] ?? targetGroup.activeTabId)
          : sourceGroup.activeTabId,
    };
    return {
      ...state,
      groups,
      layout: setFocus(state.layout, target.paneId),
      maximizedPaneId: state.maximizedPaneId === null ? null : target.paneId,
    };
  }

  if (sourceGroup.tabIds.length === 1) {
    const layout = movePane(
      state.layout,
      sourcePaneId,
      target.paneId,
      target.zone,
    );
    return layout === state.layout ? state : { ...state, layout };
  }
  if (countPanes(state.layout.root) >= MAX_PANES) return state;
  if (state.groups[ids.groupId] !== undefined) return state;

  const remainingTabs = sourceGroup.tabIds.filter((id) => id !== tabId);
  const layout = splitPane(
    state.layout,
    target.paneId,
    target.zone,
    groupContent(ids.groupId),
  );
  return {
    ...state,
    groups: {
      ...state.groups,
      [sourceGroupId]: {
        ...sourceGroup,
        tabIds: remainingTabs,
        activeTabId:
          sourceGroup.activeTabId === tabId
            ? (remainingTabs[0] ?? sourceGroup.activeTabId)
            : sourceGroup.activeTabId,
      },
      [ids.groupId]: {
        id: ids.groupId,
        tabIds: [tabId],
        activeTabId: tabId,
      },
    },
    layout,
    maximizedPaneId:
      state.maximizedPaneId === sourcePaneId
        ? layout.focusedPaneId
        : state.maximizedPaneId,
  };
}

function removeEmptySidebarPane(
  state: SidebarSplitState,
  paneId: string,
): SidebarSplitState {
  if (countPanes(state.layout.root) <= 1) return state;
  const pane = findPane(state.layout.root, paneId);
  const closedGroupId = pane === null ? null : sidebarPaneGroupId(pane);
  const closedGroup =
    closedGroupId === null ? undefined : state.groups[closedGroupId];
  if (
    closedGroupId === null ||
    closedGroup === undefined ||
    closedGroup.tabIds.length > 0
  ) {
    return state;
  }

  const groups = { ...state.groups };
  delete groups[closedGroupId];
  const layout = removePane(state.layout, paneId);
  return {
    ...state,
    groups,
    layout,
    maximizedPaneId:
      state.maximizedPaneId === paneId
        ? countPanes(layout.root) > 1
          ? layout.focusedPaneId
          : null
        : countPanes(layout.root) > 1
          ? state.maximizedPaneId
          : null,
  };
}

export function removeSidebarSplit(
  state: SidebarSplitState,
  paneId: string,
): SidebarSplitState {
  if (countPanes(state.layout.root) <= 1) return state;
  const pane = findPane(state.layout.root, paneId);
  const removedGroupId = pane === null ? null : sidebarPaneGroupId(pane);
  const removedGroup =
    removedGroupId === null ? undefined : state.groups[removedGroupId];
  if (removedGroupId === null || removedGroup === undefined) return state;

  const removedFocusedPane = state.layout.focusedPaneId === paneId;
  const layout = removePane(state.layout, paneId);
  const survivorPane = findPane(layout.root, layout.focusedPaneId);
  const survivorGroupId =
    survivorPane === null ? null : sidebarPaneGroupId(survivorPane);
  const survivorGroup =
    survivorGroupId === null ? undefined : state.groups[survivorGroupId];
  if (survivorGroupId === null || survivorGroup === undefined) return state;

  const groups = { ...state.groups };
  delete groups[removedGroupId];
  groups[survivorGroupId] = {
    ...survivorGroup,
    tabIds: [
      ...survivorGroup.tabIds,
      ...removedGroup.tabIds.filter(
        (tabId) => !survivorGroup.tabIds.includes(tabId),
      ),
    ],
    activeTabId: removedFocusedPane
      ? removedGroup.activeTabId
      : survivorGroup.activeTabId,
  };
  return {
    ...state,
    groups,
    layout,
    maximizedPaneId:
      state.maximizedPaneId === paneId
        ? countPanes(layout.root) > 1
          ? layout.focusedPaneId
          : null
        : countPanes(layout.root) > 1
          ? state.maximizedPaneId
          : null,
  };
}

export function setSidebarPaneMaximized(
  state: SidebarSplitState,
  paneId: string | null,
): SidebarSplitState {
  if (paneId === null) {
    return state.maximizedPaneId === null
      ? state
      : { ...state, maximizedPaneId: null };
  }
  if (
    countPanes(state.layout.root) < 2 ||
    findPane(state.layout.root, paneId) === null
  ) {
    return state;
  }
  if (
    state.maximizedPaneId === paneId &&
    state.layout.focusedPaneId === paneId
  ) {
    return state;
  }
  return {
    ...state,
    layout: setFocus(state.layout, paneId),
    maximizedPaneId: paneId,
  };
}

export function toggleSidebarPaneMaximize(
  state: SidebarSplitState,
  paneId: string,
): SidebarSplitState {
  return setSidebarPaneMaximized(
    state,
    state.maximizedPaneId === paneId ? null : paneId,
  );
}

export function moveSidebarPaneToSide(
  state: SidebarSplitState,
  paneId: string,
  targetPaneId: string,
  side: SplitSide,
): SidebarSplitState {
  const layout = movePane(state.layout, paneId, targetPaneId, side);
  return layout === state.layout ? state : { ...state, layout };
}

export function resizeSidebarSplit(
  state: SidebarSplitState,
  path: SplitPath,
  childIndex: number,
  fraction: number,
): SidebarSplitState {
  const layout = resizeSplit(state.layout, path, childIndex, fraction);
  return layout === state.layout ? state : { ...state, layout };
}

export function reconcileSidebarSplitState(
  state: SidebarSplitState,
  availableTabIds: readonly string[],
  activeTabId: string,
): SidebarSplitState {
  const available = [...new Set(availableTabIds)];
  if (available.length === 0) return state;
  const allowed = new Set(available);
  const seen = new Set<string>();
  let next = state;
  const groups = { ...state.groups };

  for (const pane of listPanes(state.layout.root)) {
    const groupId = sidebarPaneGroupId(pane);
    const group = groupId === null ? undefined : groups[groupId];
    if (groupId === null || group === undefined) {
      return preserveSidebarSplitStateIdentity(
        state,
        createSidebarSplitState(available, activeTabId),
      );
    }
    const tabIds = group.tabIds.filter((id) => {
      if (!allowed.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    groups[groupId] = {
      ...group,
      tabIds,
      activeTabId: tabIds.includes(group.activeTabId)
        ? group.activeTabId
        : (tabIds[0] ?? activeTabId),
    };
  }

  next = { ...state, groups };
  for (const pane of listPanes(next.layout.root)) {
    const groupId = sidebarPaneGroupId(pane);
    const group = groupId === null ? undefined : next.groups[groupId];
    if (group !== undefined && group.tabIds.length === 0) {
      if (countPanes(next.layout.root) === 1) break;
      next = removeEmptySidebarPane(next, pane.paneId);
    }
  }

  const missing = available.filter((id) => !seen.has(id));
  const focusedGroup = getSidebarGroupForPane(next, next.layout.focusedPaneId);
  if (focusedGroup === null)
    return preserveSidebarSplitStateIdentity(
      state,
      createSidebarSplitState(available, activeTabId),
    );
  if (missing.length > 0 || focusedGroup.tabIds.length === 0) {
    next = {
      ...next,
      groups: {
        ...next.groups,
        [focusedGroup.id]: {
          ...focusedGroup,
          tabIds: insertMissingTabsInAvailableOrder(
            focusedGroup.tabIds,
            missing,
            available,
          ),
          activeTabId:
            focusedGroup.tabIds.length === 0
              ? activeTabId
              : focusedGroup.activeTabId,
        },
      },
    };
  }
  for (const pane of listPanes(next.layout.root)) {
    const groupId = sidebarPaneGroupId(pane);
    const group = groupId === null ? undefined : next.groups[groupId];
    if (
      groupId !== null &&
      group !== undefined &&
      !group.tabIds.includes(group.activeTabId)
    ) {
      const fallbackActiveTabId = group.tabIds[0];
      if (fallbackActiveTabId === undefined) {
        return preserveSidebarSplitStateIdentity(
          state,
          createSidebarSplitState(available, activeTabId),
        );
      }
      next = {
        ...next,
        groups: {
          ...next.groups,
          [groupId]: { ...group, activeTabId: fallbackActiveTabId },
        },
      };
    }
  }
  if (
    next.maximizedPaneId !== null &&
    findPane(next.layout.root, next.maximizedPaneId) === null
  ) {
    next = {
      ...next,
      maximizedPaneId:
        countPanes(next.layout.root) > 1 ? next.layout.focusedPaneId : null,
    };
  }
  return preserveSidebarSplitStateIdentity(state, next);
}

const paneContentSchema = z
  .object({
    kind: z.literal("plugin-panel"),
    pluginId: z.literal(SIDEBAR_SPLIT_PLUGIN_ID),
    panelPath: z.string().min(1),
    subPath: z.literal(""),
  })
  .strict();
const paneNodeSchema = z
  .object({
    type: z.literal("pane"),
    paneId: z.string().min(1),
    content: paneContentSchema,
  })
  .strict();
const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    paneNodeSchema,
    z
      .object({
        type: z.literal("split"),
        dir: z.enum(["row", "col"]),
        sizes: z.array(z.number().positive()).min(2),
        children: z.array(layoutNodeSchema).min(2),
      })
      .strict()
      .refine((node) => node.sizes.length === node.children.length),
  ]),
);

function hasNormalizedSplitSizes(node: LayoutNode): boolean {
  if (node.type === "pane") return true;
  const total = node.sizes.reduce((sum, size) => sum + size, 0);
  return (
    Math.abs(total - 1) <= NORMALIZED_SPLIT_SIZE_EPSILON &&
    node.children.every(hasNormalizedSplitSizes)
  );
}

const sidebarSplitStateSchema = z
  .object({
    version: z.literal(SIDEBAR_SPLIT_LAYOUT_STORAGE_VERSION),
    groups: z.record(
      z.string(),
      z
        .object({
          id: z.string().min(1),
          tabIds: z.array(z.string().min(1)).min(1),
          activeTabId: z.string().min(1),
        })
        .strict(),
    ),
    layout: z
      .object({
        root: layoutNodeSchema,
        focusedPaneId: z.string().min(1),
      })
      .strict(),
    maximizedPaneId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .superRefine((state, context) => {
    const panes = listPanes(state.layout.root);
    const paneIds = panes.map((pane) => pane.paneId);
    const groupIds = panes.map(sidebarPaneGroupId);
    const storedGroupIds = Object.keys(state.groups);

    if (panes.length > MAX_PANES) {
      context.addIssue({
        code: "custom",
        message: `A sidebar split supports at most ${MAX_PANES} panes`,
        path: ["layout", "root"],
      });
    }
    if (new Set(paneIds).size !== paneIds.length) {
      context.addIssue({
        code: "custom",
        message: "Sidebar pane IDs must be unique",
        path: ["layout", "root"],
      });
    }
    if (!paneIds.includes(state.layout.focusedPaneId)) {
      context.addIssue({
        code: "custom",
        message: "The focused sidebar pane must exist",
        path: ["layout", "focusedPaneId"],
      });
    }
    if (!hasNormalizedSplitSizes(state.layout.root)) {
      context.addIssue({
        code: "custom",
        message: "Sidebar split sizes must be normalized",
        path: ["layout", "root"],
      });
    }

    const referencedGroupIds = groupIds.filter(
      (groupId): groupId is string => groupId !== null,
    );
    if (
      referencedGroupIds.length !== panes.length ||
      new Set(referencedGroupIds).size !== referencedGroupIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Each sidebar pane must reference one unique tab group",
        path: ["layout", "root"],
      });
    }
    if (
      referencedGroupIds.length !== storedGroupIds.length ||
      referencedGroupIds.some((groupId) => state.groups[groupId] === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Sidebar tab groups must map one-to-one to panes",
        path: ["groups"],
      });
    }
    for (const [groupKey, group] of Object.entries(state.groups)) {
      if (group.id !== groupKey) {
        context.addIssue({
          code: "custom",
          message: "Sidebar tab group keys must match their IDs",
          path: ["groups", groupKey, "id"],
        });
      }
      if (!group.tabIds.includes(group.activeTabId)) {
        context.addIssue({
          code: "custom",
          message: "A sidebar group's active tab must belong to that group",
          path: ["groups", groupKey, "activeTabId"],
        });
      }
    }
  })
  .transform((storedState): SidebarSplitState => ({
    version: storedState.version,
    groups: storedState.groups,
    layout: storedState.layout,
    maximizedPaneId:
      storedState.maximizedPaneId !== undefined &&
      storedState.maximizedPaneId !== null &&
      findPane(storedState.layout.root, storedState.maximizedPaneId) !== null
        ? storedState.maximizedPaneId
        : null,
  }));

export function sidebarSplitStorageKey(panelStateId: string): string {
  return `${SIDEBAR_SPLIT_LAYOUT_STORAGE_PREFIX}.${panelStateId}`;
}

function getFixedPanelTabsLastUsedAt(
  storedValue: string | null,
): number | null {
  if (storedValue === null) return null;
  try {
    const parsed: unknown = JSON.parse(storedValue);
    if (typeof parsed !== "object" || parsed === null) return null;
    const lastUsedAt = Reflect.get(parsed, "lastUsedAt");
    return typeof lastUsedAt === "number" &&
      Number.isInteger(lastUsedAt) &&
      lastUsedAt >= 0
      ? lastUsedAt
      : null;
  } catch {
    return null;
  }
}

export function pruneSidebarSplitStorage({
  storage,
  now,
}: {
  storage: SidebarSplitStorage;
  now: number;
}): void {
  const splitKeys: string[] = [];
  const keyPrefix = `${SIDEBAR_SPLIT_LAYOUT_STORAGE_PREFIX}.`;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(keyPrefix)) splitKeys.push(key);
  }

  for (const splitKey of splitKeys) {
    const panelStateId = splitKey.slice(keyPrefix.length);
    const fixedPanelTabsKey = getFixedPanelTabsStateStorageKey({
      threadId: panelStateId,
    });
    const lastUsedAt = getFixedPanelTabsLastUsedAt(
      storage.getItem(fixedPanelTabsKey),
    );
    if (
      panelStateId.length === 0 ||
      lastUsedAt === null ||
      now - lastUsedAt > FIXED_PANEL_TABS_IDLE_EXPIRY_MS
    ) {
      storage.removeItem(splitKey);
    }
  }
}

export function parseSidebarSplitState(
  storedValue: string | null,
  availableTabIds: readonly string[],
  activeTabId: string,
): SidebarSplitState {
  if (storedValue !== null) {
    try {
      const parsed = sidebarSplitStateSchema.safeParse(JSON.parse(storedValue));
      if (parsed.success) {
        return reconcileSidebarSplitState(
          parsed.data,
          availableTabIds,
          activeTabId,
        );
      }
    } catch {}
  }
  return createSidebarSplitState(availableTabIds, activeTabId);
}

export function serializeSidebarSplitState(state: SidebarSplitState): string {
  return JSON.stringify(state);
}
