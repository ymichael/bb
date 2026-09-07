import { useCallback, useEffect } from "react";
import {
  TouchSensor,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  getMediaQuerySnapshot,
  subscribeMediaQuery,
} from "@bb/shared-ui/hooks/use-media-query";
import {
  isCompactSidebarDrawerShowing,
  subscribeCompactSidebarDrawerShowing,
} from "@/components/ui/sidebar-mobile-drawer-visibility.js";
import {
  reorderCollisionDetection,
  useReorderDnd,
  type ReorderDndContextProps,
  type UseReorderDndArgs,
  type UseReorderDndResult,
} from "@/components/ui/useReorderDnd";

export const sidebarReorderCollisionDetection = reorderCollisionDetection;

function setSidebarDraggingCursor(active: boolean): void {
  if (active) {
    document.body.dataset.sidebarDragging = "true";
    return;
  }
  delete document.body.dataset.sidebarDragging;
}

type UseSidebarReorderDndArgs = Omit<UseReorderDndArgs, "touchSensor">;
export type SidebarReorderDndContextProps = ReorderDndContextProps;

function shouldInstallSidebarTouchMoveListener(): boolean {
  return (
    !getMediaQuerySnapshot(COMPACT_VIEWPORT_QUERY) ||
    isCompactSidebarDrawerShowing()
  );
}

export class SidebarTouchSensor extends TouchSensor {
  static override setup(): () => void {
    if (typeof window === "undefined") {
      return () => {};
    }
    const noop = () => {};
    let installed = false;
    const sync = () => {
      const wanted = shouldInstallSidebarTouchMoveListener();
      if (wanted && !installed) {
        window.addEventListener("touchmove", noop, {
          capture: false,
          passive: false,
        });
        installed = true;
      } else if (!wanted && installed) {
        window.removeEventListener("touchmove", noop);
        installed = false;
      }
    };
    sync();
    const unsubscribeDrawer = subscribeCompactSidebarDrawerShowing(sync);
    const unsubscribeViewport = subscribeMediaQuery(
      COMPACT_VIEWPORT_QUERY,
      sync,
    );
    return () => {
      unsubscribeDrawer();
      unsubscribeViewport();
      if (installed) {
        window.removeEventListener("touchmove", noop);
        installed = false;
      }
    };
  }
}

export function useSidebarReorderDnd({
  onDragEnd,
  onDragStart,
  onDragOver,
  onDragCancel,
  collisionDetection = sidebarReorderCollisionDetection,
}: UseSidebarReorderDndArgs): UseReorderDndResult {
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setSidebarDraggingCursor(true);
      onDragStart?.(event);
    },
    [onDragStart],
  );
  const handleDragCancel = useCallback(() => {
    setSidebarDraggingCursor(false);
    onDragCancel?.();
  }, [onDragCancel]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setSidebarDraggingCursor(false);
      onDragEnd(event);
    },
    [onDragEnd],
  );

  useEffect(() => {
    return () => {
      setSidebarDraggingCursor(false);
    };
  }, []);

  return useReorderDnd({
    onDragEnd: handleDragEnd,
    onDragStart: handleDragStart,
    onDragOver,
    onDragCancel: handleDragCancel,
    collisionDetection,
    touchSensor: SidebarTouchSensor,
  });
}
