import type { PaneNode } from "@/lib/split-layout";

export function getAdjacentPaneId(
  panes: readonly PaneNode[],
  focusedPaneId: string,
  offset: -1 | 1,
): string | null {
  if (panes.length < 2) {
    return null;
  }
  const focusedIndex = panes.findIndex((pane) => pane.paneId === focusedPaneId);
  const startIndex = focusedIndex === -1 ? 0 : focusedIndex;
  const nextIndex = (startIndex + offset + panes.length) % panes.length;
  return panes[nextIndex]?.paneId ?? null;
}
