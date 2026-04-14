import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/useMobile";

interface HoverPopoverHandlers {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

interface UseHoverPopoverOptions {
  closeDelayMs?: number;
}

interface UseHoverPopoverResult {
  open: boolean;
  triggerHoverProps: HoverPopoverHandlers;
  contentHoverProps: HoverPopoverHandlers;
  handleOpenChange: (nextOpen: boolean) => void;
}

const DEFAULT_CLOSE_DELAY_MS = 160;

export function useHoverPopover({
  closeDelayMs = DEFAULT_CLOSE_DELAY_MS,
}: UseHoverPopoverOptions = {}): UseHoverPopoverResult {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [isPointerOverTrigger, setIsPointerOverTrigger] = useState(false);
  const [isPointerOverContent, setIsPointerOverContent] = useState(false);
  const closeTimeoutRef = useRef<number | null>(null);

  const clearCloseTimeout = useCallback(() => {
    if (closeTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(closeTimeoutRef.current);
    closeTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    // On touch/narrow viewports, the popover opens via tap (MobileTrigger) and
    // closes via drawer dismiss. Pointer-based hover state has no role.
    if (isMobile) return;

    clearCloseTimeout();

    if (isPointerOverTrigger || isPointerOverContent) {
      setOpen(true);
      return;
    }

    closeTimeoutRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimeoutRef.current = null;
    }, closeDelayMs);

    return clearCloseTimeout;
  }, [clearCloseTimeout, closeDelayMs, isMobile, isPointerOverContent, isPointerOverTrigger]);

  useEffect(() => clearCloseTimeout, [clearCloseTimeout]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      clearCloseTimeout();
      setOpen(true);
      return;
    }

    setIsPointerOverTrigger(false);
    setIsPointerOverContent(false);
    clearCloseTimeout();
    setOpen(false);
  }, [clearCloseTimeout]);

  const emptyHoverProps = {
    onPointerEnter: () => {},
    onPointerLeave: () => {},
  };

  const triggerHoverProps = isMobile
    ? emptyHoverProps
    : {
        onPointerEnter: () => {
          setIsPointerOverTrigger(true);
        },
        onPointerLeave: () => {
          setIsPointerOverTrigger(false);
        },
      };

  const contentHoverProps = isMobile
    ? emptyHoverProps
    : {
        onPointerEnter: () => {
          setIsPointerOverContent(true);
        },
        onPointerLeave: () => {
          setIsPointerOverContent(false);
        },
        // Hover-driven popovers should not steal or restore focus.
        onOpenAutoFocus: (event: Event) => {
          event.preventDefault();
        },
        onCloseAutoFocus: (event: Event) => {
          event.preventDefault();
        },
      };

  return {
    open,
    triggerHoverProps,
    contentHoverProps,
    handleOpenChange,
  };
}
