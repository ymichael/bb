import { useCallback, useEffect, useRef, useState } from "react";
import { usePointerCoarse } from "./use-pointer-coarse.js";

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
const noop = () => undefined;

const EMPTY_HOVER_PROPS: HoverPopoverHandlers = {
  onPointerEnter: noop,
  onPointerLeave: noop,
};

export function useHoverPopover({
  closeDelayMs = DEFAULT_CLOSE_DELAY_MS,
}: UseHoverPopoverOptions = {}): UseHoverPopoverResult {
  const isPointerCoarse = usePointerCoarse();
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
    // Touch pointers open via tap. Pointer-based hover state has no role.
    if (isPointerCoarse) return;

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
  }, [
    clearCloseTimeout,
    closeDelayMs,
    isPointerCoarse,
    isPointerOverContent,
    isPointerOverTrigger,
  ]);

  useEffect(() => clearCloseTimeout, [clearCloseTimeout]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        clearCloseTimeout();
        setOpen(true);
        return;
      }

      setIsPointerOverTrigger(false);
      setIsPointerOverContent(false);
      clearCloseTimeout();
      setOpen(false);
    },
    [clearCloseTimeout],
  );

  const triggerHoverProps = isPointerCoarse
    ? EMPTY_HOVER_PROPS
    : {
        onPointerEnter: () => {
          setIsPointerOverTrigger(true);
        },
        onPointerLeave: () => {
          setIsPointerOverTrigger(false);
        },
      };

  const contentHoverProps = isPointerCoarse
    ? EMPTY_HOVER_PROPS
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
