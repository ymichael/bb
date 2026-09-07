import * as React from "react";

import { useLatestRef } from "@/hooks/useLatestRef";

const DRAG_INTENT_PX = 12;
const DRAG_SETTLE_MS = 220;
const DRAG_CLICK_SUPPRESSION_MS = 400;
const BROWSER_NAVIGATION_EDGE_PX = 24;
const IGNORED_TARGET_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="slider"], [data-vaul-no-drag], [data-no-sidebar-swipe], [data-no-secondary-panel-swipe]';

type DragInput = "pointer" | "touch";

type DragSession = {
  input: DragInput;
  id: number;
  startX: number;
  startY: number;
  width: number;
  progress: number;
  lastX: number;
  lastTime: number;
  velocityX: number;
  dragging: boolean;
  target: Element | null;
  boundary: Element;
};

type DragProgress = {
  progress: number;
  settling: boolean;
  width: number;
};

type Options = {
  direction: "left" | "right";
  dismissTiming: "immediate" | "settled";
  enabled: boolean;
  getWidth: () => number;
  onClear: () => void;
  onDismiss: () => void;
  onProgress: (progress: DragProgress) => void;
  resetKey: string;
  suppressClick: boolean;
};

type Point = { x: number; y: number };

function getTouch(touches: TouchList, id: number): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch?.identifier === id) return touch;
  }
  return null;
}

function isTouchEvent(event: Event): event is TouchEvent {
  return "touches" in event && "changedTouches" in event;
}

function trackedPoint(event: Event, session: DragSession): Point | null {
  if (session.input === "touch") {
    if (!isTouchEvent(event)) return null;
    const touch =
      getTouch(event.touches, session.id) ??
      getTouch(event.changedTouches, session.id);
    return touch === null ? null : { x: touch.clientX, y: touch.clientY };
  }
  if (
    !("pointerId" in event) ||
    event.pointerId !== session.id ||
    !("clientX" in event) ||
    typeof event.clientX !== "number" ||
    !("clientY" in event) ||
    typeof event.clientY !== "number"
  ) {
    return null;
  }
  return { x: event.clientX, y: event.clientY };
}

function isScrollable(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null || !(element instanceof view.HTMLElement)) return false;
  const overflow = view.getComputedStyle(element).overflowX;
  return (
    (overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
    element.scrollWidth > element.clientWidth + 1
  );
}

function startsInHorizontalScroller(session: DragSession): boolean {
  let element = session.target;
  while (element !== null) {
    if (isScrollable(element)) return true;
    if (element === session.boundary) return false;
    element = element.parentElement;
  }
  return false;
}

function hasTextSelectionWithin(boundary: Element): boolean {
  const selection = boundary.ownerDocument.getSelection();
  if (selection === null || selection.isCollapsed) return false;
  return (
    (selection.anchorNode !== null &&
      boundary.contains(selection.anchorNode)) ||
    (selection.focusNode !== null && boundary.contains(selection.focusNode))
  );
}

function suppressNextClick() {
  const cleanup = () => {
    window.removeEventListener("click", suppress, { capture: true });
    window.clearTimeout(timeout);
  };
  const suppress = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    cleanup();
  };
  const timeout = window.setTimeout(cleanup, DRAG_CLICK_SUPPRESSION_MS);
  window.addEventListener("click", suppress, { capture: true, once: true });
}

export function useHorizontalDismissDrag(options: Options) {
  const optionsRef = useLatestRef(options);
  const sessionRef = React.useRef<DragSession | null>(null);
  const removeListenersRef = React.useRef<(() => void) | null>(null);
  const settleTimeoutRef = React.useRef<number | null>(null);

  const clearSession = React.useCallback(() => {
    removeListenersRef.current?.();
    removeListenersRef.current = null;
    sessionRef.current = null;
  }, []);

  const clearSettle = React.useCallback(() => {
    if (settleTimeoutRef.current === null) return;
    window.clearTimeout(settleTimeoutRef.current);
    settleTimeoutRef.current = null;
  }, []);

  const settle = React.useCallback(
    (progress: number, session: DragSession, dismiss: boolean) => {
      clearSettle();
      const current = optionsRef.current;
      current.onProgress({ progress, settling: true, width: session.width });
      if (dismiss && current.dismissTiming === "immediate") {
        current.onDismiss();
      }
      settleTimeoutRef.current = window.setTimeout(() => {
        settleTimeoutRef.current = null;
        if (dismiss && current.dismissTiming === "settled") {
          optionsRef.current.onDismiss();
        } else {
          optionsRef.current.onClear();
        }
      }, DRAG_SETTLE_MS);
    },
    [clearSettle, optionsRef],
  );

  const move = React.useCallback(
    (event: Event) => {
      const session = sessionRef.current;
      if (session === null) return;
      const point = trackedPoint(event, session);
      if (point === null) return;
      if (!session.dragging && hasTextSelectionWithin(session.boundary)) {
        clearSession();
        return;
      }
      const direction = optionsRef.current.direction === "left" ? -1 : 1;
      const deltaX = point.x - session.startX;
      const deltaY = point.y - session.startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (!session.dragging) {
        if (absY > DRAG_INTENT_PX && absY > absX * 1.15) {
          clearSession();
          return;
        }
        if (deltaX * direction < DRAG_INTENT_PX || absX <= absY * 1.25) {
          return;
        }
        if (
          session.target !== null &&
          (!session.target.isConnected || startsInHorizontalScroller(session))
        ) {
          clearSession();
          return;
        }
        session.dragging = true;
        clearSettle();
      }
      if (event.cancelable) event.preventDefault();
      const now = Date.now();
      const elapsed = now - session.lastTime;
      if (elapsed > 0) {
        session.velocityX = ((point.x - session.lastX) / elapsed) * 1000;
        session.lastX = point.x;
        session.lastTime = now;
      }
      session.progress = Math.min(
        1,
        Math.max(0, 1 - (deltaX * direction) / session.width),
      );
      optionsRef.current.onProgress({
        progress: session.progress,
        settling: false,
        width: session.width,
      });
    },
    [clearSession, clearSettle, optionsRef],
  );

  const finish = React.useCallback(
    (event: Event) => {
      const session = sessionRef.current;
      if (session === null || trackedPoint(event, session) === null) return;
      clearSession();
      if (!session.dragging) return;
      if (event.cancelable) event.preventDefault();
      if (optionsRef.current.suppressClick) suppressNextClick();
      const direction = optionsRef.current.direction === "left" ? -1 : 1;
      const dismiss =
        session.progress <= 0.75 ||
        (session.progress <= 0.88 && session.velocityX * direction >= 450);
      settle(dismiss ? 0 : 1, session, dismiss);
    },
    [clearSession, optionsRef, settle],
  );

  const cancel = React.useCallback(
    (event: Event) => {
      const session = sessionRef.current;
      if (session === null || trackedPoint(event, session) === null) return;
      clearSession();
      if (session.dragging) settle(1, session, false);
    },
    [clearSession, settle],
  );

  const listen = React.useCallback(
    (session: DragSession) => {
      const prefix = session.input;
      const moveType = `${prefix}move`;
      const endType = prefix === "pointer" ? "pointerup" : "touchend";
      const cancelType = `${prefix}cancel`;
      const remove = () => {
        window.removeEventListener(moveType, move);
        window.removeEventListener(endType, finish);
        window.removeEventListener(cancelType, cancel);
      };
      window.addEventListener(moveType, move, { passive: false });
      window.addEventListener(endType, finish);
      window.addEventListener(cancelType, cancel);
      removeListenersRef.current = remove;
    },
    [cancel, finish, move],
  );

  const start = React.useCallback(
    (
      input: DragInput,
      id: number,
      x: number,
      y: number,
      target: EventTarget | null,
      boundary: Element,
    ) => {
      if (hasTextSelectionWithin(boundary)) return;
      const view = boundary.ownerDocument.defaultView;
      if (
        (optionsRef.current.direction === "left" &&
          view !== null &&
          x > view.innerWidth - BROWSER_NAVIGATION_EDGE_PX) ||
        (optionsRef.current.direction === "right" &&
          x < BROWSER_NAVIGATION_EDGE_PX)
      ) {
        return;
      }
      const session: DragSession = {
        input,
        id,
        startX: x,
        startY: y,
        width: Math.max(optionsRef.current.getWidth(), 1),
        progress: 1,
        lastX: x,
        lastTime: Date.now(),
        velocityX: 0,
        dragging: false,
        target: target instanceof Element ? target : null,
        boundary,
      };
      sessionRef.current = session;
      listen(session);
    },
    [listen, optionsRef],
  );

  const beginPointerDrag = React.useCallback<
    React.PointerEventHandler<HTMLDivElement>
  >(
    (event) => {
      if (
        !optionsRef.current.enabled ||
        event.defaultPrevented ||
        event.pointerType !== "touch" ||
        event.button !== 0 ||
        sessionRef.current !== null ||
        (event.target instanceof Element &&
          event.target.closest(IGNORED_TARGET_SELECTOR) !== null)
      ) {
        return;
      }
      start(
        "pointer",
        event.pointerId,
        event.clientX,
        event.clientY,
        event.target,
        event.currentTarget,
      );
    },
    [optionsRef, start],
  );

  const beginTouchDrag = React.useCallback<
    React.TouchEventHandler<HTMLDivElement>
  >(
    (event) => {
      if (
        !optionsRef.current.enabled ||
        event.defaultPrevented ||
        event.touches.length !== 1 ||
        (event.target instanceof Element &&
          event.target.closest(IGNORED_TARGET_SELECTOR) !== null)
      ) {
        return;
      }
      if (sessionRef.current !== null) {
        if (sessionRef.current.input !== "pointer") return;
        clearSession();
      }
      const touch = event.touches.item(0);
      if (touch === null) return;
      start(
        "touch",
        touch.identifier,
        touch.clientX,
        touch.clientY,
        event.target,
        event.currentTarget,
      );
    },
    [clearSession, optionsRef, start],
  );

  React.useLayoutEffect(() => {
    if (options.enabled || options.dismissTiming === "settled") {
      clearSession();
      clearSettle();
      optionsRef.current.onClear();
    }
  }, [
    clearSession,
    clearSettle,
    options.dismissTiming,
    options.enabled,
    options.resetKey,
    optionsRef,
  ]);

  React.useEffect(
    () => () => {
      clearSession();
      clearSettle();
      optionsRef.current.onClear();
    },
    [clearSession, clearSettle, optionsRef],
  );

  return { beginPointerDrag, beginTouchDrag };
}
