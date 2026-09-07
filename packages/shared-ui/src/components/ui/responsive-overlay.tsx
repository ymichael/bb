import * as React from "react";
import { createPortal } from "react-dom";
import { Slot } from "@radix-ui/react-slot";

import {
  blurActiveKeyboardInputBeforeOverlayOpen,
  blurActiveKeyboardInputBeforeOverlayClose,
  blurActiveKeyboardInputWithin,
  getOverlayTriggerClassName,
  preventOverlayTriggerSelection,
} from "./overlay-trigger.js";
import { useIsCompactViewport } from "./hooks/use-compact-viewport.js";
import { usePortalScopeProps } from "../../lib/portal-scope.js";
import { cn } from "../../lib/utils.js";

export interface ResponsiveOverlayContextValue {
  isCompactViewport: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const RESPONSIVE_DRAWER_REALIZE_FALLBACK_MS = 120;

function resetDrawerKeyboardStyles(drawerElement: HTMLElement | null): void {
  if (drawerElement === null) return;

  drawerElement.style.height = "";
  drawerElement.style.bottom = "";
}

export function useResponsiveRoot(
  controlledOpen: boolean | undefined,
  controlledOnChange: ((open: boolean) => void) | undefined,
  defaultOpen: boolean = false,
): ResponsiveOverlayContextValue {
  const isCompactViewport = useIsCompactViewport();
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (open && !next && isCompactViewport) {
        blurActiveKeyboardInputBeforeOverlayClose();
      }
      if (!isControlled) {
        setInternalOpen(next);
      }
      controlledOnChange?.(next);
    },
    [isCompactViewport, isControlled, controlledOnChange, open],
  );

  return React.useMemo(
    () => ({ isCompactViewport, open, onOpenChange }),
    [isCompactViewport, open, onOpenChange],
  );
}

interface MobileTriggerProps {
  asChild?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  haspopup: "menu" | "dialog";
  children: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

export const MobileTrigger = React.forwardRef<
  HTMLButtonElement,
  MobileTriggerProps &
    Omit<
      React.ButtonHTMLAttributes<HTMLButtonElement>,
      keyof MobileTriggerProps
    >
>(
  (
    {
      asChild,
      open,
      onOpenChange,
      haspopup,
      onClick,
      children,
      className,
      ...domProps
    },
    ref,
  ) => {
    const triggerClassName = getOverlayTriggerClassName(className);
    const handleClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        if (!open) {
          blurActiveKeyboardInputBeforeOverlayOpen();
        }
        onOpenChange(!open);
      }
    };

    const ariaProps = {
      "aria-expanded": open,
      "aria-haspopup": haspopup,
      "data-state": open ? "open" : "closed",
    } as const;

    if (asChild) {
      return (
        <Slot
          ref={ref}
          onClick={handleClick}
          onMouseDown={preventOverlayTriggerSelection}
          className={triggerClassName}
          {...ariaProps}
          {...domProps}
        >
          {children}
        </Slot>
      );
    }

    return (
      <button
        ref={ref}
        type="button"
        onClick={handleClick}
        onMouseDown={preventOverlayTriggerSelection}
        className={triggerClassName}
        {...ariaProps}
        {...domProps}
      >
        {children}
      </button>
    );
  },
);
MobileTrigger.displayName = "MobileTrigger";

const RADIX_CONTENT_PROP_NAMES = [
  "side",
  "sideOffset",
  "align",
  "alignOffset",
  "collisionPadding",
  "collisionBoundary",
  "arrowPadding",
  "sticky",
  "hideWhenDetached",
  "avoidCollisions",
  "onOpenAutoFocus",
  "onCloseAutoFocus",
  "onEscapeKeyDown",
  "onPointerDownOutside",
  "onFocusOutside",
  "onInteractOutside",
] as const;

type RadixContentPropName = (typeof RADIX_CONTENT_PROP_NAMES)[number];

const RADIX_CONTENT_KEYS: ReadonlySet<string> = new Set(
  RADIX_CONTENT_PROP_NAMES,
);

export function stripRadixContentProps<T extends Record<string, unknown>>(
  props: T,
): Omit<T, RadixContentPropName> {
  const result = {} as Record<string, unknown>;
  for (const key of Object.keys(props)) {
    if (!RADIX_CONTENT_KEYS.has(key)) {
      result[key] = props[key];
    }
  }
  return result as Omit<T, RadixContentPropName>;
}

interface ResponsiveDrawerShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAfterCloseAutoFocus?: () => void;
  srLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  contentClassName?: string;
  onContentAnimationEnd?: (open: boolean) => void;
  children: React.ReactNode;
}

export function useResponsiveDrawerRealization({
  open,
  enabled = true,
}: {
  open: boolean;
  enabled?: boolean;
}): { isContentRealized: boolean; realizeContent: () => void } {
  const [isContentRealized, setIsContentRealized] = React.useState(false);
  const realizeContent = React.useCallback(
    () => setIsContentRealized(true),
    [],
  );

  React.useEffect(() => {
    if (!enabled || !open || isContentRealized) {
      return;
    }

    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    firstFrame = window.requestAnimationFrame(() => {
      firstFrame = null;
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = null;
        realizeContent();
      });
    });
    const fallback = window.setTimeout(
      realizeContent,
      RESPONSIVE_DRAWER_REALIZE_FALLBACK_MS,
    );

    return () => {
      if (firstFrame !== null) {
        window.cancelAnimationFrame(firstFrame);
      }
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame);
      }
      window.clearTimeout(fallback);
    };
  }, [enabled, isContentRealized, open, realizeContent]);

  return {
    isContentRealized: enabled && isContentRealized,
    realizeContent,
  };
}

export function ResponsiveDrawerShell({
  open,
  onOpenChange,
  onAfterCloseAutoFocus,
  srLabel,
  labelledBy,
  describedBy,
  contentClassName,
  onContentAnimationEnd,
  children,
}: ResponsiveDrawerShellProps) {
  const { isContentRealized } = useResponsiveDrawerRealization({ open });

  if (!open && !isContentRealized) {
    return null;
  }

  return (
    <PersistentResponsiveDrawerShell
      open={open}
      onOpenChange={onOpenChange}
      onAfterCloseAutoFocus={onAfterCloseAutoFocus}
      srLabel={srLabel}
      labelledBy={labelledBy}
      describedBy={describedBy}
      contentClassName={contentClassName}
      onContentAnimationEnd={onContentAnimationEnd}
    >
      {isContentRealized ? (
        children
      ) : (
        <div
          aria-hidden="true"
          className="min-h-32"
          data-responsive-drawer-placeholder=""
        />
      )}
    </PersistentResponsiveDrawerShell>
  );
}

interface PersistentResponsiveDrawerShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAfterCloseAutoFocus?: () => void;
  srLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  contentClassName?: string;
  motionDurationMs?: number;
  onContentAnimationEnd?: (open: boolean) => void;
  children: React.ReactNode;
}

const PERSISTENT_DRAWER_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const PERSISTENT_DRAWER_CLOSE_RATIO = 0.25;
const PERSISTENT_DRAWER_CLOSE_VELOCITY_PX_PER_SEC = 450;
const PERSISTENT_DRAWER_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type PersistentDrawerStackEntry = {
  panel: () => HTMLElement | null;
  requestClose: () => void;
};

type PersistentDrawerStack = {
  entries: PersistentDrawerStackEntry[];
  handleKeyDown: (event: KeyboardEvent) => void;
};

const persistentDrawerStacks = new WeakMap<Document, PersistentDrawerStack>();

function getDrawerFocusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(PERSISTENT_DRAWER_FOCUSABLE_SELECTOR),
  ).filter(
    (element) => element.closest('[aria-hidden="true"], [inert]') === null,
  );
}

function activeElementIsInAnotherOverlay(
  activeElement: Element | null,
  panel: HTMLElement,
): boolean {
  const overlay = activeElement?.closest<HTMLElement>(
    "[data-bb-portaled-overlay]",
  );
  return overlay !== null && overlay !== undefined && overlay !== panel;
}

function handleDrawerTab(event: KeyboardEvent, panel: HTMLElement): void {
  const activeElement = panel.ownerDocument.activeElement;
  if (
    !panel.contains(activeElement) &&
    activeElementIsInAnotherOverlay(activeElement, panel)
  ) {
    return;
  }

  const focusable = getDrawerFocusableElements(panel);
  event.preventDefault();
  if (focusable.length === 0) {
    panel.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey) {
    if (
      !panel.contains(activeElement) ||
      activeElement === panel ||
      activeElement === first
    ) {
      last?.focus({ preventScroll: true });
      return;
    }
    const index = focusable.indexOf(activeElement as HTMLElement);
    focusable[Math.max(0, index - 1)]?.focus({ preventScroll: true });
    return;
  }

  if (
    !panel.contains(activeElement) ||
    activeElement === panel ||
    activeElement === last
  ) {
    first?.focus({ preventScroll: true });
    return;
  }
  const index = focusable.indexOf(activeElement as HTMLElement);
  focusable[Math.min(focusable.length - 1, index + 1)]?.focus({
    preventScroll: true,
  });
}

function registerOpenDrawer(
  ownerDocument: Document,
  entry: PersistentDrawerStackEntry,
): () => void {
  let stack = persistentDrawerStacks.get(ownerDocument);
  if (stack === undefined) {
    const entries: PersistentDrawerStackEntry[] = [];
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const topEntry = entries[entries.length - 1];
      const panel = topEntry?.panel() ?? null;
      if (topEntry === undefined || panel === null) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        topEntry.requestClose();
      } else if (event.key === "Tab") {
        handleDrawerTab(event, panel);
      }
    };
    stack = { entries, handleKeyDown };
    persistentDrawerStacks.set(ownerDocument, stack);
    ownerDocument.addEventListener("keydown", handleKeyDown);
  }
  stack.entries.push(entry);

  return () => {
    const currentStack = persistentDrawerStacks.get(ownerDocument);
    if (currentStack === undefined) {
      return;
    }
    const index = currentStack.entries.indexOf(entry);
    if (index >= 0) {
      currentStack.entries.splice(index, 1);
    }
    if (currentStack.entries.length === 0) {
      ownerDocument.removeEventListener("keydown", currentStack.handleKeyDown);
      persistentDrawerStacks.delete(ownerDocument);
    }
  };
}

interface UsePersistentOverlayFocusArgs {
  onAfterCloseAutoFocus?: () => void;
  onBeforeCloseAutoFocus?: () => void;
  open: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
  requestClose: () => void;
}

export function usePersistentOverlayFocus({
  onAfterCloseAutoFocus,
  onBeforeCloseAutoFocus,
  open,
  panelRef,
  requestClose,
}: UsePersistentOverlayFocusArgs): void {
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  React.useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const ownerDocument = panel.ownerDocument;
    const previousFocus = ownerDocument.activeElement;
    returnFocusRef.current =
      previousFocus instanceof HTMLElement &&
      previousFocus !== ownerDocument.body
        ? previousFocus
        : null;
    const unregister = registerOpenDrawer(ownerDocument, {
      panel: () => panelRef.current,
      requestClose,
    });
    panel.focus({ preventScroll: true });
    return unregister;
  }, [open, panelRef, requestClose]);

  const previousOpenRef = React.useRef(open);
  React.useLayoutEffect(() => {
    let cancelDeferredFocus: (() => void) | undefined;
    if (previousOpenRef.current && !open) {
      onBeforeCloseAutoFocus?.();
      const returnFocus = returnFocusRef.current;
      if (
        returnFocus?.isConnected &&
        returnFocus.closest('[aria-hidden="true"], [inert]') === null
      ) {
        returnFocus.focus({ preventScroll: true });
        if (returnFocus.ownerDocument.activeElement !== returnFocus) {
          const ownerWindow = returnFocus.ownerDocument.defaultView;
          if (ownerWindow !== null) {
            const frame = ownerWindow.requestAnimationFrame(() => {
              if (
                returnFocus.isConnected &&
                returnFocus.closest('[aria-hidden="true"], [inert]') === null
              ) {
                returnFocus.focus({ preventScroll: true });
              }
              onAfterCloseAutoFocus?.();
            });
            cancelDeferredFocus = () =>
              ownerWindow.cancelAnimationFrame(frame);
          }
        }
      }
      returnFocusRef.current = null;
      if (cancelDeferredFocus === undefined) {
        onAfterCloseAutoFocus?.();
      }
    }
    previousOpenRef.current = open;
    return cancelDeferredFocus;
  }, [onAfterCloseAutoFocus, onBeforeCloseAutoFocus, open]);
}

type PersistentDrawerDrag = {
  pointerId: number;
  startY: number;
  lastY: number;
  lastTimeMs: number;
  velocityY: number;
  height: number;
};

export function PersistentResponsiveDrawerShell({
  open,
  onOpenChange,
  onAfterCloseAutoFocus,
  srLabel,
  labelledBy,
  describedBy,
  contentClassName,
  motionDurationMs = 220,
  onContentAnimationEnd,
  children,
}: PersistentResponsiveDrawerShellProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const backdropRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<PersistentDrawerDrag | null>(null);
  const settledStateRef = React.useRef<boolean | null>(null);
  const labelId = React.useId();
  const portalScopeProps = usePortalScopeProps();
  const transition = `transform ${motionDurationMs}ms ${PERSISTENT_DRAWER_EASING}`;
  const backdropTransition = `opacity ${motionDurationMs}ms ${PERSISTENT_DRAWER_EASING}`;
  const onOpenChangeRef = React.useRef(onOpenChange);
  React.useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);
  const requestClose = React.useCallback(() => {
    blurActiveKeyboardInputWithin(panelRef.current);
    resetDrawerKeyboardStyles(panelRef.current);
    onOpenChangeRef.current(false);
  }, []);
  const prepareCloseAutoFocus = React.useCallback(() => {
    blurActiveKeyboardInputWithin(panelRef.current);
    resetDrawerKeyboardStyles(panelRef.current);
  }, []);

  usePersistentOverlayFocus({
    onAfterCloseAutoFocus,
    onBeforeCloseAutoFocus: prepareCloseAutoFocus,
    open,
    panelRef,
    requestClose,
  });

  const reportSettled = React.useCallback(
    (settledOpen: boolean) => {
      if (settledStateRef.current === settledOpen) {
        return;
      }
      settledStateRef.current = settledOpen;
      onContentAnimationEnd?.(settledOpen);
    },
    [onContentAnimationEnd],
  );

  React.useEffect(() => {
    settledStateRef.current = null;
    const timeout = window.setTimeout(
      () => reportSettled(open),
      motionDurationMs + 50,
    );
    return () => window.clearTimeout(timeout);
  }, [motionDurationMs, open, reportSettled]);

  const setDragPosition = React.useCallback(
    (offsetY: number, height: number, animate: boolean) => {
      const panel = panelRef.current;
      const backdrop = backdropRef.current;
      if (panel === null || backdrop === null) {
        return;
      }
      panel.style.transition = animate ? transition : "none";
      panel.style.transform = `translate3d(0, ${offsetY}px, 0)`;
      backdrop.style.transition = animate ? backdropTransition : "none";
      backdrop.style.opacity = String(
        Math.max(0, Math.min(1, 1 - offsetY / height)),
      );
    },
    [backdropTransition, transition],
  );

  const handleDragStart = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!open || event.button !== 0) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      const nowMs = Date.now();
      const height = Math.max(panelRef.current?.clientHeight ?? 0, 1);
      dragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        lastTimeMs: nowMs,
        velocityY: 0,
        height,
      };
      setDragPosition(0, height, false);
      event.preventDefault();
    },
    [open, setDragPosition],
  );

  const handleDragMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        return;
      }
      const nowMs = Date.now();
      const elapsedMs = nowMs - drag.lastTimeMs;
      if (elapsedMs > 0) {
        drag.velocityY = ((event.clientY - drag.lastY) / elapsedMs) * 1000;
        drag.lastY = event.clientY;
        drag.lastTimeMs = nowMs;
      }
      setDragPosition(
        Math.max(0, event.clientY - drag.startY),
        drag.height,
        false,
      );
      event.preventDefault();
    },
    [setDragPosition],
  );

  const finishDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        return;
      }
      dragRef.current = null;
      const offsetY = Math.max(0, event.clientY - drag.startY);
      const shouldClose =
        !cancelled &&
        (offsetY >= drag.height * PERSISTENT_DRAWER_CLOSE_RATIO ||
          drag.velocityY >= PERSISTENT_DRAWER_CLOSE_VELOCITY_PX_PER_SEC);
      if (shouldClose) {
        setDragPosition(drag.height, drag.height, true);
        requestClose();
      } else {
        setDragPosition(0, drag.height, true);
      }
      event.preventDefault();
    },
    [requestClose, setDragPosition],
  );

  const portalTarget = typeof document === "undefined" ? null : document.body;
  if (portalTarget === null) {
    return null;
  }

  return createPortal(
    <>
      <div
        ref={backdropRef}
        {...portalScopeProps}
        aria-hidden="true"
        data-persistent-drawer-backdrop=""
        data-state={open ? "open" : "closed"}
        className="fixed inset-0 z-50 bg-black/40"
        style={{
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: backdropTransition,
        }}
        onClick={requestClose}
        onTouchMove={(event) => event.preventDefault()}
      />
      <div
        ref={panelRef}
        {...portalScopeProps}
        aria-hidden={!open}
        aria-labelledby={
          labelledBy ?? (srLabel === undefined ? undefined : labelId)
        }
        aria-describedby={describedBy}
        aria-modal={open || undefined}
        data-bb-portaled-overlay=""
        data-persistent-drawer-content=""
        data-state={open ? "open" : "closed"}
        inert={!open}
        role="dialog"
        tabIndex={-1}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 mt-24 flex max-h-[92dvh] flex-col rounded-t-xl border bg-background outline-none",
          contentClassName,
        )}
        style={{
          transform: open ? "translate3d(0, 0, 0)" : "translate3d(0, 100%, 0)",
          transition,
          willChange: open ? "transform" : undefined,
        }}
        onTransitionEnd={(event) => {
          if (
            event.currentTarget === event.target &&
            event.propertyName === "transform"
          ) {
            reportSettled(open);
          }
        }}
      >
        <div
          data-persistent-drawer-handle=""
          className="mx-auto flex h-8 w-16 shrink-0 touch-none cursor-grab items-center justify-center active:cursor-grabbing"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={(event) => finishDrag(event, false)}
          onPointerCancel={(event) => finishDrag(event, true)}
        >
          <div className="h-1 w-10 rounded-full bg-muted-foreground/20" />
        </div>
        {srLabel === undefined ? null : (
          <h2 id={labelId} className="sr-only">
            {srLabel}
          </h2>
        )}
        {children}
      </div>
    </>,
    portalTarget,
  );
}
