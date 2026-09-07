import { useSetAtom } from "jotai";
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  observedBorderBoxBlockSize,
  observeSharedResize,
} from "@/lib/shared-resize-observer";
import { layoutAnimationInFlightCountAtom } from "./layoutAnimationAtoms.js";
import { CONTROL_HOVER_TRANSITION } from "@bb/shared-ui/motion";

const EXPANDABLE_PANEL_TRANSITION_MS = 200;

interface PanelHeightSync {
  isToggleAnimating: boolean;
  heightPx: number;
}
const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ChevronProps {
  className?: string;
}

const COLLAPSIBLE_HEADER_COLLAPSED_TONE_CLASS = `text-muted-foreground ${CONTROL_HOVER_TRANSITION} hover:text-foreground focus-visible:text-foreground`;
const COLLAPSIBLE_HEADER_EXPANDED_TONE_CLASS = "text-foreground";
export const COLLAPSIBLE_HEADER_STATIC_TONE_CLASS = "text-muted-foreground";
const COLLAPSIBLE_HEADER_BUTTON_BASE_CLASS =
  "inline-flex max-w-full items-center gap-1 overflow-hidden py-0.5 text-left text-sm";
const COLLAPSIBLE_HEADER_TEXT_CLASS = "min-w-0 truncate";

function Chevron({ className }: ChevronProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="0.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("lucide lucide-chevron-right", className)}
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function getCollapsibleHeaderToneClass(isExpanded: boolean): string {
  return isExpanded
    ? COLLAPSIBLE_HEADER_EXPANDED_TONE_CLASS
    : COLLAPSIBLE_HEADER_COLLAPSED_TONE_CLASS;
}

interface CollapsibleHeaderProps {
  summaryContent: ReactNode;
  toneClassName: string;
  summaryClassName?: string;
  className?: string;
  forceChevronVisible?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
}

export function CollapsibleHeader({
  summaryContent,
  toneClassName,
  summaryClassName,
  className,
  forceChevronVisible = false,
  isExpanded = false,
  onToggle,
}: CollapsibleHeaderProps) {
  const rootClassName = cn(
    COLLAPSIBLE_HEADER_BUTTON_BASE_CLASS,
    toneClassName,
    onToggle ? "group/toggle cursor-pointer" : null,
    className,
  );
  const summaryClass = summaryClassName ?? COLLAPSIBLE_HEADER_TEXT_CLASS;

  if (!onToggle) {
    return (
      <div className={rootClassName}>
        <span className={summaryClass}>{summaryContent}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      onClick={onToggle}
      className={rootClassName}
    >
      <span className={summaryClass}>{summaryContent}</span>
      <Chevron
        className={cn(
          "pointer-events-none size-3 shrink-0 origin-center text-subtle-foreground/60 transition-[opacity,rotate] duration-200 ease-out",
          isExpanded
            ? "rotate-90"
            : forceChevronVisible
              ? "opacity-100"
              : "opacity-0 group-hover/toggle:opacity-100 group-focus-visible/toggle:opacity-100 max-md:pointer-coarse:opacity-100",
        )}
      />
    </button>
  );
}

interface ExpandablePanelProps {
  isExpanded: boolean;
  summaryContent: ReactNode;
  headerToneClass: string;
  onToggle?: () => void;
  collapsedContent?: ReactNode;
  forceHeaderChevronVisible?: boolean;
  summaryContentClassName?: string;
  children?: ReactNode;
  renderBody?: () => ReactNode;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
}

interface AnimatedExpandablePanelContentProps {
  collapsedContent: ReactNode;
  contentClassName?: string;
  isBodyExpanded: boolean;
  renderedBody: ReactNode;
}

function AnimatedExpandablePanelContent({
  collapsedContent,
  contentClassName,
  isBodyExpanded,
  renderedBody,
}: AnimatedExpandablePanelContentProps) {
  const regionRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const toggleAnimationDeadlineRef = useRef(0);
  const isFirstToggleEffectRef = useRef(true);
  useBrowserLayoutEffect(() => {
    if (isFirstToggleEffectRef.current) {
      isFirstToggleEffectRef.current = false;
      return;
    }
    toggleAnimationDeadlineRef.current =
      performance.now() + EXPANDABLE_PANEL_TRANSITION_MS;
  }, [isBodyExpanded]);

  useBrowserLayoutEffect(() => {
    const region = regionRef.current;
    const target = contentRef.current;
    if (!region || !target) {
      return;
    }

    const readHeightSync = (
      entry: ResizeObserverEntry | undefined,
    ): PanelHeightSync => {
      const observedHeight =
        entry === undefined ? undefined : observedBorderBoxBlockSize(entry);
      return {
        isToggleAnimating:
          performance.now() < toggleAnimationDeadlineRef.current,
        heightPx: observedHeight ?? target.offsetHeight,
      };
    };
    const writeHeightSync = ({
      heightPx,
      isToggleAnimating,
    }: PanelHeightSync) => {
      region.style.transitionDuration = isToggleAnimating ? "" : "0s";
      region.style.height = `${heightPx}px`;
    };

    writeHeightSync(readHeightSync(undefined));

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    return observeSharedResize(target, {
      read: readHeightSync,
      write: writeHeightSync,
    });
  }, [collapsedContent, isBodyExpanded, renderedBody]);

  return (
    <div
      ref={regionRef}
      className="relative transition-[height] duration-200 ease-out"
      style={{
        overflowX: "visible",
        overflowY: "clip",
      }}
    >
      <div ref={contentRef}>
        {isBodyExpanded ? (
          <div className={cn("px-2 pb-1 pt-0", contentClassName)}>
            {renderedBody}
          </div>
        ) : (
          collapsedContent
        )}
      </div>
    </div>
  );
}

export function ExpandablePanel({
  isExpanded,
  summaryContent,
  headerToneClass,
  onToggle,
  collapsedContent,
  forceHeaderChevronVisible = false,
  summaryContentClassName,
  children,
  renderBody,
  className,
  headerClassName,
  contentClassName,
}: ExpandablePanelProps) {
  const hasCollapsedContent =
    collapsedContent !== undefined && collapsedContent !== null;
  const headerRootClassName = cn("px-2 py-1", headerClassName);
  const [isClosing, setIsClosing] = useState(false);
  const renderedBodyRef = useRef<ReactNode>(null);
  const deferredIsExpanded = useDeferredValue(isExpanded);
  const expandedBody = useMemo(() => {
    if (!deferredIsExpanded) {
      return null;
    }
    return renderBody ? renderBody() : children;
  }, [children, deferredIsExpanded, renderBody]);
  const isBodyExpanded = isExpanded && (deferredIsExpanded || isClosing);

  const setLayoutAnimationInFlightCount = useSetAtom(
    layoutAnimationInFlightCountAtom,
  );
  const isFirstAnimationEffectRef = useRef(true);
  useBrowserLayoutEffect(() => {
    if (isFirstAnimationEffectRef.current) {
      isFirstAnimationEffectRef.current = false;
      return;
    }
    setLayoutAnimationInFlightCount((c) => c + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      setLayoutAnimationInFlightCount((c) => Math.max(0, c - 1));
    };
    const timer = window.setTimeout(release, EXPANDABLE_PANEL_TRANSITION_MS);
    return () => {
      window.clearTimeout(timer);
      release();
    };
  }, [isBodyExpanded, setLayoutAnimationInFlightCount]);

  useBrowserLayoutEffect(() => {
    if (!deferredIsExpanded) {
      return;
    }
    renderedBodyRef.current = expandedBody;
  }, [deferredIsExpanded, expandedBody]);

  useBrowserLayoutEffect(() => {
    if (isExpanded) {
      return;
    }
    if (hasCollapsedContent) {
      renderedBodyRef.current = null;
      setIsClosing(false);
      return;
    }
    if (renderedBodyRef.current === null) {
      return;
    }
    setIsClosing(true);
    const timeout = setTimeout(() => {
      renderedBodyRef.current = null;
      setIsClosing(false);
    }, EXPANDABLE_PANEL_TRANSITION_MS);
    return () => clearTimeout(timeout);
  }, [hasCollapsedContent, isExpanded]);
  const renderedBody = deferredIsExpanded
    ? expandedBody
    : isClosing
      ? renderedBodyRef.current
      : null;

  return (
    <div className={cn("rounded-md text-muted-foreground", className)}>
      {}
      <div className="group/timeline-row">
        <CollapsibleHeader
          isExpanded={isExpanded}
          forceChevronVisible={forceHeaderChevronVisible}
          onToggle={onToggle}
          toneClassName={headerToneClass}
          className={headerRootClassName}
          summaryClassName={
            summaryContentClassName ?? COLLAPSIBLE_HEADER_TEXT_CLASS
          }
          summaryContent={summaryContent}
        />
      </div>
      {hasCollapsedContent ? (
        <AnimatedExpandablePanelContent
          collapsedContent={collapsedContent}
          contentClassName={contentClassName}
          isBodyExpanded={isBodyExpanded}
          renderedBody={isBodyExpanded ? renderedBody : null}
        />
      ) : (
        <div
          aria-hidden={!isBodyExpanded}
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
            isBodyExpanded
              ? "pointer-events-auto grid-rows-[1fr] opacity-100"
              : "pointer-events-none grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="overflow-hidden">
            <div
              className={cn(
                "px-2 pb-1 pt-0 transition-[transform,opacity] duration-200 ease-out",
                isBodyExpanded
                  ? "translate-y-0 opacity-100"
                  : "-translate-y-1 opacity-0",
                contentClassName,
              )}
            >
              {renderedBody}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
