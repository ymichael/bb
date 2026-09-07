import { useMemo, type CSSProperties } from "react";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
  DropAnimation,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const SIDEBAR_SORTABLE_TRANSITION = {
  duration: 160,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
};

export const SIDEBAR_DRAG_OVERLAY_DROP_ANIMATION: DropAnimation = {
  duration: 180,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: null,
};

export interface SidebarSortableDragBindings {
  attributes: DraggableAttributes;
  disabled: boolean;
  listeners: DraggableSyntheticListeners;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
}

interface UseSidebarSortableArgs {
  id: string;
  disabled: boolean;
}

interface UseSidebarSortableResult {
  dragBindings: SidebarSortableDragBindings;
  isOver: boolean;
  setNodeRef: (element: HTMLElement | null) => void;
  style: CSSProperties;
}

export function useSidebarSortable({
  id,
  disabled,
}: UseSidebarSortableArgs): UseSidebarSortableResult {
  const {
    attributes,
    isDragging,
    isOver,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id, disabled, transition: SIDEBAR_SORTABLE_TRANSITION });
  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Translate.toString(transform),
      transition,
      position: isDragging ? "relative" : undefined,
      zIndex: isDragging ? 100 : undefined,
      opacity: isDragging ? 0.8 : undefined,
    }),
    [isDragging, transform, transition],
  );
  const dragBindings = useMemo<SidebarSortableDragBindings>(
    () => ({ attributes, disabled, listeners, setActivatorNodeRef }),
    [attributes, disabled, listeners, setActivatorNodeRef],
  );

  return { dragBindings, isOver, setNodeRef, style };
}
