import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { useResizeObserver } from "usehooks-ts";
import {
  secondaryPanelWidthPercentAtom,
  threadSecondaryPanelResizingAtom,
} from "./threadSecondaryPanelAtoms";
import { usePanelResizeSnap } from "./usePanelResizeSnap";

export type SecondaryPanelDraggingHandler = (isDragging: boolean) => void;
export type SecondaryPanelWidthChangeHandler = (
  width: number | undefined,
) => void;

type SecondaryPanelResizeHandler = (size: number) => void;

interface UseSecondaryPanelResizeArgs {
  isSecondaryPanelOpen: boolean;
  onPanelWidthChange: SecondaryPanelWidthChangeHandler;
}

export function useSecondaryPanelResize({
  isSecondaryPanelOpen,
  onPanelWidthChange,
}: UseSecondaryPanelResizeArgs) {
  const [isSecondaryPanelDragging, setIsSecondaryPanelDragging] =
    useState(false);
  const persistedWidthPercent = useAtomValue(secondaryPanelWidthPercentAtom);
  const setPersistedWidthPercent = useSetAtom(secondaryPanelWidthPercentAtom);
  const setIsResizing = useSetAtom(threadSecondaryPanelResizingAtom);
  const secondaryPanelRef = useRef<HTMLElement>(null!);
  const secondaryResizablePanelRef = useRef<ImperativePanelHandle | null>(null);
  const isSecondaryPanelDraggingRef = useRef(false);
  const lastSecondaryPanelSizeRef = useRef(persistedWidthPercent);
  const handleSecondaryPanelPointerResize = useCallback(
    (leadingFraction: number) => {
      secondaryResizablePanelRef.current?.resize((1 - leadingFraction) * 100);
    },
    [],
  );
  const {
    finish: finishSecondaryPanelResizeSnap,
    onPointerDownCapture: handleSecondaryPanelResizePointerDownCapture,
  } = usePanelResizeSnap({
    axis: "x",
    onResize: handleSecondaryPanelPointerResize,
    target: { boundaryIndex: 1, childCount: 2 },
  });

  const prevOpenRef = useRef(isSecondaryPanelOpen);
  useEffect(() => {
    if (prevOpenRef.current === isSecondaryPanelOpen) {
      return;
    }
    prevOpenRef.current = isSecondaryPanelOpen;

    const panel = secondaryResizablePanelRef.current;
    if (!panel) {
      return;
    }

    if (isSecondaryPanelOpen) {
      panel.expand(lastSecondaryPanelSizeRef.current);
      onPanelWidthChange(
        secondaryPanelRef.current?.getBoundingClientRect().width,
      );
    } else {
      panel.collapse();
    }
  }, [isSecondaryPanelOpen, onPanelWidthChange]);

  useResizeObserver({
    ref: secondaryPanelRef,
    onResize: ({ width }) => {
      onPanelWidthChange(
        width ?? secondaryPanelRef.current?.getBoundingClientRect().width,
      );
    },
  });

  const finishSecondaryPanelDragging = useCallback(() => {
    isSecondaryPanelDraggingRef.current = false;
    setIsSecondaryPanelDragging(false);
    setIsResizing(false);

    if (lastSecondaryPanelSizeRef.current > 0) {
      setPersistedWidthPercent(lastSecondaryPanelSizeRef.current);
    }
  }, [setIsResizing, setPersistedWidthPercent]);

  const handleSecondaryPanelDragging =
    useCallback<SecondaryPanelDraggingHandler>(
      (isDragging) => {
        if (isDragging) {
          isSecondaryPanelDraggingRef.current = true;
          setIsSecondaryPanelDragging(true);
          setIsResizing(true);
          return;
        }

        finishSecondaryPanelResizeSnap();
        finishSecondaryPanelDragging();
      },
      [
        finishSecondaryPanelDragging,
        finishSecondaryPanelResizeSnap,
        setIsResizing,
      ],
    );

  useEffect(
    () => () => {
      if (!isSecondaryPanelDraggingRef.current) {
        return;
      }
      isSecondaryPanelDraggingRef.current = false;
      setIsResizing(false);
    },
    [setIsResizing],
  );

  useEffect(() => {
    if (!isSecondaryPanelDragging) {
      return;
    }

    window.addEventListener("pointerup", finishSecondaryPanelDragging, true);
    window.addEventListener("mouseup", finishSecondaryPanelDragging, true);
    window.addEventListener(
      "pointercancel",
      finishSecondaryPanelDragging,
      true,
    );
    window.addEventListener("blur", finishSecondaryPanelDragging);

    return () => {
      window.removeEventListener(
        "pointerup",
        finishSecondaryPanelDragging,
        true,
      );
      window.removeEventListener("mouseup", finishSecondaryPanelDragging, true);
      window.removeEventListener(
        "pointercancel",
        finishSecondaryPanelDragging,
        true,
      );
      window.removeEventListener("blur", finishSecondaryPanelDragging);
    };
  }, [finishSecondaryPanelDragging, isSecondaryPanelDragging]);

  const handleSecondaryPanelResize = useCallback<SecondaryPanelResizeHandler>(
    (size) => {
      if (size <= 0) {
        return;
      }

      lastSecondaryPanelSizeRef.current = size;
      secondaryPanelRef.current?.style.setProperty(
        "--secondary-swipe-width",
        `${size}cqw`,
      );
    },
    [],
  );

  return {
    handleSecondaryPanelDragging,
    handleSecondaryPanelResize,
    handleSecondaryPanelResizePointerDownCapture,
    persistedWidthPercent,
    secondaryPanelRef,
    secondaryResizablePanelRef,
  };
}
