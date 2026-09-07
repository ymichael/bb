import * as React from "react";
import { flushSync } from "react-dom";
import { Slot } from "@radix-ui/react-slot";

import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { cn } from "@bb/shared-ui/lib/utils";
import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { Icon } from "@bb/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { setCompactSidebarDrawerShowing } from "./sidebar-mobile-drawer-visibility.js";
import {
  getCompactSecondaryPanelPresentation,
  subscribeCompactSecondaryPanelShelfShowing,
} from "./secondary-panel-shelf-visibility.js";
import { useHorizontalDismissDrag } from "./use-horizontal-dismiss-drag.js";

const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_MOBILE_VIEWPORT_FRACTION = 0.76;
const SIDEBAR_WIDTH_MOBILE = `min(${SIDEBAR_MOBILE_VIEWPORT_FRACTION * 100}vw, 320px)`;
const SIDEBAR_WIDTH_ICON = "3rem";
const SIDEBAR_MOBILE_SWIPE_BROWSER_EDGE_GUARD_PX = 24;
const SIDEBAR_MOBILE_SWIPE_OPEN_EDGE_ZONE_PX = 72;
const SIDEBAR_MOBILE_SWIPE_OPEN_INTENT_PX = 12;
const SIDEBAR_MOBILE_SWIPE_OPEN_RATIO = 0.33;
const SIDEBAR_MOBILE_SWIPE_OPEN_FLING_MIN_RATIO = 0.12;
const SIDEBAR_MOBILE_SWIPE_OPEN_FLING_VELOCITY_PX_PER_SEC = 450;
const SIDEBAR_MOBILE_DRAG_SETTLE_MS = 220;
const SIDEBAR_MOBILE_REALIZE_TIMEOUT_MS = 1000;
const SIDEBAR_MOBILE_DRAG_SETTLE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const SIDEBAR_MOBILE_SHELF_SETTLE_TRANSITION = `translate ${SIDEBAR_MOBILE_DRAG_SETTLE_MS}ms ${SIDEBAR_MOBILE_DRAG_SETTLE_EASING}`;
const SIDEBAR_MOBILE_SHELF_BACKDROP_SETTLE_TRANSITION = `opacity ${SIDEBAR_MOBILE_DRAG_SETTLE_MS}ms ${SIDEBAR_MOBILE_DRAG_SETTLE_EASING}, translate ${SIDEBAR_MOBILE_DRAG_SETTLE_MS}ms ${SIDEBAR_MOBILE_DRAG_SETTLE_EASING}`;
const SIDEBAR_MOBILE_WHEEL_SWIPE_OPEN_DISTANCE_PX = 90;
const SIDEBAR_MOBILE_WHEEL_SWIPE_RESET_MS = 250;
const SIDEBAR_MOBILE_SHELF_INSET_TRANSITION_CLASS =
  "max-md:[transition:translate_220ms_cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none!";
const SIDEBAR_MOBILE_BACKDROP_TRANSITION_CLASS =
  "[transition:opacity_220ms_cubic-bezier(0.32,0.72,0,1),translate_220ms_cubic-bezier(0.32,0.72,0,1)]";
const SIDEBAR_GROUP_LABEL_BASE_CLASS =
  "duration-200 flex shrink-0 items-center rounded-md px-1 text-xs font-medium text-sidebar-foreground/75 outline-none ring-sidebar-ring transition-[margin,opa] ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0";
const SIDEBAR_GROUP_LABEL_COLLAPSED_CLASS =
  "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0";

type SidebarMobileWidthStyle = React.CSSProperties & {
  "--sidebar-width-mobile": string;
};

type SidebarInsetSwipeSession = {
  kind: "pointer" | "touch";
  id: number;
  startX: number;
  startY: number;
  panelWidth: number;
  lastProgress: number;
  lastClientX: number;
  lastTimeMs: number;
  velocityX: number;
  isDragging: boolean;
  selectionRoot: Element | null;
  startTarget: Element | null;
  canPreventDefault: boolean;
};

const sidebarMobileWidthStyle: SidebarMobileWidthStyle = {
  "--sidebar-width-mobile": SIDEBAR_WIDTH_MOBILE,
};

function getSidebarMobilePanelWidth(): number {
  if (typeof window === "undefined") {
    return 320;
  }

  return Math.min(window.innerWidth * SIDEBAR_MOBILE_VIEWPORT_FRACTION, 320);
}

function clampSidebarMobileSwipeProgress(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function getSidebarMobileMotionNodes(): {
  panel: HTMLElement | null;
  backdrop: HTMLElement | null;
  inset: HTMLElement | null;
} {
  if (typeof document === "undefined") {
    return { panel: null, backdrop: null, inset: null };
  }

  const panel = document.querySelector(
    '[data-sidebar="panel"][data-vaul-drawer-direction]',
  );
  const backdrop = document.querySelector("[data-sidebar-mobile-backdrop]");
  const inset = document.querySelector('[data-sidebar="inset"]');

  return {
    panel: panel instanceof HTMLElement ? panel : null,
    backdrop: backdrop instanceof HTMLElement ? backdrop : null,
    inset: inset instanceof HTMLElement ? inset : null,
  };
}

function applySidebarMobileDragStyles({
  progress,
  settling,
}: {
  progress: number;
  settling: boolean;
}) {
  const { panel, backdrop, inset } = getSidebarMobileMotionNodes();
  const translate = `${getSidebarMobilePanelWidth() * progress}px`;

  panel?.setAttribute("data-vaul-animate", "false");

  if (inset !== null) {
    inset.setAttribute("data-vaul-animate", "false");
    inset.style.translate = translate;
    inset.style.transition = settling
      ? SIDEBAR_MOBILE_SHELF_SETTLE_TRANSITION
      : "none";
  }

  if (backdrop !== null) {
    backdrop.setAttribute("data-vaul-animate", "false");
    backdrop.style.translate = translate;
    backdrop.style.opacity = String(progress);
    backdrop.style.transition = settling
      ? SIDEBAR_MOBILE_SHELF_BACKDROP_SETTLE_TRANSITION
      : "none";
    backdrop.style.pointerEvents = progress > 0 ? "auto" : "";
  }
}

function clearSidebarMobileDragAttributes() {
  const { panel, backdrop, inset } = getSidebarMobileMotionNodes();
  panel?.removeAttribute("data-vaul-animate");
  backdrop?.removeAttribute("data-vaul-animate");
  inset?.removeAttribute("data-vaul-animate");
}

function clearSidebarMobileDragStyles() {
  const { panel, backdrop, inset } = getSidebarMobileMotionNodes();

  panel?.removeAttribute("data-vaul-animate");

  if (inset !== null) {
    inset.removeAttribute("data-vaul-animate");
    inset.style.translate = "";
    inset.style.transition = "";
  }

  if (backdrop !== null) {
    backdrop.removeAttribute("data-vaul-animate");
    backdrop.style.translate = "";
    backdrop.style.opacity = "";
    backdrop.style.transition = "";
    backdrop.style.pointerEvents = "";
  }
}

function createSidebarInsetSwipeSession({
  kind,
  id,
  startX,
  startY,
  selectionRoot,
  startTarget,
  canPreventDefault,
}: {
  kind: "pointer" | "touch";
  id: number;
  startX: number;
  startY: number;
  selectionRoot: Element | null;
  startTarget: Element | null;
  canPreventDefault: boolean;
}): SidebarInsetSwipeSession {
  const nowMs = Date.now();
  return {
    kind,
    id,
    startX,
    startY,
    panelWidth: getSidebarMobilePanelWidth(),
    lastProgress: 0,
    lastClientX: startX,
    lastTimeMs: nowMs,
    velocityX: 0,
    isDragging: false,
    selectionRoot,
    startTarget,
    canPreventDefault,
  };
}

function isSidebarSwipeEdgeZoneTouch(clientX: number): boolean {
  return (
    clientX >= SIDEBAR_MOBILE_SWIPE_BROWSER_EDGE_GUARD_PX &&
    clientX < SIDEBAR_MOBILE_SWIPE_OPEN_EDGE_ZONE_PX
  );
}

function shouldOpenSidebarMobileSwipe(
  session: SidebarInsetSwipeSession,
): boolean {
  return (
    session.lastProgress >= SIDEBAR_MOBILE_SWIPE_OPEN_RATIO ||
    (session.lastProgress >= SIDEBAR_MOBILE_SWIPE_OPEN_FLING_MIN_RATIO &&
      session.velocityX >= SIDEBAR_MOBILE_SWIPE_OPEN_FLING_VELOCITY_PX_PER_SEC)
  );
}

function isHorizontallyScrollableElement(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null || !(element instanceof view.HTMLElement)) {
    return false;
  }

  const overflowX = view.getComputedStyle(element).overflowX;
  if (
    overflowX !== "auto" &&
    overflowX !== "scroll" &&
    overflowX !== "overlay"
  ) {
    return false;
  }

  return element.scrollWidth > element.clientWidth + 1;
}

function isInsideHorizontalScrollRegion(target: Element): boolean {
  let element: Element | null = target;
  while (element !== null) {
    if (isHorizontallyScrollableElement(element)) {
      return true;
    }
    if (
      element.matches('[data-sidebar="inset"], [data-sidebar-mobile-backdrop]')
    ) {
      return false;
    }
    element = element.parentElement;
  }

  return false;
}

function getSidebarSwipeSelectionRoot(
  target: EventTarget | null,
): Element | null {
  return target instanceof Element
    ? target.closest("[data-sidebar-swipe-selectable]")
    : null;
}

function hasExpandedTextSelectionWithin(root: Element): boolean {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.isCollapsed) {
    return false;
  }

  return (
    (selection.anchorNode !== null && root.contains(selection.anchorNode)) ||
    (selection.focusNode !== null && root.contains(selection.focusNode))
  );
}

function shouldIgnoreSidebarSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  if (
    target.closest(
      [
        "input",
        "textarea",
        "select",
        '[contenteditable="true"]',
        '[role="slider"]',
        '[data-sidebar="panel"]',
        '[data-sidebar="trigger"]',
        "[data-vaul-drawer]",
        "[data-vaul-no-drag]",
        "[data-no-sidebar-swipe]",
      ].join(", "),
    ) !== null
  ) {
    return true;
  }

  const selectionRoot = getSidebarSwipeSelectionRoot(target);
  return (
    selectionRoot !== null && hasExpandedTextSelectionWithin(selectionRoot)
  );
}

function isSidebarInsetSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const ownerDocument = target.ownerDocument;
  const isDocumentRootTarget =
    target === ownerDocument.body || target === ownerDocument.documentElement;
  if (
    isDocumentRootTarget &&
    ownerDocument.querySelector(
      '[data-sidebar="panel"][data-state="closed"]',
    ) !== null
  ) {
    return true;
  }

  return (
    target.closest(
      '[data-sidebar="inset"], [data-sidebar-mobile-backdrop][data-state="closed"]',
    ) !== null
  );
}

function getTouchByIdentifier(
  touches: TouchList,
  identifier: number,
): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch?.identifier === identifier) {
      return touch;
    }
  }
  return null;
}

function getTrackedSwipeTouch(
  event: TouchEvent,
  identifier: number,
): Touch | null {
  return (
    getTouchByIdentifier(event.touches, identifier) ??
    getTouchByIdentifier(event.changedTouches, identifier)
  );
}

function scheduleSidebarMobileRealization(realize: () => void): () => void {
  let settled = false;
  let idleHandle: number | null = null;
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  const cancel = () => {
    if (idleHandle !== null) {
      window.cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
    if (firstFrame !== null) {
      window.cancelAnimationFrame(firstFrame);
      firstFrame = null;
    }
    if (secondFrame !== null) {
      window.cancelAnimationFrame(secondFrame);
      secondFrame = null;
    }
    window.clearTimeout(timeout);
  };
  const run = () => {
    if (settled) {
      return;
    }
    settled = true;
    cancel();
    realize();
  };
  const timeout = window.setTimeout(run, SIDEBAR_MOBILE_REALIZE_TIMEOUT_MS);
  if (typeof window.requestIdleCallback === "function") {
    idleHandle = window.requestIdleCallback(
      () => {
        idleHandle = null;
        run();
      },
      { timeout: SIDEBAR_MOBILE_REALIZE_TIMEOUT_MS },
    );
  } else {
    firstFrame = window.requestAnimationFrame(() => {
      firstFrame = null;
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = null;
        run();
      });
    });
  }
  return () => {
    settled = true;
    cancel();
  };
}

type SidebarContext = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
  isMobileSidebarClosing: boolean;
  isMobileSidebarRealized: boolean;
  suppressMobileOpenAnimation: boolean;
  setSuppressMobileOpenAnimation: (suppress: boolean) => void;
  suppressMobileCloseAnimation: boolean;
  setSuppressMobileCloseAnimation: (suppress: boolean) => void;
  isCompactViewport: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContext | null>(null);

const SidebarWidthContext = React.createContext<string>(SIDEBAR_WIDTH);

const SidebarShowingContext = React.createContext<boolean | null>(null);

const SidebarContentElementContext =
  React.createContext<React.RefObject<HTMLDivElement | null> | null>(null);

function useSidebarContentElementRef() {
  return React.useContext(SidebarContentElementContext);
}

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

function useIsSidebarShowing(): boolean {
  const isShowing = React.useContext(SidebarShowingContext);
  if (isShowing === null) {
    throw new Error(
      "useIsSidebarShowing must be used within a SidebarProvider.",
    );
  }
  return isShowing;
}

function useOptionalIsSidebarShowing(): boolean | null {
  return React.useContext(SidebarShowingContext);
}

function useCloseMobileSidebar() {
  const { closeMobileSidebar } = useSidebar();
  return closeMobileSidebar;
}

const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    width?: string;
  }
>(
  (
    {
      defaultOpen = true,
      open: openProp,
      onOpenChange: setOpenProp,
      width = SIDEBAR_WIDTH,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const isCompactViewport = useIsCompactViewport();
    const [openMobile, setOpenMobile] = React.useState(false);
    const [suppressMobileOpenAnimation, setSuppressMobileOpenAnimation] =
      React.useState(false);
    const [suppressMobileCloseAnimation, setSuppressMobileCloseAnimation] =
      React.useState(false);
    const [isMobileSidebarClosing, setIsMobileSidebarClosing] =
      React.useState(false);
    const [hasRealizedMobileSidebar, setHasRealizedMobileSidebar] =
      React.useState(false);
    const realizeMobileSidebar = React.useCallback(() => {
      setHasRealizedMobileSidebar(true);
    }, []);
    const mobileSettleTimeoutRef = React.useRef<number | null>(null);

    const clearMobileSettleTimeout = React.useCallback(() => {
      if (mobileSettleTimeoutRef.current !== null) {
        window.clearTimeout(mobileSettleTimeoutRef.current);
        mobileSettleTimeoutRef.current = null;
      }
    }, []);

    const openMobileRef = React.useRef(openMobile);
    React.useEffect(() => {
      openMobileRef.current = openMobile;
    }, [openMobile]);

    React.useEffect(() => {
      setCompactSidebarDrawerShowing(isCompactViewport && openMobile);
      return () => {
        setCompactSidebarDrawerShowing(false);
      };
    }, [isCompactViewport, openMobile]);

    const closeMobileSidebar = React.useCallback(() => {
      if (!openMobileRef.current || mobileSettleTimeoutRef.current !== null) {
        return;
      }

      setIsMobileSidebarClosing(true);
      applySidebarMobileDragStyles({ progress: 0, settling: true });
      mobileSettleTimeoutRef.current = window.setTimeout(() => {
        mobileSettleTimeoutRef.current = null;
        flushSync(() => {
          setSuppressMobileOpenAnimation(false);
          setSuppressMobileCloseAnimation(true);
          setIsMobileSidebarClosing(false);
          setOpenMobile(false);
        });
        clearSidebarMobileDragAttributes();
      }, SIDEBAR_MOBILE_DRAG_SETTLE_MS);
    }, []);

    const openMobileSidebar = React.useCallback(() => {
      if (openMobileRef.current || mobileSettleTimeoutRef.current !== null) {
        return;
      }

      React.startTransition(() => {
        realizeMobileSidebar();
      });
      applySidebarMobileDragStyles({ progress: 1, settling: true });
      mobileSettleTimeoutRef.current = window.setTimeout(() => {
        mobileSettleTimeoutRef.current = null;
        flushSync(() => {
          setSuppressMobileOpenAnimation(true);
          setSuppressMobileCloseAnimation(false);
          setOpenMobile(true);
        });
        clearSidebarMobileDragAttributes();
      }, SIDEBAR_MOBILE_DRAG_SETTLE_MS);
    }, [realizeMobileSidebar]);

    React.useEffect(
      () => () => {
        clearMobileSettleTimeout();
      },
      [clearMobileSettleTimeout],
    );

    if (isCompactViewport && openMobile && !hasRealizedMobileSidebar) {
      setHasRealizedMobileSidebar(true);
    }
    const isMobileSidebarRealized =
      isCompactViewport && hasRealizedMobileSidebar;
    React.useEffect(() => {
      if (!isCompactViewport || hasRealizedMobileSidebar) {
        return;
      }
      return scheduleSidebarMobileRealization(realizeMobileSidebar);
    }, [hasRealizedMobileSidebar, isCompactViewport, realizeMobileSidebar]);

    React.useEffect(() => {
      if (openMobile) {
        setSuppressMobileCloseAnimation(false);
      } else {
        setSuppressMobileOpenAnimation(false);
      }
    }, [openMobile]);

    const [_open, _setOpen] = React.useState(defaultOpen);
    const open = openProp ?? _open;
    const setOpen = React.useCallback(
      (value: boolean | ((value: boolean) => boolean)) => {
        const openState = typeof value === "function" ? value(open) : value;
        if (setOpenProp) {
          setOpenProp(openState);
        } else {
          _setOpen(openState);
        }
      },
      [setOpenProp, open],
    );

    const toggleSidebar = React.useCallback(() => {
      if (!isCompactViewport) {
        setOpen((open) => !open);
        return;
      }
      if (openMobile) {
        closeMobileSidebar();
        return;
      }
      openMobileSidebar();
    }, [
      closeMobileSidebar,
      isCompactViewport,
      openMobile,
      openMobileSidebar,
      setOpen,
    ]);

    const state = open ? "expanded" : "collapsed";

    const contextValue = React.useMemo<SidebarContext>(
      () => ({
        state,
        open,
        setOpen,
        isCompactViewport,
        openMobile,
        setOpenMobile,
        openMobileSidebar,
        closeMobileSidebar,
        isMobileSidebarClosing,
        isMobileSidebarRealized,
        suppressMobileOpenAnimation,
        setSuppressMobileOpenAnimation,
        suppressMobileCloseAnimation,
        setSuppressMobileCloseAnimation,
        toggleSidebar,
      }),
      [
        state,
        open,
        setOpen,
        isCompactViewport,
        openMobile,
        setOpenMobile,
        openMobileSidebar,
        closeMobileSidebar,
        isMobileSidebarClosing,
        isMobileSidebarRealized,
        suppressMobileOpenAnimation,
        setSuppressMobileOpenAnimation,
        suppressMobileCloseAnimation,
        setSuppressMobileCloseAnimation,
        toggleSidebar,
      ],
    );

    const isSidebarShowing = isCompactViewport ? openMobile : open;

    return (
      <SidebarContext.Provider value={contextValue}>
        <SidebarShowingContext.Provider value={isSidebarShowing}>
          <SidebarWidthContext.Provider value={width}>
            {}
            <TooltipProvider delayDuration={300} disableHoverableContent>
              <div
                style={
                  {
                    "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
                    ...sidebarMobileWidthStyle,
                    ...style,
                  } as React.CSSProperties
                }
                className={cn(
                  "group/sidebar-wrapper flex h-full min-h-0 w-full has-[[data-variant=inset]]:bg-sidebar max-md:overflow-clip",
                  className,
                )}
                ref={ref}
                {...props}
              >
                {children}
              </div>
            </TooltipProvider>
          </SidebarWidthContext.Provider>
        </SidebarShowingContext.Provider>
      </SidebarContext.Provider>
    );
  },
);
SidebarProvider.displayName = "SidebarProvider";

const Sidebar = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, style, children, ...props }, ref) => {
    const {
      isCompactViewport,
      state,
      openMobile,
      setOpenMobile,
      closeMobileSidebar,
      isMobileSidebarRealized,
      suppressMobileOpenAnimation,
      setSuppressMobileOpenAnimation,
      suppressMobileCloseAnimation,
      setSuppressMobileCloseAnimation,
    } = useSidebar();
    const width = React.useContext(SidebarWidthContext);
    const widthStyle = { "--sidebar-width": width } as React.CSSProperties;
    const handleOpenMobileChange = React.useCallback(
      (nextOpen: boolean) => {
        if (nextOpen) {
          setSuppressMobileCloseAnimation(false);
        } else {
          setSuppressMobileOpenAnimation(false);
        }
        setOpenMobile(nextOpen);
      },
      [
        setOpenMobile,
        setSuppressMobileCloseAnimation,
        setSuppressMobileOpenAnimation,
      ],
    );
    const shouldSuppressMobileCloseAnimation =
      !openMobile && suppressMobileCloseAnimation;
    const mobileBackdropStyle = React.useMemo<
      React.CSSProperties | undefined
    >(() => {
      if (shouldSuppressMobileCloseAnimation) {
        return {
          opacity: 0,
          translate: "0px",
          pointerEvents: "none",
          transition: "none",
        };
      }

      return undefined;
    }, [shouldSuppressMobileCloseAnimation]);

    if (isCompactViewport) {
      return (
        <SidebarMobilePanel
          ref={ref}
          open={openMobile}
          onOpenChange={handleOpenMobileChange}
          onDismiss={closeMobileSidebar}
          suppressOpenAnimation={suppressMobileOpenAnimation}
          backdropStyle={mobileBackdropStyle}
          className={className}
          style={style}
          {...props}
        >
          {isMobileSidebarRealized ? children : null}
        </SidebarMobilePanel>
      );
    }

    return (
      <div
        ref={ref}
        className="group peer text-sidebar-foreground"
        data-state={state}
        data-collapsible={state === "collapsed" ? "offcanvas" : ""}
        data-variant="sidebar"
        data-side="left"
      >
        {}
        <div
          data-sidebar="gap"
          style={widthStyle}
          className={cn(
            "relative hidden h-full w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear md:block",
            "group-data-[collapsible=offcanvas]:w-0",
            "group-data-[side=right]:rotate-180",
            "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
          )}
        />
        <div
          data-sidebar="panel"
          className={cn(
            "fixed inset-y-0 z-10 flex h-(--bb-shell-height) w-(--sidebar-width) select-none flex-col bg-sidebar text-sidebar-foreground [transition:left_200ms_linear,right_200ms_linear,width_200ms_linear,visibility_0s_linear_0s]",
            "group-data-[collapsible=offcanvas]:invisible group-data-[collapsible=offcanvas]:[transition:left_200ms_linear,right_200ms_linear,width_200ms_linear,visibility_0s_linear_200ms]",
            "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]",
            "group-data-[collapsible=icon]:w-(--sidebar-width-icon) border-border-seam group-data-[side=left]:border-r group-data-[side=right]:border-l",
            className,
          )}
          style={{ ...widthStyle, ...style }}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className="flex h-full w-full flex-col bg-sidebar pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow"
          >
            {children}
          </div>
        </div>
      </div>
    );
  },
);
Sidebar.displayName = "Sidebar";

interface SidebarMobilePanelProps extends React.ComponentProps<"div"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: () => void;
  suppressOpenAnimation: boolean;
  backdropStyle?: React.CSSProperties;
}

const SIDEBAR_MOBILE_TAB_STOP_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function getSidebarMobileTabStops(panel: HTMLElement): HTMLElement[] {
  const doc = panel.ownerDocument;
  const triggerStops = Array.from(
    doc.querySelectorAll('[data-sidebar="trigger"]'),
  ).filter((element) => !panel.contains(element));
  const panelStops = Array.from(
    panel.querySelectorAll(SIDEBAR_MOBILE_TAB_STOP_SELECTOR),
  );
  return [...triggerStops, ...panelStops].filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement &&
      !element.matches(":disabled") &&
      !element.hasAttribute("hidden") &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.closest("[inert]") === null,
  );
}

const SidebarMobilePanel = React.forwardRef<
  HTMLDivElement,
  SidebarMobilePanelProps
>(
  (
    {
      open,
      onOpenChange,
      onDismiss,
      suppressOpenAnimation,
      backdropStyle,
      className,
      style,
      children,
      onPointerDown,
      onTouchStart,
      ...props
    },
    ref,
  ) => {
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const backdropRef = React.useRef<HTMLDivElement | null>(null);
    const setPanelRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        panelRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref],
    );

    React.useEffect(() => {
      if (!open) {
        return;
      }

      const previouslyFocused =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const shouldMoveFocus =
        previouslyFocused?.matches('[data-sidebar="trigger"]:focus-visible') ??
        false;
      if (shouldMoveFocus) {
        panelRef.current?.focus({ preventScroll: true });
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented) {
          return;
        }
        if (event.key === "Escape") {
          onDismiss();
          return;
        }
        if (event.key !== "Tab") {
          return;
        }
        const panel = panelRef.current;
        const shell = panel?.parentElement ?? null;
        if (panel === null || shell === null) {
          return;
        }
        const doc = panel.ownerDocument;
        const active = doc.activeElement;
        if (active !== null && active !== doc.body && !shell.contains(active)) {
          return;
        }
        const stops = getSidebarMobileTabStops(panel);
        if (stops.length === 0) {
          return;
        }
        event.preventDefault();
        const direction = event.shiftKey ? -1 : 1;
        const activeIndex =
          active instanceof HTMLElement ? stops.indexOf(active) : -1;
        for (let step = 1; step <= stops.length; step += 1) {
          const nextIndex =
            activeIndex === -1
              ? event.shiftKey
                ? stops.length - step
                : step - 1
              : (((activeIndex + direction * step) % stops.length) +
                  stops.length) %
                stops.length;
          const candidate = stops[nextIndex];
          candidate?.focus({ preventScroll: true });
          if (doc.activeElement === candidate) {
            return;
          }
        }
      };
      window.addEventListener("keydown", handleKeyDown);

      return () => {
        window.removeEventListener("keydown", handleKeyDown);
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          panelRef.current?.contains(active)
        ) {
          active.blur();
          if (shouldMoveFocus) {
            previouslyFocused?.focus({ preventScroll: true });
          }
        }
      };
    }, [open, onDismiss]);

    const { beginPointerDrag, beginTouchDrag } = useHorizontalDismissDrag({
      direction: "left",
      dismissTiming: "settled",
      enabled: open,
      getWidth: getSidebarMobilePanelWidth,
      onClear: clearSidebarMobileDragStyles,
      onDismiss: () => onOpenChange(false),
      onProgress: ({ progress, settling }) => {
        applySidebarMobileDragStyles({ progress, settling });
      },
      resetKey: open ? "open" : "closed",
      suppressClick: true,
    });

    const beginPanelPointerDrag = (
      event: React.PointerEvent<HTMLDivElement>,
    ) => {
      onPointerDown?.(event);
      beginPointerDrag(event);
    };

    const beginPanelTouchDrag = (event: React.TouchEvent<HTMLDivElement>) => {
      onTouchStart?.(event);
      beginTouchDrag(event);
    };

    const suppressedOpenTransitionStyle =
      open && suppressOpenAnimation
        ? ({ transition: "none" } satisfies React.CSSProperties)
        : undefined;

    return (
      <>
        <div
          ref={backdropRef}
          data-sidebar-mobile-backdrop=""
          data-testid="sidebar-mobile-backdrop"
          data-state={open ? "open" : "closed"}
          className={cn(
            "fixed inset-0 z-40 bg-transparent will-change-[opacity,translate]",
            "data-[state=open]:translate-x-(--sidebar-width-mobile)",
            SIDEBAR_MOBILE_BACKDROP_TRANSITION_CLASS,
            "data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0",
          )}
          style={{ ...suppressedOpenTransitionStyle, ...backdropStyle }}
          onClick={onDismiss}
          onPointerDown={beginPointerDrag}
          onTouchStart={beginTouchDrag}
        />
        <div
          ref={setPanelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Sidebar"
          tabIndex={-1}
          inert={!open}
          data-sidebar="panel"
          data-sidebar-state={open ? "expanded" : "collapsed"}
          data-state={open ? "open" : "closed"}
          data-collapsible=""
          data-variant="sidebar"
          data-side="left"
          data-vaul-drawer-direction="left"
          className={cn(
            "group fixed inset-y-0 left-0 z-0 flex h-(--bb-shell-height) w-(--sidebar-width-mobile) touch-pan-y select-none flex-col bg-sidebar text-sidebar-foreground outline-none",
            "border-border-seam data-[side=left]:border-r data-[side=right]:border-l",
            className,
          )}
          style={
            {
              ...sidebarMobileWidthStyle,
              ...style,
            } as SidebarMobileWidthStyle
          }
          onPointerDown={beginPanelPointerDrag}
          onTouchStart={beginPanelTouchDrag}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className="flex h-full w-full flex-col bg-sidebar pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow"
          >
            {children}
          </div>
        </div>
      </>
    );
  },
);
SidebarMobilePanel.displayName = "SidebarMobilePanel";

const SidebarTrigger = React.forwardRef<
  React.ComponentRef<typeof Button>,
  React.ComponentProps<typeof Button>
>(({ className, onClick, "aria-expanded": ariaExpanded, ...props }, ref) => {
  const { isCompactViewport, open, openMobile, toggleSidebar } = useSidebar();

  return (
    <Button
      ref={ref}
      data-sidebar="trigger"
      variant="ghost"
      size="icon"
      className={cn(
        COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
        "select-none",
        className,
      )}
      aria-expanded={ariaExpanded ?? (isCompactViewport ? openMobile : open)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <Icon name="PanelLeft" />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
});
SidebarTrigger.displayName = "SidebarTrigger";

const SidebarInset = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"main">
>(({ className, ...props }, ref) => {
  const {
    isCompactViewport,
    openMobile,
    setOpenMobile,
    openMobileSidebar,
    suppressMobileOpenAnimation,
    setSuppressMobileOpenAnimation,
    setSuppressMobileCloseAnimation,
  } = useSidebar();
  const swipeSessionRef = React.useRef<SidebarInsetSwipeSession | null>(null);
  const removeSwipeListenersRef = React.useRef<(() => void) | null>(null);
  const removeSwipeClickSuppressorRef = React.useRef<(() => void) | null>(null);
  const swipeClickSuppressorTimeoutRef = React.useRef<number | null>(null);
  const wheelSwipeDeltaRef = React.useRef(0);
  const wheelSwipeResetTimeoutRef = React.useRef<number | null>(null);
  const mobileDragSettleTimeoutRef = React.useRef<number | null>(null);

  const clearSwipeSession = React.useCallback(() => {
    removeSwipeListenersRef.current?.();
    removeSwipeListenersRef.current = null;
    swipeSessionRef.current = null;
  }, []);

  const clearMobileDragSettleTimeout = React.useCallback(() => {
    if (mobileDragSettleTimeoutRef.current !== null) {
      window.clearTimeout(mobileDragSettleTimeoutRef.current);
      mobileDragSettleTimeoutRef.current = null;
    }
  }, []);

  const clearWheelSwipe = React.useCallback(() => {
    wheelSwipeDeltaRef.current = 0;
    if (wheelSwipeResetTimeoutRef.current !== null) {
      window.clearTimeout(wheelSwipeResetTimeoutRef.current);
      wheelSwipeResetTimeoutRef.current = null;
    }
  }, []);

  const suppressNextSwipeClick = React.useCallback(() => {
    removeSwipeClickSuppressorRef.current?.();
    if (swipeClickSuppressorTimeoutRef.current !== null) {
      window.clearTimeout(swipeClickSuppressorTimeoutRef.current);
      swipeClickSuppressorTimeoutRef.current = null;
    }

    const suppressClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      removeSwipeClickSuppressorRef.current?.();
    };
    const removeSuppressor = () => {
      window.removeEventListener("click", suppressClick, {
        capture: true,
      });
      removeSwipeClickSuppressorRef.current = null;
      if (swipeClickSuppressorTimeoutRef.current !== null) {
        window.clearTimeout(swipeClickSuppressorTimeoutRef.current);
        swipeClickSuppressorTimeoutRef.current = null;
      }
    };

    window.addEventListener("click", suppressClick, {
      capture: true,
      once: true,
    });
    removeSwipeClickSuppressorRef.current = removeSuppressor;
    swipeClickSuppressorTimeoutRef.current = window.setTimeout(
      removeSuppressor,
      400,
    );
  }, []);

  const settleMobileSwipe = React.useCallback(
    (open: boolean) => {
      clearMobileDragSettleTimeout();
      applySidebarMobileDragStyles({
        progress: open ? 1 : 0,
        settling: true,
      });
      mobileDragSettleTimeoutRef.current = window.setTimeout(() => {
        mobileDragSettleTimeoutRef.current = null;
        if (open) {
          setSuppressMobileOpenAnimation(true);
          clearSidebarMobileDragStyles();
        } else {
          flushSync(() => {
            setSuppressMobileCloseAnimation(true);
            setOpenMobile(false);
          });
          clearSidebarMobileDragAttributes();
        }
      }, SIDEBAR_MOBILE_DRAG_SETTLE_MS);
    },
    [
      clearMobileDragSettleTimeout,
      setOpenMobile,
      setSuppressMobileCloseAnimation,
      setSuppressMobileOpenAnimation,
    ],
  );

  const continueSwipe = React.useCallback(
    (clientX: number, clientY: number, event: PointerEvent | TouchEvent) => {
      const session = swipeSessionRef.current;
      if (session === null) {
        return;
      }

      const deltaX = clientX - session.startX;
      const deltaY = clientY - session.startY;
      const absDeltaX = Math.abs(deltaX);
      const absDeltaY = Math.abs(deltaY);
      const nowMs = Date.now();

      if (
        !session.isDragging &&
        absDeltaY > SIDEBAR_MOBILE_SWIPE_OPEN_INTENT_PX &&
        absDeltaY > absDeltaX * 1.15
      ) {
        clearSidebarMobileDragStyles();
        clearSwipeSession();
        return;
      }

      const progress = clampSidebarMobileSwipeProgress(
        deltaX / session.panelWidth,
      );

      if (!session.isDragging) {
        if (
          deltaX < SIDEBAR_MOBILE_SWIPE_OPEN_INTENT_PX ||
          absDeltaX <= absDeltaY * 1.25
        ) {
          return;
        }

        if (
          session.startTarget !== null &&
          (!session.startTarget.isConnected ||
            isInsideHorizontalScrollRegion(session.startTarget))
        ) {
          clearSidebarMobileDragStyles();
          clearSwipeSession();
          return;
        }

        session.isDragging = true;
        clearMobileDragSettleTimeout();
        flushSync(() => {
          setSuppressMobileOpenAnimation(true);
          setSuppressMobileCloseAnimation(false);
          setOpenMobile(true);
        });
      }

      if (session.canPreventDefault && event.cancelable) {
        event.preventDefault();
      }

      const elapsedMs = nowMs - session.lastTimeMs;
      if (elapsedMs > 0) {
        session.velocityX =
          ((clientX - session.lastClientX) / elapsedMs) * 1000;
        session.lastClientX = clientX;
        session.lastTimeMs = nowMs;
      }
      session.lastProgress = progress;
      applySidebarMobileDragStyles({ progress, settling: false });
    },
    [
      clearMobileDragSettleTimeout,
      clearSwipeSession,
      setOpenMobile,
      setSuppressMobileCloseAnimation,
      setSuppressMobileOpenAnimation,
    ],
  );

  const handleSwipeMove = React.useCallback(
    (event: PointerEvent) => {
      const session = swipeSessionRef.current;
      if (
        session === null ||
        session.kind !== "pointer" ||
        event.pointerId !== session.id
      ) {
        return;
      }

      continueSwipe(event.clientX, event.clientY, event);
    },
    [continueSwipe],
  );

  const finishMobileSwipe = React.useCallback(
    (event: PointerEvent | TouchEvent) => {
      const session = swipeSessionRef.current;
      if (session === null) {
        return;
      }

      clearSwipeSession();
      if (!session.isDragging) {
        clearSidebarMobileDragStyles();
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }

      suppressNextSwipeClick();
      settleMobileSwipe(shouldOpenSidebarMobileSwipe(session));
    },
    [clearSwipeSession, settleMobileSwipe, suppressNextSwipeClick],
  );

  const handleSwipeEnd = React.useCallback(
    (event: PointerEvent) => {
      const session = swipeSessionRef.current;
      if (
        session === null ||
        session.kind !== "pointer" ||
        event.pointerId !== session.id
      ) {
        return;
      }

      finishMobileSwipe(event);
    },
    [finishMobileSwipe],
  );

  const handleTouchMove = React.useCallback(
    (event: TouchEvent) => {
      const session = swipeSessionRef.current;
      if (session === null || session.kind !== "touch") {
        return;
      }

      const touch = getTrackedSwipeTouch(event, session.id);
      if (touch == null) {
        return;
      }

      continueSwipe(touch.clientX, touch.clientY, event);
    },
    [continueSwipe],
  );

  const handleTouchEnd = React.useCallback(
    (event: TouchEvent) => {
      const session = swipeSessionRef.current;
      if (session === null || session.kind !== "touch") {
        return;
      }

      if (getTrackedSwipeTouch(event, session.id) === null) {
        return;
      }

      finishMobileSwipe(event);
    },
    [finishMobileSwipe],
  );

  const startTouchSwipe = React.useCallback(
    (event: TouchEvent) => {
      if (
        event.defaultPrevented ||
        !isCompactViewport ||
        openMobile ||
        event.touches.length !== 1 ||
        !isSidebarInsetSwipeTarget(event.target) ||
        shouldIgnoreSidebarSwipeTarget(event.target)
      ) {
        return;
      }

      const touch = event.touches.item(0);
      if (
        touch == null ||
        touch.clientX < SIDEBAR_MOBILE_SWIPE_BROWSER_EDGE_GUARD_PX
      ) {
        return;
      }

      const currentSession = swipeSessionRef.current;
      if (currentSession !== null) {
        if (currentSession.kind !== "pointer") {
          return;
        }
        clearSwipeSession();
      }

      const canPreventDefault = isSidebarSwipeEdgeZoneTouch(touch.clientX);
      swipeSessionRef.current = createSidebarInsetSwipeSession({
        kind: "touch",
        id: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        selectionRoot: getSidebarSwipeSelectionRoot(event.target),
        startTarget: event.target instanceof Element ? event.target : null,
        canPreventDefault,
      });

      const removeListeners = () => {
        window.removeEventListener("touchmove", handleTouchMove);
        window.removeEventListener("touchend", handleTouchEnd);
        window.removeEventListener("touchcancel", handleTouchEnd);
      };
      window.addEventListener("touchmove", handleTouchMove, {
        passive: !canPreventDefault,
      });
      window.addEventListener("touchend", handleTouchEnd);
      window.addEventListener("touchcancel", handleTouchEnd);
      removeSwipeListenersRef.current = removeListeners;
    },
    [
      clearSwipeSession,
      handleTouchEnd,
      handleTouchMove,
      isCompactViewport,
      openMobile,
    ],
  );

  const startPointerSwipe = React.useCallback(
    (event: PointerEvent) => {
      if (
        event.defaultPrevented ||
        !isCompactViewport ||
        openMobile ||
        event.pointerType !== "touch" ||
        event.button !== 0 ||
        event.clientX < SIDEBAR_MOBILE_SWIPE_BROWSER_EDGE_GUARD_PX ||
        swipeSessionRef.current !== null ||
        !isSidebarInsetSwipeTarget(event.target) ||
        shouldIgnoreSidebarSwipeTarget(event.target)
      ) {
        return;
      }

      swipeSessionRef.current = createSidebarInsetSwipeSession({
        kind: "pointer",
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        selectionRoot: getSidebarSwipeSelectionRoot(event.target),
        startTarget: event.target instanceof Element ? event.target : null,
        canPreventDefault: true,
      });

      const removeListeners = () => {
        window.removeEventListener("pointermove", handleSwipeMove);
        window.removeEventListener("pointerup", handleSwipeEnd);
        window.removeEventListener("pointercancel", handleSwipeEnd);
      };
      window.addEventListener("pointermove", handleSwipeMove, {
        passive: false,
      });
      window.addEventListener("pointerup", handleSwipeEnd);
      window.addEventListener("pointercancel", handleSwipeEnd);
      removeSwipeListenersRef.current = removeListeners;
    },
    [handleSwipeEnd, handleSwipeMove, isCompactViewport, openMobile],
  );

  React.useEffect(() => {
    const cancelSwipeForTextSelection = () => {
      const selectionRoot = swipeSessionRef.current?.selectionRoot;
      if (
        selectionRoot !== null &&
        selectionRoot !== undefined &&
        hasExpandedTextSelectionWithin(selectionRoot)
      ) {
        clearSwipeSession();
      }
    };

    document.addEventListener("pointerdown", startPointerSwipe, {
      capture: true,
      passive: true,
    });
    document.addEventListener("touchstart", startTouchSwipe, {
      capture: true,
      passive: true,
    });
    document.addEventListener("selectionchange", cancelSwipeForTextSelection);
    return () => {
      document.removeEventListener("pointerdown", startPointerSwipe, {
        capture: true,
      });
      document.removeEventListener("touchstart", startTouchSwipe, {
        capture: true,
      });
      document.removeEventListener(
        "selectionchange",
        cancelSwipeForTextSelection,
      );
    };
  }, [clearSwipeSession, startPointerSwipe, startTouchSwipe]);

  const handleWheelSwipe = React.useCallback(
    (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        !isCompactViewport ||
        openMobile ||
        event.clientX < SIDEBAR_MOBILE_SWIPE_BROWSER_EDGE_GUARD_PX ||
        !isSidebarInsetSwipeTarget(event.target) ||
        shouldIgnoreSidebarSwipeTarget(event.target)
      ) {
        return;
      }

      const absDeltaX = Math.abs(event.deltaX);
      const absDeltaY = Math.abs(event.deltaY);
      if (
        absDeltaX < SIDEBAR_MOBILE_SWIPE_OPEN_INTENT_PX ||
        absDeltaX <= absDeltaY * 1.25
      ) {
        return;
      }

      if (
        event.target instanceof Element &&
        isInsideHorizontalScrollRegion(event.target)
      ) {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }

      wheelSwipeDeltaRef.current += event.deltaX;
      if (wheelSwipeResetTimeoutRef.current !== null) {
        window.clearTimeout(wheelSwipeResetTimeoutRef.current);
      }

      wheelSwipeResetTimeoutRef.current = window.setTimeout(() => {
        wheelSwipeDeltaRef.current = 0;
        wheelSwipeResetTimeoutRef.current = null;
      }, SIDEBAR_MOBILE_WHEEL_SWIPE_RESET_MS);

      if (
        Math.abs(wheelSwipeDeltaRef.current) <
        SIDEBAR_MOBILE_WHEEL_SWIPE_OPEN_DISTANCE_PX
      ) {
        return;
      }

      clearWheelSwipe();
      openMobileSidebar();
    },
    [clearWheelSwipe, isCompactViewport, openMobile, openMobileSidebar],
  );

  React.useEffect(() => {
    if (!isCompactViewport) {
      clearWheelSwipe();
      return;
    }

    document.addEventListener("wheel", handleWheelSwipe, {
      capture: true,
      passive: false,
    });
    return () => {
      document.removeEventListener("wheel", handleWheelSwipe, {
        capture: true,
      });
      clearWheelSwipe();
    };
  }, [clearWheelSwipe, handleWheelSwipe, isCompactViewport]);

  React.useEffect(
    () => () => {
      clearSwipeSession();
      removeSwipeClickSuppressorRef.current?.();
      if (swipeClickSuppressorTimeoutRef.current !== null) {
        window.clearTimeout(swipeClickSuppressorTimeoutRef.current);
        swipeClickSuppressorTimeoutRef.current = null;
      }
      clearWheelSwipe();
      clearMobileDragSettleTimeout();
      clearSidebarMobileDragStyles();
    },
    [clearMobileDragSettleTimeout, clearSwipeSession, clearWheelSwipe],
  );

  React.useEffect(() => {
    if (!isCompactViewport) {
      clearSwipeSession();
      clearSidebarMobileDragStyles();
      return;
    }

    if (openMobile && swipeSessionRef.current === null) {
      clearSwipeSession();
    }
  }, [clearSwipeSession, isCompactViewport, openMobile]);

  const secondaryPanelPresentation = React.useSyncExternalStore(
    subscribeCompactSecondaryPanelShelfShowing,
    getCompactSecondaryPanelPresentation,
    () => "closed" as const,
  );
  const shelfState = isCompactViewport
    ? openMobile
      ? "open"
      : "closed"
    : undefined;
  const panelShelfState =
    isCompactViewport && !openMobile ? secondaryPanelPresentation : undefined;

  return (
    <main
      ref={ref}
      data-sidebar="inset"
      data-sidebar-shelf={shelfState}
      data-panel-shelf={panelShelfState}
      style={
        openMobile && suppressMobileOpenAnimation
          ? { transition: "none" }
          : undefined
      }
      className={cn(
        "group/page-inset relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background max-md:z-30",
        SIDEBAR_MOBILE_SHELF_INSET_TRANSITION_CLASS,
        "data-[sidebar-shelf=open]:translate-x-(--sidebar-width-mobile) data-[sidebar-shelf]:will-change-[translate]",
        "data-[panel-shelf=shelf]:-translate-x-(--secondary-panel-width-mobile) data-[panel-shelf]:will-change-[translate]",
        "data-[panel-shelf=full]:-translate-x-full",
        "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow",
        className,
      )}
      {...props}
    />
  );
});
SidebarInset.displayName = "SidebarInset";

const SidebarFooter = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
});
SidebarFooter.displayName = "SidebarFooter";

const SIDEBAR_CONTENT_SELECTOR = '[data-sidebar="content"]';

const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, children, ...props }, ref) => {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const setContentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  return (
    <div
      ref={setContentRef}
      data-sidebar="content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto bg-sidebar group-data-[collapsible=icon]:overflow-hidden",
        className,
      )}
      {...props}
    >
      <SidebarContentElementContext.Provider value={contentRef}>
        {children}
      </SidebarContentElementContext.Provider>
    </div>
  );
});
SidebarContent.displayName = "SidebarContent";

type SidebarStickyTierKind = "label" | "project" | "parent";

type SidebarStickyStackProps = React.ComponentProps<"div">;

interface SidebarStickyTierProps extends React.ComponentProps<"div"> {
  tier: SidebarStickyTierKind;
  level?: number;
}

type SidebarStickyParentLevelStyle = React.CSSProperties & {
  "--bb-sidebar-sticky-parent-level": number;
};

const SidebarStickyStack = React.forwardRef<
  HTMLDivElement,
  SidebarStickyStackProps
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="group"
      data-sidebar-sticky-stack=""
      className={cn("relative flex w-full min-w-0 flex-col", className)}
      {...props}
    />
  );
});
SidebarStickyStack.displayName = "SidebarStickyStack";

const SidebarStickyTier = React.forwardRef<
  HTMLDivElement,
  SidebarStickyTierProps
>(({ children, className, tier, level, style, ...props }, ref) => {
  const tierStyle =
    tier === "parent" && level !== undefined
      ? ({
          ...style,
          "--bb-sidebar-sticky-parent-level": level,
        } satisfies SidebarStickyParentLevelStyle)
      : style;
  return (
    <div
      ref={ref}
      {...props}
      style={tierStyle}
      data-sidebar={tier === "label" ? "group-label" : undefined}
      data-sidebar-sticky-tier={tier}
      className={cn(
        tier === "label" && SIDEBAR_GROUP_LABEL_BASE_CLASS,
        tier === "label" && SIDEBAR_GROUP_LABEL_COLLAPSED_CLASS,
        "bg-sidebar",
        className,
      )}
    >
      {children}
    </div>
  );
});
SidebarStickyTier.displayName = "SidebarStickyTier";

type SidebarStickyGroupProps = React.ComponentProps<"div">;

const SidebarStickyGroup = React.forwardRef<
  HTMLDivElement,
  SidebarStickyGroupProps
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar-sticky-group=""
      className={cn(className)}
      {...props}
    />
  );
});
SidebarStickyGroup.displayName = "SidebarStickyGroup";

const SidebarGroupContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="group-content"
    className={cn("w-full text-sm", className)}
    {...props}
  />
));
SidebarGroupContent.displayName = "SidebarGroupContent";

const SidebarMenu = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    data-sidebar="menu"
    className={cn("flex w-full min-w-0 flex-col gap-1", className)}
    {...props}
  />
));
SidebarMenu.displayName = "SidebarMenu";

const SidebarMenuItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<"li">
>(({ className, ...props }, ref) => (
  <li
    ref={ref}
    data-sidebar="menu-item"
    className={cn("group/menu-item relative", className)}
    {...props}
  />
));
SidebarMenuItem.displayName = "SidebarMenuItem";

const SIDEBAR_MENU_BUTTON_CLASS =
  "flex h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0";

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & {
    asChild?: boolean;
    tooltip?: React.ComponentProps<typeof TooltipContent>;
  }
>(({ asChild = false, tooltip, className, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  const { isCompactViewport, state } = useSidebar();

  const button = (
    <Comp
      ref={ref}
      data-sidebar="menu-button"
      className={cn(SIDEBAR_MENU_BUTTON_CLASS, className)}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed" || isCompactViewport}
        {...tooltip}
      />
    </Tooltip>
  );
});
SidebarMenuButton.displayName = "SidebarMenuButton";

const SidebarMenuSkeleton = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  const skeletonId = React.useId();

  const width = React.useMemo(() => {
    let hash = 0;
    for (let index = 0; index < skeletonId.length; index += 1) {
      hash = (hash + skeletonId.charCodeAt(index) * (index + 1)) % 40;
    }
    return `${hash + 50}%`;
  }, [skeletonId]);

  return (
    <div
      ref={ref}
      data-sidebar="menu-skeleton"
      className={cn("rounded-md h-8 flex gap-2 px-2 items-center", className)}
      {...props}
    >
      <Skeleton
        className="h-4 flex-1 max-w-[--skeleton-width]"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  );
});
SidebarMenuSkeleton.displayName = "SidebarMenuSkeleton";

export {
  SIDEBAR_CONTENT_SELECTOR,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarStickyGroup,
  SidebarStickyStack,
  SidebarStickyTier,
  SidebarTrigger,
  useCloseMobileSidebar,
  useIsSidebarShowing,
  useOptionalIsSidebarShowing,
  useSidebar,
  useSidebarContentElementRef,
};
