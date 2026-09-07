export const DEFAULT_TREE_HEIGHT = 256;

export const MIN_TREE_HEIGHT = 96;

export const MIN_EDITOR_HEIGHT = 120;

const STORAGE_KEY = "bb-plugin-monaco-editor:file-tree-height";

export function clampTreeHeight(height: number, available: number): number {
  const max = Math.max(MIN_TREE_HEIGHT, available - MIN_EDITOR_HEIGHT);
  return Math.round(Math.min(Math.max(height, MIN_TREE_HEIGHT), max));
}

export function readStoredTreeHeight(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_TREE_HEIGHT;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TREE_HEIGHT;
    return Math.max(parsed, MIN_TREE_HEIGHT);
  } catch {
    return DEFAULT_TREE_HEIGHT;
  }
}

export function storeTreeHeight(height: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(height)));
  } catch {}
}
