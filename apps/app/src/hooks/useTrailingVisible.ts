import { useEffect, useState } from "react";

// Propagates `visible` true→true immediately and true→false after `delayMs`,
// canceling a pending hide if `visible` flips back to true. The returned
// `held` value lags the source on the falling edge only — useful when an
// adjacent layout change needs to settle before a co-located element is
// allowed to disappear.
export function useTrailingVisible(
  visible: boolean,
  delayMs: number,
): boolean {
  const [held, setHeld] = useState(visible);
  useEffect(() => {
    if (visible) {
      setHeld(true);
      return;
    }
    const id = window.setTimeout(() => setHeld(false), delayMs);
    return () => window.clearTimeout(id);
  }, [visible, delayMs]);
  return held;
}
