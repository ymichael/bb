import { useCallback, useMemo, useState } from "react";

export function useDialogState<T>() {
  const [target, setTarget] = useState<T | null>(null);

  const onOpen = useCallback((nextTarget: T) => {
    setTarget(nextTarget);
  }, []);

  const onClose = useCallback(() => {
    setTarget(null);
  }, []);

  const onOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setTarget(null);
    }
  }, []);

  return useMemo(
    () => ({
      isOpen: target !== null,
      onClose,
      onOpen,
      onOpenChange,
      setTarget,
      target,
    }),
    [onClose, onOpen, onOpenChange, target],
  );
}
