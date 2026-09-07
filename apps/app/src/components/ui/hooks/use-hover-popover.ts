import { useCallback, useEffect, useRef, useState } from "react";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";

interface HoverPopoverHandlers {
  onBlur: () => void;
  onFocus: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

interface UseHoverPopoverOptions {
  openDelayMs?: number;
  closeDelayMs?: number;
  hoverableContent?: boolean;
}

interface UseHoverPopoverResult {
  open: boolean;
  triggerHoverProps: HoverPopoverHandlers;
  contentHoverProps: HoverPopoverHandlers;
  handleOpenChange: (nextOpen: boolean) => void;
}

const DEFAULT_OPEN_DELAY_MS = 0;
const DEFAULT_CLOSE_DELAY_MS = 160;
const noop = () => undefined;
const preventAutoFocus = (event: Event) => {
  event.preventDefault();
};

const EMPTY_HOVER_PROPS: HoverPopoverHandlers = {
  onBlur: noop,
  onFocus: noop,
  onPointerEnter: noop,
  onPointerLeave: noop,
};

const NON_HOVERABLE_CONTENT_PROPS: HoverPopoverHandlers = {
  onBlur: noop,
  onFocus: noop,
  onPointerEnter: noop,
  onPointerLeave: noop,
  onOpenAutoFocus: preventAutoFocus,
  onCloseAutoFocus: preventAutoFocus,
};

export function useHoverPopover({
  openDelayMs = DEFAULT_OPEN_DELAY_MS,
  closeDelayMs = DEFAULT_CLOSE_DELAY_MS,
  hoverableContent = true,
}: UseHoverPopoverOptions = {}): UseHoverPopoverResult {
  const isPointerCoarse = usePointerCoarse();
  const [open, setOpen] = useState(false);
  const [isFocusOverTrigger, setIsFocusOverTrigger] = useState(false);
  const [isFocusOverContent, setIsFocusOverContent] = useState(false);
  const [isPointerOverTrigger, setIsPointerOverTrigger] = useState(false);
  const [isPointerOverContent, setIsPointerOverContent] = useState(false);
  const toggleTimeoutRef = useRef<number | null>(null);

  const clearToggleTimeout = useCallback(() => {
    if (toggleTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(toggleTimeoutRef.current);
    toggleTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    if (isPointerCoarse) return;

    clearToggleTimeout();

    if (isFocusOverTrigger || isFocusOverContent) {
      if (!open) setOpen(true);
      return;
    }

    if (isPointerOverTrigger || isPointerOverContent) {
      if (open) return;

      if (openDelayMs <= 0) {
        setOpen(true);
        return;
      }

      toggleTimeoutRef.current = window.setTimeout(() => {
        setOpen(true);
        toggleTimeoutRef.current = null;
      }, openDelayMs);

      return clearToggleTimeout;
    }

    if (!open) return;

    toggleTimeoutRef.current = window.setTimeout(() => {
      setOpen(false);
      toggleTimeoutRef.current = null;
    }, closeDelayMs);

    return clearToggleTimeout;
  }, [
    clearToggleTimeout,
    closeDelayMs,
    isFocusOverContent,
    isFocusOverTrigger,
    isPointerCoarse,
    isPointerOverContent,
    isPointerOverTrigger,
    open,
    openDelayMs,
  ]);

  useEffect(() => clearToggleTimeout, [clearToggleTimeout]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        clearToggleTimeout();
        setOpen(true);
        return;
      }

      setIsPointerOverTrigger(false);
      setIsPointerOverContent(false);
      setIsFocusOverTrigger(false);
      setIsFocusOverContent(false);
      clearToggleTimeout();
      setOpen(false);
    },
    [clearToggleTimeout],
  );

  const triggerHoverProps = {
    ...(isPointerCoarse
      ? EMPTY_HOVER_PROPS
      : {
          onPointerEnter: () => {
            setIsPointerOverTrigger(true);
          },
          onPointerLeave: () => {
            setIsPointerOverTrigger(false);
          },
        }),
    onFocus: () => setIsFocusOverTrigger(true),
    onBlur: () => setIsFocusOverTrigger(false),
  };

  const contentHoverProps = {
    ...(isPointerCoarse
      ? EMPTY_HOVER_PROPS
      : hoverableContent
        ? {
            onPointerEnter: () => {
              setIsPointerOverContent(true);
            },
            onPointerLeave: () => {
              setIsPointerOverContent(false);
            },
            onOpenAutoFocus: preventAutoFocus,
            onCloseAutoFocus: preventAutoFocus,
          }
        : NON_HOVERABLE_CONTENT_PROPS),
    onFocus: () => setIsFocusOverContent(true),
    onBlur: () => setIsFocusOverContent(false),
  };

  return {
    open,
    triggerHoverProps,
    contentHoverProps,
    handleOpenChange,
  };
}
