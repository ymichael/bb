import { useEffect, useRef, useState } from "react";
import { useIsRouteNavigationPending } from "./app-route-anchor";

export const ROUTE_NAVIGATION_INDICATOR_REVEAL_DELAY_MS = 120;
export const ROUTE_NAVIGATION_INDICATOR_MIN_VISIBLE_MS = 320;

export function useDelayedBusyIndicator(
  busy: boolean,
  {
    revealDelayMs = ROUTE_NAVIGATION_INDICATOR_REVEAL_DELAY_MS,
    minVisibleMs = ROUTE_NAVIGATION_INDICATOR_MIN_VISIBLE_MS,
  }: { revealDelayMs?: number; minVisibleMs?: number } = {},
): boolean {
  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (busy) {
      if (shownAtRef.current !== null) return;
      const revealTimeout = window.setTimeout(() => {
        shownAtRef.current = Date.now();
        setVisible(true);
      }, revealDelayMs);
      return () => window.clearTimeout(revealTimeout);
    }

    const shownAt = shownAtRef.current;
    if (shownAt === null) {
      setVisible(false);
      return;
    }

    const remainingMs = minVisibleMs - (Date.now() - shownAt);
    if (remainingMs <= 0) {
      shownAtRef.current = null;
      setVisible(false);
      return;
    }

    const hideTimeout = window.setTimeout(() => {
      shownAtRef.current = null;
      setVisible(false);
    }, remainingMs);
    return () => window.clearTimeout(hideTimeout);
  }, [busy, minVisibleMs, revealDelayMs]);

  return visible;
}

export function RouteNavigationIndicator() {
  const isPending = useIsRouteNavigationPending();
  const visible = useDelayedBusyIndicator(isPending);

  if (!visible) return null;

  return (
    <div
      data-testid="route-navigation-indicator"
      role="progressbar"
      aria-label="Loading page"
      className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-100 h-0.5 overflow-hidden bg-transparent"
    >
      <div className="h-full w-1/3 animate-indeterminate-progress rounded-full bg-muted-foreground" />
    </div>
  );
}
