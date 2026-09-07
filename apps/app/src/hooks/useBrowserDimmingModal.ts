import { useEffect } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";

const browserDimmingModalCountAtom = atom(0);

export function useBrowserDimmingOverlay(active: boolean): void {
  const setCount = useSetAtom(browserDimmingModalCountAtom);
  useEffect(() => {
    if (!active) {
      return;
    }
    setCount((count) => count + 1);
    return () => setCount((count) => count - 1);
  }, [active, setCount]);
}

export function useBrowserDimmingModal(active: boolean): void {
  useBrowserDimmingOverlay(active);
}

export function useIsBrowserDimmingModalOpen(): boolean {
  return useAtomValue(browserDimmingModalCountAtom) > 0;
}
