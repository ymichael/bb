import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Slot } from "@radix-ui/react-slot";
import { DropdownMenu, DropdownMenuContent } from "@bb/shared-ui/dropdown-menu";

const LONG_PRESS_MS = 700;
const LONG_PRESS_MOVE_SLOP_PX = 10;
const POST_LONG_PRESS_CLICK_SUPPRESSION_MS = 1000;

const LONG_PRESS_TARGET_STYLE: CSSProperties = {
  WebkitTouchCallout: "none",
};

const claimedPressEvents = new WeakSet<Event>();

interface CompactLongPressMenuProps {
  children: ReactNode;
  items: ReactNode;
  label: string;
  onOpenChange?: (open: boolean) => void;
}

export function CompactLongPressMenu({
  children,
  items,
  label,
  onOpenChange,
}: CompactLongPressMenuProps) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const timerRef = useRef<number | null>(null);
  const pressRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const suppressClickUntilRef = useRef(0);

  const clearPress = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pressRef.current = null;
  }, []);

  useEffect(() => clearPress, [clearPress]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange],
  );

  const openMenu = useCallback(() => {
    clearPress();
    setHasOpened(true);
    handleOpenChange(true);
  }, [clearPress, handleOpenChange]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") {
        return;
      }
      if (!event.isPrimary) {
        return;
      }
      if (claimedPressEvents.has(event.nativeEvent)) {
        return;
      }
      claimedPressEvents.add(event.nativeEvent);
      clearPress();
      pressRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (pressRef.current === null) {
          return;
        }
        pressRef.current = null;
        suppressClickUntilRef.current =
          Date.now() + POST_LONG_PRESS_CLICK_SUPPRESSION_MS;
        openMenu();
      }, LONG_PRESS_MS);
    },
    [clearPress, openMenu],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const press = pressRef.current;
      if (press === null || press.pointerId !== event.pointerId) {
        return;
      }
      if (
        Math.abs(event.clientX - press.x) > LONG_PRESS_MOVE_SLOP_PX ||
        Math.abs(event.clientY - press.y) > LONG_PRESS_MOVE_SLOP_PX
      ) {
        clearPress();
      }
    },
    [clearPress],
  );

  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (pressRef.current?.pointerId === event.pointerId) {
        clearPress();
      }
    },
    [clearPress],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      if (pressRef.current !== null) {
        suppressClickUntilRef.current =
          Date.now() + POST_LONG_PRESS_CLICK_SUPPRESSION_MS;
      }
      openMenu();
    },
    [openMenu],
  );

  const handleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (Date.now() >= suppressClickUntilRef.current) {
        return;
      }
      suppressClickUntilRef.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  return (
    <>
      <Slot
        style={LONG_PRESS_TARGET_STYLE}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onContextMenu={handleContextMenu}
        onClickCapture={handleClickCapture}
      >
        {children}
      </Slot>
      {hasOpened ? (
        <DropdownMenu open={open} onOpenChange={handleOpenChange}>
          <DropdownMenuContent mobileTitle={label} aria-label={label}>
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );
}
