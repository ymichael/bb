import { useSetAtom } from "jotai";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { layoutAnimationInFlightCountAtom } from "./layoutAnimationAtoms.js";

const EXPANDABLE_PANEL_TRANSITION_MS = 200;
const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ChevronProps {
  className?: string;
}

export const COLLAPSIBLE_HEADER_COLLAPSED_TONE_CLASS =
  "text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground";
export const COLLAPSIBLE_HEADER_EXPANDED_TONE_CLASS = "text-foreground";
export const COLLAPSIBLE_HEADER_STATIC_TONE_CLASS = "text-muted-foreground";
export const COLLAPSIBLE_HEADER_BUTTON_BASE_CLASS =
  "inline-flex max-w-full items-center gap-1 overflow-hidden py-0.5 text-left text-sm";
export const COLLAPSIBLE_HEADER_TEXT_CLASS = "min-w-0 truncate";

function Chevron({ className }: ChevronProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
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

export interface CollapsibleHeaderProps {
  summaryContent: ReactNode;
  toneClassName: string;
  summaryClassName?: string;
  className?: string;
  isExpanded?: boolean;
  onToggle?: () => void;
}

export function CollapsibleHeader({
  summaryContent,
  toneClassName,
  summaryClassName,
  className,
  isExpanded = false,
  onToggle,
}: CollapsibleHeaderProps) {
  const rootClassName = cn(
    COLLAPSIBLE_HEADER_BUTTON_BASE_CLASS,
    toneClassName,
    onToggle ? "group/toggle" : null,
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
          "pointer-events-none size-4 shrink-0 origin-center transition-[opacity,rotate] duration-200 ease-out",
          isExpanded
            ? "rotate-90"
            : "opacity-0 group-hover/toggle:opacity-100 group-focus-visible/toggle:opacity-100 max-md:pointer-coarse:opacity-100",
        )}
      />
    </button>
  );
}

export interface ExpandablePanelProps {
  isExpanded: boolean;
  summaryContent: ReactNode;
  headerToneClass: string;
  onToggle: () => void;
  headerButtonClassName?: string;
  summaryContentClassName?: string;
  children?: ReactNode;
  renderBody?: () => ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  contentClassName?: string;
}

export function ExpandablePanel({
  isExpanded,
  summaryContent,
  headerToneClass,
  onToggle,
  headerButtonClassName,
  summaryContentClassName,
  children,
  renderBody,
  className,
  headerClassName,
  bodyClassName,
  contentClassName,
}: ExpandablePanelProps) {
  const headerRootClassName = cn(
    "px-2 py-1",
    headerClassName,
    headerButtonClassName,
  );
  const [isClosing, setIsClosing] = useState(false);
  const renderedBodyRef = useRef<ReactNode>(null);
  const expandedBody = useMemo(() => {
    if (!isExpanded) {
      return null;
    }
    return renderBody ? renderBody() : children;
  }, [children, isExpanded, renderBody]);

  // Signal to AutoHeightContainer / HeightTransition wrappers that a
  // CSS-driven layout animation is in flight, so they snap their wrapper to
  // inner.height each frame instead of running their own lagging 180ms
  // transition. Without this, three layers compound (this grid animation +
  // wrapper transition + bottom-anchor) and the timeline slides for ~280ms
  // instead of the row's intended 200ms.
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
  }, [isExpanded, setLayoutAnimationInFlightCount]);

  useBrowserLayoutEffect(() => {
    if (!isExpanded) {
      return;
    }
    renderedBodyRef.current = expandedBody;
  }, [expandedBody, isExpanded]);

  useBrowserLayoutEffect(() => {
    if (isExpanded) {
      return;
    }
    if (renderedBodyRef.current === null) {
      return;
    }
    setIsClosing(true);
    const timeout = setTimeout(
      () => {
        renderedBodyRef.current = null;
        setIsClosing(false);
      },
      EXPANDABLE_PANEL_TRANSITION_MS,
    );
    return () => clearTimeout(timeout);
  }, [isExpanded]);
  const renderedBody = isExpanded
    ? expandedBody
    : isClosing
      ? renderedBodyRef.current
      : null;

  return (
    <div className={cn("rounded-md text-muted-foreground", className)}>
      <CollapsibleHeader
        isExpanded={isExpanded}
        onToggle={onToggle}
        toneClassName={headerToneClass}
        className={headerRootClassName}
        summaryClassName={
          summaryContentClassName ?? COLLAPSIBLE_HEADER_TEXT_CLASS
        }
        summaryContent={summaryContent}
      />
      <div
        aria-hidden={!isExpanded}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          isExpanded
            ? "pointer-events-auto grid-rows-[1fr] opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0",
          bodyClassName,
        )}
      >
        <div className="overflow-hidden">
          <div
            className={cn(
              "px-2 pb-1 pt-0 transition-[transform,opacity] duration-200 ease-out will-change-transform",
              isExpanded
                ? "translate-y-0 opacity-100"
                : "-translate-y-1 opacity-0",
              contentClassName,
            )}
          >
            {renderedBody}
          </div>
        </div>
      </div>
    </div>
  );
}
