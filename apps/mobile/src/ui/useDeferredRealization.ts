import { useEffect, useState } from "react";
import { scheduleDeferredRealization } from "./deferred-realization";

const scheduler = {
  requestAnimationFrame: (cb: () => void) =>
    globalThis.requestAnimationFrame(cb),
  cancelAnimationFrame: (handle: number) =>
    globalThis.cancelAnimationFrame(handle),
  setTimeout: (cb: () => void, ms: number) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) =>
    globalThis.clearTimeout(handle),
};

export function useDeferredRealization(active: boolean): boolean {
  const [realized, setRealized] = useState(false);
  useEffect(() => {
    if (!active || realized) return;
    return scheduleDeferredRealization(() => setRealized(true), scheduler);
  }, [active, realized]);
  return realized;
}
