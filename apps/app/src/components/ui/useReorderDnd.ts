import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEventHandler,
} from "react";
import {
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DndContextProps,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
  type Sensor,
  type TouchSensorOptions,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  useDragClickSuppression,
  type ConsumeDragClickSuppression,
} from "@/components/ui/use-drag-click-suppression";

export const reorderCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

const restrictDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const REORDER_MODIFIERS: Modifier[] = [restrictDragToVerticalAxis];

export interface UseReorderDndArgs {
  onDragEnd: (event: DragEndEvent) => void;
  onDragStart?: (event: DragStartEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
  onDragCancel?: () => void;
  collisionDetection?: CollisionDetection;
  touchSensor?: Sensor<TouchSensorOptions>;
}

export type ReorderDndContextProps = Pick<
  DndContextProps,
  | "sensors"
  | "collisionDetection"
  | "onDragStart"
  | "onDragOver"
  | "onDragCancel"
  | "onDragEnd"
  | "modifiers"
>;

export interface UseReorderDndResult {
  dndContextProps: ReorderDndContextProps;
  consumeClickSuppression: ConsumeDragClickSuppression;
  onClickCapture: MouseEventHandler<HTMLElement>;
}

export function useReorderDnd({
  onDragEnd,
  onDragStart,
  onDragOver,
  onDragCancel,
  collisionDetection = reorderCollisionDetection,
  touchSensor = TouchSensor,
}: UseReorderDndArgs): UseReorderDndResult {
  const {
    beginDragClickSuppression,
    clearDragClickSuppressionSoon,
    consumeDragClickSuppression,
  } = useDragClickSuppression();
  const isDraggingRef = useRef(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(touchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      isDraggingRef.current = true;
      beginDragClickSuppression();
      onDragStart?.(event);
    },
    [beginDragClickSuppression, onDragStart],
  );
  const handleDragCancel = useCallback(() => {
    if (!isDraggingRef.current) {
      return;
    }
    isDraggingRef.current = false;
    clearDragClickSuppressionSoon();
    onDragCancel?.();
  }, [clearDragClickSuppressionSoon, onDragCancel]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      isDraggingRef.current = false;
      clearDragClickSuppressionSoon();
      onDragEnd(event);
    },
    [clearDragClickSuppressionSoon, onDragEnd],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code === "Escape") {
        handleDragCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      isDraggingRef.current = false;
    };
  }, [handleDragCancel]);
  const onClickCapture = useCallback<MouseEventHandler<HTMLElement>>(
    (event) => {
      if (!consumeDragClickSuppression()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [consumeDragClickSuppression],
  );
  const dndContextProps = useMemo<ReorderDndContextProps>(
    () => ({
      sensors,
      collisionDetection,
      modifiers: REORDER_MODIFIERS,
      onDragStart: handleDragStart,
      onDragOver,
      onDragCancel: handleDragCancel,
      onDragEnd: handleDragEnd,
    }),
    [
      collisionDetection,
      handleDragCancel,
      handleDragEnd,
      handleDragStart,
      onDragOver,
      sensors,
    ],
  );

  return {
    dndContextProps,
    consumeClickSuppression: consumeDragClickSuppression,
    onClickCapture,
  };
}
