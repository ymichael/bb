import type {
  LayoutNode,
  PaneContent,
  PaneNode,
  SplitLayout,
  SplitNode,
  SplitPath,
  SplitSide,
} from "./types";

export const MAX_PANES = 8;

const MIN_SIZE = 0.15;
const MAX_SIZE = 0.85;
const SIZE_EPSILON = 1e-12;

export function clampSplitPairFraction(fraction: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, fraction));
}

export function listPanes(root: LayoutNode): PaneNode[] {
  if (root.type === "pane") {
    return [root];
  }
  return root.children.flatMap(listPanes);
}

export function countPanes(root: LayoutNode): number {
  if (root.type === "pane") {
    return 1;
  }
  return root.children.reduce((count, child) => count + countPanes(child), 0);
}

export function findPane(root: LayoutNode, paneId: string): PaneNode | null {
  if (root.type === "pane") {
    return root.paneId === paneId ? root : null;
  }
  for (const child of root.children) {
    const pane = findPane(child, paneId);
    if (pane !== null) {
      return pane;
    }
  }
  return null;
}

export function findPaneByThread(
  root: LayoutNode,
  projectId: string,
  threadId: string,
): PaneNode | null {
  return (
    listPanes(root).find(
      (pane) =>
        pane.content.kind === "thread" &&
        pane.content.projectId === projectId &&
        pane.content.threadId === threadId,
    ) ?? null
  );
}

export function findPaneByContent(
  root: LayoutNode,
  content: PaneContent,
): PaneNode | null {
  return (
    listPanes(root).find((pane) => {
      const candidate = pane.content;
      if (candidate.kind !== content.kind) return false;
      if (content.kind === "new-thread") return true;
      if (content.kind === "thread") {
        return (
          candidate.kind === "thread" &&
          candidate.projectId === content.projectId &&
          candidate.threadId === content.threadId
        );
      }
      if (content.kind === "plugin-detail") {
        return (
          candidate.kind === "plugin-detail" &&
          candidate.pluginId === content.pluginId
        );
      }
      return (
        candidate.kind === "plugin-panel" &&
        candidate.pluginId === content.pluginId &&
        candidate.panelPath === content.panelPath
      );
    }) ?? null
  );
}

function replacePaneNode(
  node: LayoutNode,
  paneId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.type === "pane") {
    return node.paneId === paneId ? replacement : node;
  }
  return {
    ...node,
    children: node.children.map((child) =>
      replacePaneNode(child, paneId, replacement),
    ),
  };
}

function nextPaneId(root: LayoutNode): string {
  const existingIds = new Set(listPanes(root).map((pane) => pane.paneId));
  let sequence = 1;
  while (existingIds.has(`pane-${sequence}`)) {
    sequence += 1;
  }
  return `pane-${sequence}`;
}

function splitDirection(side: SplitSide): SplitNode["dir"] {
  return side === "left" || side === "right" ? "row" : "col";
}

function insertPane(
  root: LayoutNode,
  targetPaneId: string,
  side: SplitSide,
  pane: PaneNode,
): LayoutNode {
  if (root.type === "pane") {
    if (root.paneId !== targetPaneId) {
      return root;
    }
    const paneComesFirst = side === "left" || side === "top";
    return {
      type: "split",
      dir: splitDirection(side),
      sizes: [0.5, 0.5],
      children: paneComesFirst ? [pane, root] : [root, pane],
    };
  }

  const directTargetIndex = root.children.findIndex(
    (child) => child.type === "pane" && child.paneId === targetPaneId,
  );
  const direction = splitDirection(side);
  if (root.dir === direction && directTargetIndex !== -1) {
    const insertionIndex =
      side === "left" || side === "top"
        ? directTargetIndex
        : directTargetIndex + 1;
    const children = [...root.children];
    children.splice(insertionIndex, 0, pane);
    return { ...root, children, sizes: equalSizes(children.length) };
  }

  const targetChildIndex = root.children.findIndex(
    (child) => findPane(child, targetPaneId) !== null,
  );
  if (targetChildIndex === -1) {
    return root;
  }
  return {
    ...root,
    children: root.children.map((child, index) =>
      index === targetChildIndex
        ? insertPane(child, targetPaneId, side, pane)
        : child,
    ),
  };
}

export function splitPane(
  layout: SplitLayout,
  targetPaneId: string,
  side: SplitSide,
  content: PaneContent,
): SplitLayout {
  if (
    countPanes(layout.root) >= MAX_PANES ||
    findPane(layout.root, targetPaneId) === null
  ) {
    return layout;
  }
  const pane: PaneNode = {
    type: "pane",
    paneId: nextPaneId(layout.root),
    content,
  };
  return {
    root: insertPane(layout.root, targetPaneId, side, pane),
    focusedPaneId: pane.paneId,
  };
}

export function replacePaneContent(
  layout: SplitLayout,
  paneId: string,
  content: PaneContent,
): SplitLayout {
  const pane = findPane(layout.root, paneId);
  if (pane === null) {
    return layout;
  }
  return {
    root: replacePaneNode(layout.root, paneId, { ...pane, content }),
    focusedPaneId: paneId,
  };
}

interface DetachResult {
  node: LayoutNode | null;
  detached: PaneNode | null;
}

function detachPane(node: LayoutNode, paneId: string): DetachResult {
  if (node.type === "pane") {
    return node.paneId === paneId
      ? { node: null, detached: node }
      : { node, detached: null };
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child === undefined) {
      continue;
    }
    const result = detachPane(child, paneId);
    if (result.detached === null) {
      continue;
    }
    if (result.node === null) {
      const children = node.children.filter(
        (_candidate, childIndex) => childIndex !== index,
      );
      if (children.length === 1) {
        return { node: children[0] ?? null, detached: result.detached };
      }
      return {
        node: {
          ...node,
          children,
          sizes: equalSizes(children.length),
        },
        detached: result.detached,
      };
    }
    return {
      node: {
        ...node,
        children: node.children.map((candidate, childIndex) =>
          childIndex === index ? (result.node ?? candidate) : candidate,
        ),
      },
      detached: result.detached,
    };
  }
  return { node, detached: null };
}

export function removePane(layout: SplitLayout, paneId: string): SplitLayout {
  const panesBefore = listPanes(layout.root);
  const removedIndex = panesBefore.findIndex((pane) => pane.paneId === paneId);
  if (panesBefore.length === 1 || removedIndex === -1) {
    return layout;
  }
  const result = detachPane(layout.root, paneId);
  if (result.node === null || result.detached === null) {
    return layout;
  }
  const panesAfter = listPanes(result.node);
  const fallbackPane =
    panesAfter[Math.min(removedIndex, panesAfter.length - 1)];
  return {
    root: result.node,
    focusedPaneId:
      layout.focusedPaneId === paneId && fallbackPane !== undefined
        ? fallbackPane.paneId
        : layout.focusedPaneId,
  };
}

export function movePane(
  layout: SplitLayout,
  paneId: string,
  targetPaneId: string,
  side: SplitSide,
): SplitLayout {
  if (
    paneId === targetPaneId ||
    findPane(layout.root, paneId) === null ||
    findPane(layout.root, targetPaneId) === null
  ) {
    return layout;
  }
  const result = detachPane(layout.root, paneId);
  if (result.node === null || result.detached === null) {
    return layout;
  }
  return {
    root: insertPane(result.node, targetPaneId, side, result.detached),
    focusedPaneId: paneId,
  };
}

export function swapPanes(
  layout: SplitLayout,
  paneId: string,
  targetPaneId: string,
): SplitLayout {
  if (paneId === targetPaneId) {
    return layout;
  }
  const pane = findPane(layout.root, paneId);
  const targetPane = findPane(layout.root, targetPaneId);
  if (pane === null || targetPane === null) {
    return layout;
  }
  const withFirstSwap = replacePaneNode(layout.root, paneId, {
    ...pane,
    content: targetPane.content,
  });
  return {
    root: replacePaneNode(withFirstSwap, targetPaneId, {
      ...targetPane,
      content: pane.content,
    }),
    focusedPaneId: targetPaneId,
  };
}

function equalSizes(count: number): number[] {
  if (count === 0) {
    return [];
  }
  return Array.from({ length: count }, () => 1 / count);
}

function normalizeSizes(
  sizes: readonly number[],
  childCount: number,
): number[] {
  if (
    sizes.length !== childCount ||
    sizes.some((size) => !Number.isFinite(size) || size <= 0)
  ) {
    return equalSizes(childCount);
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return equalSizes(childCount);
  }
  const normalized = sizes.map((size) =>
    Math.min(MAX_SIZE, Math.max(MIN_SIZE, size / total)),
  );

  for (let pass = 0; pass < childCount + 1; pass += 1) {
    const currentTotal = normalized.reduce((sum, size) => sum + size, 0);
    const difference = 1 - currentTotal;
    if (Math.abs(difference) <= SIZE_EPSILON) {
      break;
    }
    const adjustable = normalized
      .map((size, index) => ({ index, size }))
      .filter(({ size }) =>
        difference > 0 ? size < MAX_SIZE : size > MIN_SIZE,
      );
    if (adjustable.length === 0) {
      return equalSizes(childCount);
    }
    const adjustment = difference / adjustable.length;
    for (const { index } of adjustable) {
      const size = normalized[index];
      if (size !== undefined) {
        normalized[index] = Math.min(
          MAX_SIZE,
          Math.max(MIN_SIZE, size + adjustment),
        );
      }
    }
  }

  const finalTotal = normalized.reduce((sum, size) => sum + size, 0);
  const correctionIndex = normalized.findIndex((size) => {
    const corrected = size + (1 - finalTotal);
    return corrected >= MIN_SIZE && corrected <= MAX_SIZE;
  });
  if (correctionIndex !== -1) {
    const size = normalized[correctionIndex];
    if (size !== undefined) {
      normalized[correctionIndex] = size + (1 - finalTotal);
    }
  }
  return normalized;
}

function updateSplitAtPath(
  node: LayoutNode,
  splitPath: SplitPath,
  pathIndex: number,
  update: (split: SplitNode) => SplitNode | null,
): LayoutNode | null {
  if (pathIndex === splitPath.length) {
    return node.type === "split" ? update(node) : null;
  }
  if (node.type === "pane") {
    return null;
  }
  const childIndex = splitPath[pathIndex];
  if (childIndex === undefined || node.children[childIndex] === undefined) {
    return null;
  }
  const child = updateSplitAtPath(
    node.children[childIndex],
    splitPath,
    pathIndex + 1,
    update,
  );
  if (child === null) {
    return null;
  }
  return {
    ...node,
    children: node.children.map((candidate, index) =>
      index === childIndex ? child : candidate,
    ),
  };
}

export function resizeSplit(
  layout: SplitLayout,
  splitPath: SplitPath,
  childIndex: number,
  fraction: number,
): SplitLayout {
  if (!Number.isFinite(fraction)) {
    return layout;
  }
  const root = updateSplitAtPath(layout.root, splitPath, 0, (split) => {
    if (
      !Number.isInteger(childIndex) ||
      childIndex < 0 ||
      childIndex + 1 >= split.children.length
    ) {
      return null;
    }
    const sizes = normalizeSizes(split.sizes, split.children.length);
    const first = sizes[childIndex];
    const second = sizes[childIndex + 1];
    if (first === undefined || second === undefined) {
      return null;
    }
    const pairTotal = first + second;
    const pairFraction = clampSplitPairFraction(fraction);
    const nextSizes = [...sizes];
    nextSizes[childIndex] = pairTotal * pairFraction;
    nextSizes[childIndex + 1] = pairTotal * (1 - pairFraction);
    return { ...split, sizes: nextSizes };
  });
  return root === null ? layout : { ...layout, root };
}

export function setFocus(layout: SplitLayout, paneId: string): SplitLayout {
  if (findPane(layout.root, paneId) === null) {
    return layout;
  }
  return { ...layout, focusedPaneId: paneId };
}

function normalizeNode(node: LayoutNode): LayoutNode {
  if (node.type === "pane") {
    return { ...node };
  }
  const children = node.children.map(normalizeNode);
  if (children.length === 1) {
    return children[0] ?? node;
  }
  return {
    ...node,
    children,
    sizes: normalizeSizes(node.sizes, children.length),
  };
}

function trimToPaneLimit(root: LayoutNode): LayoutNode {
  let nextRoot = root;
  while (countPanes(nextRoot) > MAX_PANES) {
    const lastPane = listPanes(nextRoot).at(-1);
    if (lastPane === undefined) {
      break;
    }
    const result = detachPane(nextRoot, lastPane.paneId);
    if (result.node === null || result.detached === null) {
      break;
    }
    nextRoot = result.node;
  }
  return nextRoot;
}

export function normalize(layout: SplitLayout): SplitLayout {
  const root = normalizeNode(trimToPaneLimit(layout.root));
  const panes = listPanes(root);
  const focusedPaneId = panes.some(
    (pane) => pane.paneId === layout.focusedPaneId,
  )
    ? layout.focusedPaneId
    : (panes[0]?.paneId ?? layout.focusedPaneId);
  return { root, focusedPaneId };
}
