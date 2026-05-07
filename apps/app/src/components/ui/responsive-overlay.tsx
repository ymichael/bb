import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { Drawer, DrawerContent, DrawerTitle } from "./drawer.js";
import { getOverlayTriggerClassName } from "./overlay-trigger.js";
import { useIsMobile } from "./hooks/use-mobile.js";

// ---------------------------------------------------------------------------
// Shared context value for responsive overlays (dropdown menus, popovers)
// ---------------------------------------------------------------------------

export interface ResponsiveOverlayContextValue {
  isMobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Hook: manages open state, mobile detection, and breakpoint-cross close.
// One useMediaQuery subscription per Root (not two).
// ---------------------------------------------------------------------------

export function useResponsiveRoot(
  controlledOpen: boolean | undefined,
  controlledOnChange: ((open: boolean) => void) | undefined,
  defaultOpen: boolean = false,
): ResponsiveOverlayContextValue {
  const isMobile = useIsMobile();
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalOpen(next);
      }
      controlledOnChange?.(next);
    },
    [isControlled, controlledOnChange],
  );

  return React.useMemo(
    () => ({ isMobile, open, onOpenChange }),
    [isMobile, open, onOpenChange],
  );
}

// ---------------------------------------------------------------------------
// MobileTrigger: shared trigger for mobile overlays.
// Adds aria-expanded, aria-haspopup, and data-state that Radix normally
// provides on desktop but which are missing from a bare <button>.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// stripRadixContentProps: removes Radix positioning/behavior props from a
// props object so that only DOM-compatible props remain for mobile rendering.
// Derived from a single const to prevent interface/set drift.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ResponsiveDrawerShell: shared scaffold for the mobile branch of any
// responsive overlay. Wraps children in Drawer > DrawerContent, with an
// optional sr-only DrawerTitle. Callers supply the body (ref, padding,
// className, etc.) since those differ between Dialog, Popover, DropdownMenu,
// and ThreadDetailSecondaryContent.
// ---------------------------------------------------------------------------

interface ResponsiveDrawerShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Sr-only label announced when the drawer opens. Omit if the caller
   * renders its own labeled heading inside children (e.g. DialogTitle).
   */
  srLabel?: string;
  /** Class name on the DrawerContent wrapper. */
  contentClassName?: string;
  children: React.ReactNode;
}

export function ResponsiveDrawerShell({
  open,
  onOpenChange,
  srLabel,
  contentClassName,
  children,
}: ResponsiveDrawerShellProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className={contentClassName}>
        {srLabel !== undefined ? (
          <DrawerTitle className="sr-only">{srLabel}</DrawerTitle>
        ) : null}
        {children}
      </DrawerContent>
    </Drawer>
  );
}
