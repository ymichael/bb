import { type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const BASE_CHROME =
  "rounded-md border border-border bg-surface-recessed";

export interface PromptStackCardProps {
  children: ReactNode;
  /**
   * Accessible region label. When provided the card renders as
   * <section aria-label={...}>; otherwise it renders as a plain <div>.
   */
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Shared chrome for the stack of context cards rendered above the FollowUp
 * prompt box (today: ContextBanner + QueuedMessagesList). Owns the
 * bordered/rounded/muted surface only — each consumer owns its internal
 * padding and layout. The point of the primitive is so the whole stack stays
 * visually unified and a future "compact" stack treatment can plug in here.
 */
export function PromptStackCard({
  children,
  ariaLabel,
  className,
  style,
}: PromptStackCardProps) {
  if (ariaLabel) {
    return (
      <section
        aria-label={ariaLabel}
        className={cn(BASE_CHROME, className)}
        style={style}
      >
        {children}
      </section>
    );
  }
  return (
    <div className={cn(BASE_CHROME, className)} style={style}>
      {children}
    </div>
  );
}
