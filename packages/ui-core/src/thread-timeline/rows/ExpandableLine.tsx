import { useRef, useState, type CSSProperties, type ReactNode } from "react";

export interface ExpandableLineProps {
  /** Full text used for the tooltip title when collapsed. */
  fullText: string;
  /** Content rendered inside the button — typically the same text, possibly with a prefix. */
  children: ReactNode;
  /** Classes applied in both states. */
  className?: string;
  /** Classes applied only when collapsed (e.g. `truncate` or a line-clamp container). */
  collapsedClassName: string;
  /** Inline style applied only when collapsed (e.g. WebKit line-clamp properties). */
  collapsedStyle?: CSSProperties;
  /** Classes applied only when expanded. Defaults to natural wrapping. */
  expandedClassName?: string;
}

const DEFAULT_EXPANDED_CLASS_NAME = "whitespace-pre-wrap break-words";

/**
 * A single-line or multi-line clamped piece of text that the user can click to
 * reveal in full. Used inside timeline row bodies where long strings would
 * otherwise be trapped behind a `title` tooltip and invisible to touch users.
 */
export function ExpandableLine({
  fullText,
  children,
  className,
  collapsedClassName,
  collapsedStyle,
  expandedClassName = DEFAULT_EXPANDED_CLASS_NAME,
}: ExpandableLineProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const handleToggle = () => {
    // If a drag-select ends inside the button, `click` still fires on mouseup
    // at the same element — bail out so the user's selection survives instead
    // of collapsing the line out from under them.
    const selection =
      typeof window === "undefined" ? null : window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    // When collapsing from a scrolled position, reset scrollTop first so the
    // height transition runs from the top of the content rather than freezing
    // mid-scroll as the max-height clamps.
    if (isExpanded && buttonRef.current) {
      buttonRef.current.scrollTo({ top: 0, behavior: "auto" });
    }
    setIsExpanded((prev) => !prev);
  };
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={handleToggle}
      className={[
        "block w-full cursor-pointer select-text text-left leading-tight transition-[max-height] duration-200 ease-out",
        isExpanded ? expandedClassName : collapsedClassName,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={isExpanded ? undefined : collapsedStyle}
      title={isExpanded ? "Click to collapse" : fullText}
      aria-expanded={isExpanded}
    >
      {children}
    </button>
  );
}
