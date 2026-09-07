export type EntryKind = "file" | "directory";

export interface FlatEntry {
  path: string;
  kind: EntryKind;
}

export interface TreeNode {
  path: string;
  name: string;
  kind: EntryKind;
  children: TreeNode[];
}

export function buildTree(entries: readonly FlatEntry[]): TreeNode[] {
  const root: TreeNode = {
    path: "",
    name: "",
    kind: "directory",
    children: [],
  };
  const byPath = new Map<string, TreeNode>([["", root]]);

  const directoryAt = (path: string): TreeNode => {
    const existing = byPath.get(path);
    if (existing !== undefined) return existing;
    const separator = path.lastIndexOf("/");
    const parent = directoryAt(
      separator === -1 ? "" : path.slice(0, separator),
    );
    const node: TreeNode = {
      path,
      name: path.slice(separator + 1),
      kind: "directory",
      children: [],
    };
    byPath.set(path, node);
    parent.children.push(node);
    return node;
  };

  for (const entry of entries) {
    const path = normalize(entry.path);
    if (path === "") continue;
    if (entry.kind === "directory") {
      directoryAt(path);
      continue;
    }
    if (byPath.has(path)) continue;
    const separator = path.lastIndexOf("/");
    const parent = directoryAt(
      separator === -1 ? "" : path.slice(0, separator),
    );
    const node: TreeNode = {
      path,
      name: path.slice(separator + 1),
      kind: "file",
      children: [],
    };
    byPath.set(path, node);
    parent.children.push(node);
  }

  sortRecursively(root);
  return root.children;
}

function normalize(path: string): string {
  return path.replace(/^\.?\//, "").replace(/\/+$/, "");
}

function sortRecursively(node: TreeNode): void {
  node.children.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
  for (const child of node.children) sortRecursively(child);
}

export function ancestorsOf(path: string): string[] {
  const segments = normalize(path).split("/");
  segments.pop();
  const ancestors: string[] = [];
  let current = "";
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`;
    ancestors.push(current);
  }
  return ancestors;
}

export interface FilteredTree {
  nodes: TreeNode[];
  expand: Set<string>;
  matchCount: number;
}

export function filterTree(
  nodes: readonly TreeNode[],
  query: string,
): FilteredTree {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return { nodes: [...nodes], expand: new Set(), matchCount: 0 };
  }

  const expand = new Set<string>();
  let matchCount = 0;

  const visit = (node: TreeNode): TreeNode | null => {
    if (node.kind === "file") {
      if (!node.path.toLowerCase().includes(needle)) return null;
      matchCount += 1;
      return node;
    }
    const children = node.children
      .map(visit)
      .filter((child): child is TreeNode => child !== null);
    if (children.length === 0) return null;
    expand.add(node.path);
    return { ...node, children };
  };

  return {
    nodes: nodes.map(visit).filter((node): node is TreeNode => node !== null),
    expand,
    matchCount,
  };
}
