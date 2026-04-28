// Stick-to-bottom behavior is owned by the `use-stick-to-bottom` library. Do
// not reintroduce custom ResizeObserver / MutationObserver / scroll-reconcile
// machinery here. Past regressions: see git log --grep=scroll before
// 2026-04-22.
//
// Browser scroll-anchoring is left on (default `overflow-anchor: auto`) on
// the scroll container and on every timeline row. When the user is scrolled
// up, the browser pins to a candidate row so the reading position survives
// column reflow. When the user is at the bottom, the library's own
// `scrollToBottom` keeps the bottom pinned; with the markdown renderer
// memoized (see `ConversationMarkdown`), the per-frame render cost is
// small enough that the library's rAF-driven catch-up is not visible.
// Do not reintroduce inline `style={{ overflowAnchor: "none" }}` on
// individual timeline rows or on the scroll container — that disables
// browser anchoring while scrolled up and the reading-position drift
// returns.
import type { ReactNode } from "react";
import { StickToBottom, type StickToBottomContext } from "use-stick-to-bottom";
import { cn } from "@/lib/utils";

interface PageShellBaseProps {
  children: ReactNode;
  footer?: ReactNode;
  shellClassName?: string;
  scrollAreaClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  maxWidthClassName?: string;
  footerUsesPromptPadding?: boolean;
}

interface PageShellProps extends PageShellBaseProps {
  scrollBehavior?: "static" | "stick-to-bottom";
}

const SHELL_BLEED_CLASS =
  "-mx-4 -mt-4 flex h-full min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5";
const DEFAULT_MAX_WIDTH_CLASS = "max-w-[760px]";

function renderStaticFooter(
  footer: ReactNode,
  {
    maxWidthClassName,
    footerUsesPromptPadding,
    footerClassName,
  }: {
    maxWidthClassName: string;
    footerUsesPromptPadding: boolean;
    footerClassName?: string;
  },
) {
  if (!footer) return null;
  return (
    <div className="relative shrink-0">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-b from-transparent to-background"
      />
      <div
        className={cn(
          "mx-auto w-full bg-background px-4 pb-4",
          maxWidthClassName,
          footerUsesPromptPadding && "chat-prompt-box",
          footerClassName,
        )}
      >
        {footer}
      </div>
    </div>
  );
}

// Footer lives inside the scroll content (as the last child of contentRef) so
// the library's existing ResizeObserver picks up footer height changes (e.g.
// the prompt's git status banner resolving) and re-sticks. `position: sticky`
// pins it to the bottom of the viewport visually.
function renderStickyFooter(
  footer: ReactNode,
  {
    footerUsesPromptPadding,
    footerClassName,
  }: {
    footerUsesPromptPadding: boolean;
    footerClassName?: string;
  },
) {
  if (!footer) return null;
  return (
    <div
      className={cn(
        "sticky bottom-0 -mx-4 mt-6 bg-background px-4 pb-4",
        footerUsesPromptPadding && "chat-prompt-box",
        footerClassName,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-b from-transparent to-background"
      />
      {footer}
    </div>
  );
}

interface StickyScrollAreaProps {
  ctx: StickToBottomContext;
  scrollAreaClassName?: string;
  contentClassName?: string;
  maxWidthClassName: string;
  stickyFooter: ReactNode;
  children: ReactNode;
}

function StickyScrollArea({
  ctx,
  scrollAreaClassName,
  contentClassName,
  maxWidthClassName,
  stickyFooter,
  children,
}: StickyScrollAreaProps) {
  return (
    <div
      ref={ctx.scrollRef}
      className={cn(
        "@container/page min-h-0 flex-1 overflow-y-auto",
        scrollAreaClassName,
      )}
    >
      <div
        ref={ctx.contentRef}
        className={cn(
          "mx-auto flex w-full flex-col px-4 pt-2",
          maxWidthClassName,
          contentClassName,
        )}
      >
        {children}
        {stickyFooter}
      </div>
    </div>
  );
}

export function PageShell({
  children,
  footer,
  shellClassName,
  scrollAreaClassName,
  contentClassName,
  footerClassName,
  maxWidthClassName = DEFAULT_MAX_WIDTH_CLASS,
  footerUsesPromptPadding = false,
  scrollBehavior = "static",
}: PageShellProps) {
  if (scrollBehavior === "stick-to-bottom") {
    const stickyFooter = renderStickyFooter(footer, {
      footerUsesPromptPadding,
      footerClassName,
    });
    return (
      <StickToBottom
        initial="instant"
        resize="instant"
        className={cn(SHELL_BLEED_CLASS, shellClassName)}
      >
        {(ctx: StickToBottomContext) => (
          <StickyScrollArea
            ctx={ctx}
            scrollAreaClassName={scrollAreaClassName}
            contentClassName={contentClassName}
            maxWidthClassName={maxWidthClassName}
            stickyFooter={stickyFooter}
          >
            {children}
          </StickyScrollArea>
        )}
      </StickToBottom>
    );
  }

  const staticFooter = renderStaticFooter(footer, {
    maxWidthClassName,
    footerUsesPromptPadding,
    footerClassName,
  });
  return (
    <div className={cn(SHELL_BLEED_CLASS, shellClassName)}>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className={cn(
            "@container/page min-h-0 flex-1 overflow-y-auto",
            scrollAreaClassName,
          )}
        >
          <div
            className={cn(
              "mx-auto flex w-full flex-col px-4 pb-4 pt-2",
              maxWidthClassName,
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>
        {staticFooter}
      </div>
    </div>
  );
}
