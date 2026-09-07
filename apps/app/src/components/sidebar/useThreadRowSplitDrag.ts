import { useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "jotai";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { getThreadRoutePath } from "@/lib/route-paths";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import {
  countPanes,
  findPaneByThread,
  listPanes,
  MAX_PANES,
  replacePaneContent,
  setFocus,
  splitPane,
  type SplitLayout,
  type PaneContent,
} from "@/lib/split-layout";
import { openThreadInSplit } from "@/lib/split-layout/openThreadInSplit";
import {
  beginSplitDrag,
  decideThreadDrop,
  shouldEngageSidebarSplitDrag,
  type SplitDragFallbackTarget,
} from "@/lib/split-drag";

interface UseThreadRowSplitDragArgs {
  projectId: string;
  threadId: string;
  title: string;
}

const SIDEBAR_SELECTOR = '[data-sidebar="sidebar"]';
const MAIN_CONTENT_SELECTOR = "main";

export function useThreadRowSplitDrag({
  projectId,
  threadId,
  title,
}: UseThreadRowSplitDragArgs): {
  onPointerDown: ((event: ReactPointerEvent<HTMLElement>) => void) | undefined;
  openInSplit: () => void;
} {
  const store = useStore();
  const navigate = useRouteNavigate();
  const isCompact = useIsCompactViewport();

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      const rowEl = event.currentTarget;
      const sidebarEl = rowEl.closest(SIDEBAR_SELECTOR);
      const sidebarRightEdge = (sidebarEl ?? rowEl).getBoundingClientRect()
        .right;
      const startX = event.clientX;
      const startY = event.clientY;
      const content: PaneContent = { kind: "thread", projectId, threadId };
      const startLayout = store.get(splitLayoutAtom);
      const fallback = singlePaneFallback(startLayout);

      beginSplitDrag({
        ghostLabel: title,
        sourceEl: rowEl,
        cancelSidebarReorderOnEngage: true,
        ...(fallback ? { fallback } : {}),
        shouldEngage: (x, y) =>
          shouldEngageSidebarSplitDrag({
            startX,
            startY,
            x,
            y,
            sidebarRightEdge,
          }),
        decide: (_paneId, zone) => {
          const layout = store.get(splitLayoutAtom);
          if (layout === null) {
            return null;
          }
          return decideThreadDrop({
            zone,
            threadAlreadyOpen:
              findPaneByThread(layout.root, projectId, threadId) !== null,
            atMaxPanes: countPanes(layout.root) >= MAX_PANES,
          });
        },
        onDrop: (target) => {
          const layout = store.get(splitLayoutAtom);
          if (layout === null) {
            return;
          }
          const existing = findPaneByThread(layout.root, projectId, threadId);
          const next =
            existing !== null
              ? setFocus(layout, existing.paneId)
              : target.zone === "center"
                ? replacePaneContent(layout, target.paneId, content)
                : splitPane(layout, target.paneId, target.zone, content);
          if (next !== layout) {
            store.set(splitLayoutAtom, next);
          }
          navigate(
            getThreadRoutePath({ projectId, threadId }),
            existing !== null ? { replace: true } : undefined,
          );
        },
      });
    },
    [navigate, projectId, store, threadId, title],
  );

  const openInSplit = useCallback(() => {
    openThreadInSplit({
      store,
      navigate,
      projectId,
      threadId,
      isCompact,
    });
  }, [isCompact, navigate, projectId, store, threadId]);

  return {
    onPointerDown: !isCompact ? onPointerDown : undefined,
    openInSplit,
  };
}

function singlePaneFallback(
  layout: SplitLayout | null,
): SplitDragFallbackTarget | null {
  if (layout === null) {
    return null;
  }
  const panes = listPanes(layout.root);
  const only = panes[0];
  if (panes.length !== 1 || only === undefined) {
    return null;
  }
  return {
    paneId: only.paneId,
    container: document.querySelector<HTMLElement>(MAIN_CONTENT_SELECTOR),
  };
}
