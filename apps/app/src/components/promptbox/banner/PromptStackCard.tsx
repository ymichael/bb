import { type CSSProperties, type ReactNode, type Ref } from "react";
import { cn } from "@bb/shared-ui/lib/utils";

export const PROMPT_STACK_CARD_ROW_HEIGHT = 32;
const PROMPT_STACK_CARD_RADIUS_CLASS = "rounded-lg";
const PROMPT_STACK_INLAY_RADIUS_CLASS = "rounded";
export const PROMPT_STACK_INLAY_INSET_CLASS = "p-1";
export const PROMPT_STACK_INLAY_SEGMENT_CLASS = cn(
  "min-h-6 px-2 py-1",
  PROMPT_STACK_INLAY_RADIUS_CLASS,
);
export const PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS = "w-6 px-0";
const BASE_CHROME = cn(
  PROMPT_STACK_CARD_RADIUS_CLASS,
  "border border-border bg-surface-raised-solid",
);

/**
 * The track the stack itself lays cards on.
 *
 * A bare `grid gap-2` drops every card into an implicit `auto` column, and an
 * auto column's base size is the widest card's MIN-CONTENT width. That is not
 * the width the card renders at: a row built as `min-w-0 flex-1 truncate`
 * still reports its full untruncated string as its min-content contribution,
 * because the truncation only bites once the parent hands it a definite width.
 * So one long queued message — or one plugin banner with a long rule in it —
 * sized the column at ~1350px inside a 370px composer, and every other card
 * stretched to match and left the viewport with it.
 *
 * `minmax(0, 1fr)` pins the track to the shell's width instead. Each card then
 * gets a definite width and its own truncation does the rest.
 */
export const PROMPT_STACK_TRACK_CLASS = "grid-cols-[minmax(0,1fr)]";

export interface PromptStackCardProps {
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
  rootRef?: Ref<HTMLElement>;
  style?: CSSProperties;
}

export function PromptStackCard({
  children,
  ariaLabel,
  className,
  rootRef,
  style,
}: PromptStackCardProps) {
  if (ariaLabel) {
    return (
      <section
        ref={rootRef}
        aria-label={ariaLabel}
        className={cn(BASE_CHROME, className)}
        style={style}
      >
        {children}
      </section>
    );
  }
  return (
    <div
      ref={rootRef as Ref<HTMLDivElement>}
      className={cn(BASE_CHROME, className)}
      style={style}
    >
      {children}
    </div>
  );
}
