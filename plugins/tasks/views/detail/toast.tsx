import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@bb/shared-ui/icon";

interface DetailToast {
  id: number;
  message: string;
}

export function useDetailToasts() {
  const [toasts, setToasts] = useState<DetailToast[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<number[]>([]);
  useEffect(
    () => () => timersRef.current.forEach((timer) => clearTimeout(timer)),
    [],
  );
  const push = useCallback((message: string) => {
    const id = nextIdRef.current++;
    setToasts((current) => [...current, { id, message }]);
    timersRef.current.push(
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, 5000),
    );
  }, []);
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  return { toasts, push, dismiss };
}

export function DetailToasts({
  toasts,
  onDismiss,
}: {
  toasts: DetailToast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="pointer-events-auto flex max-w-md items-center gap-2 rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md border-destructive/50"
        >
          <Icon
            name="AlertCircle"
            className="size-4 shrink-0 text-destructive"
          />
          <span className="min-w-0 flex-1">{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => onDismiss(toast.id)}
          >
            <Icon name="X" className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
