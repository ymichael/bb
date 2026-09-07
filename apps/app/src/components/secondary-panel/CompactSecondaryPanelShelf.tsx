import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@bb/shared-ui/lib/utils";
import { usePersistentOverlayFocus } from "@bb/shared-ui/responsive-overlay";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import { useHorizontalDismissDrag } from "@/components/ui/use-horizontal-dismiss-drag";
import {
  setCompactSecondaryPanelPresentation,
  type CompactSecondaryPanelPresentation,
} from "@/components/ui/secondary-panel-shelf-visibility";

const SHELF_TRANSITION_CLASS =
  "[transition:translate_220ms_cubic-bezier(0.32,0.72,0,1),width_220ms_cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none!";
const SHELF_SETTLE_MS = 220;
const SHELF_DRAG_SETTLE_TRANSITION =
  "translate 220ms cubic-bezier(0.32, 0.72, 0, 1)";

interface CompactSecondaryPanelShelfProps {
  children: ReactNode;
  onClose: () => void;
  onContentAnimationEnd?: (open: boolean) => void;
  open: boolean;
  presentation: Exclude<CompactSecondaryPanelPresentation, "closed">;
  srLabel?: string;
}

export function CompactSecondaryPanelShelf({
  children,
  onClose,
  onContentAnimationEnd,
  open,
  presentation,
  srLabel,
}: CompactSecondaryPanelShelfProps) {
  const labelId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dismissRef = useRef<HTMLDivElement | null>(null);
  const draggedInsetRef = useRef<HTMLElement | null>(null);
  const state = !open ? "closed" : presentation;
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const requestClose = useCallback(() => onCloseRef.current(), []);

  const clearDragStyles = useCallback(() => {
    const inset = draggedInsetRef.current;
    if (inset !== null) {
      inset.style.translate = "";
      inset.style.transition = "";
      draggedInsetRef.current = null;
    }
    const dismiss = dismissRef.current;
    if (dismiss !== null) {
      dismiss.style.translate = "";
      dismiss.style.transition = "";
    }
  }, []);

  const applyDragProgress = useCallback(
    ({
      progress,
      width,
      settling,
    }: {
      progress: number;
      width: number;
      settling: boolean;
    }) => {
      const panel = panelRef.current;
      const dismiss = dismissRef.current;
      if (panel === null || dismiss === null) {
        return;
      }
      const inset = panel.ownerDocument.querySelector('[data-sidebar="inset"]');
      const translate = `${-width * progress}px`;
      const transition = settling ? SHELF_DRAG_SETTLE_TRANSITION : "none";
      if (inset instanceof HTMLElement) {
        draggedInsetRef.current = inset;
        inset.style.translate = translate;
        inset.style.transition = transition;
      }
      dismiss.style.translate = translate;
      dismiss.style.transition = transition;
    },
    [],
  );
  const { beginPointerDrag, beginTouchDrag } = useHorizontalDismissDrag({
    direction: "right",
    dismissTiming: "immediate",
    enabled: open,
    getWidth: () => panelRef.current?.clientWidth ?? 0,
    onClear: clearDragStyles,
    onDismiss: requestClose,
    onProgress: applyDragProgress,
    resetKey: presentation,
    suppressClick: false,
  });

  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  usePersistentOverlayFocus({
    open: open && portalTarget !== null,
    panelRef,
    requestClose,
  });

  useEffect(() => {
    setCompactSecondaryPanelPresentation(state);
    return () => setCompactSecondaryPanelPresentation("closed");
  }, [state]);

  useEffect(() => {
    if (onContentAnimationEnd === undefined) return;
    const timer = window.setTimeout(
      () => onContentAnimationEnd(open),
      SHELF_SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [onContentAnimationEnd, open]);

  if (portalTarget === null) {
    return null;
  }

  return createPortal(
    <>
      <div
        ref={dismissRef}
        data-secondary-panel-shelf-dismiss=""
        data-testid="secondary-panel-shelf-dismiss"
        data-state={state}
        aria-hidden="true"
        style={{ zIndex: APP_OVERLAY_LAYER.secondaryPanelDismiss }}
        className={cn(
          "fixed inset-0 bg-transparent",
          "data-[state=shelf]:-translate-x-(--secondary-panel-width-mobile)",
          "data-[state=full]:-translate-x-full",
          SHELF_TRANSITION_CLASS,
          "data-[state=closed]:pointer-events-none data-[state=full]:pointer-events-none",
        )}
        onClick={requestClose}
        onPointerDown={beginPointerDrag}
        onTouchStart={beginTouchDrag}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={srLabel === undefined ? undefined : labelId}
        data-bb-portaled-overlay=""
        tabIndex={-1}
        inert={!open}
        data-secondary-panel-shelf=""
        data-testid="secondary-panel-shelf"
        data-state={state}
        style={{
          zIndex:
            state === "full"
              ? APP_OVERLAY_LAYER.secondaryPanelFullPage
              : APP_OVERLAY_LAYER.secondaryPanel,
        }}
        className={cn(
          "fixed inset-y-0 right-0 flex h-(--bb-shell-height) touch-pan-y flex-col overflow-hidden border-l border-border-seam bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[var(--bb-safe-area-bottom,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] outline-none",
          "w-(--secondary-panel-width-mobile) data-[state=full]:w-full data-[state=full]:border-l-0",
          SHELF_TRANSITION_CLASS,
          "data-[state=closed]:invisible data-[state=closed]:[transition:visibility_0s_linear_220ms]",
        )}
        onPointerDown={beginPointerDrag}
        onTouchStart={beginTouchDrag}
      >
        {srLabel === undefined ? null : (
          <span id={labelId} className="sr-only">
            {srLabel}
          </span>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </div>
    </>,
    portalTarget,
  );
}
