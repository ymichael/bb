import type { ReactNode } from "react";
import { BottomAnchoredScrollBody } from "./bottom-anchored-scroll-body.js";
import { PAGE_SHELL_CONTENT_STYLE } from "./page-shell-content-style.js";
import { cn } from "@bb/shared-ui/lib/utils";
import { OverflowFade } from "./overflow-fade.js";

type PageShellScrollBehavior = "bottom-anchor" | "static";

interface PageShellBaseProps {
  children: ReactNode;
  footer?: ReactNode;
  scrollOverlay?: ReactNode;
  shellClassName?: string;
  scrollAreaClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  maxWidthClassName?: string;
}

interface PageShellProps extends PageShellBaseProps {
  scrollBehavior?: PageShellScrollBehavior;
  scrollAnchorThreadId?: string;
}

interface FooterRenderOptions {
  maxWidthClassName: string;
  footerClassName?: string;
}

const SHELL_BLEED_CLASS =
  "-mx-4 -mt-4 flex h-full min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5";
const DEFAULT_MAX_WIDTH_CLASS = "max-w-[760px]";

function renderStaticFooter(
  footer: ReactNode,
  { maxWidthClassName, footerClassName }: FooterRenderOptions,
) {
  if (!footer) return null;
  return (
    <div className="relative shrink-0 bg-background">
      <OverflowFade placement="above" tone="background" />
      <div
        className={cn(
          "mx-auto w-full px-4 pb-4",
          maxWidthClassName,
          footerClassName,
        )}
      >
        {footer}
      </div>
    </div>
  );
}

export function PageShell({
  children,
  footer,
  scrollOverlay,
  shellClassName,
  scrollAreaClassName,
  contentClassName,
  footerClassName,
  maxWidthClassName = DEFAULT_MAX_WIDTH_CLASS,
  scrollBehavior = "static",
  scrollAnchorThreadId,
}: PageShellProps) {
  const staticFooter = renderStaticFooter(footer, {
    maxWidthClassName,
    footerClassName,
  });

  if (scrollBehavior === "bottom-anchor") {
    return (
      <div className={cn(SHELL_BLEED_CLASS, shellClassName)}>
        <BottomAnchoredScrollBody
          scrollAreaClassName={scrollAreaClassName}
          contentClassName={contentClassName}
          maxWidthClassName={maxWidthClassName}
          footer={staticFooter}
          scrollOverlay={scrollOverlay}
          scrollAnchorThreadId={scrollAnchorThreadId}
        >
          {children}
        </BottomAnchoredScrollBody>
      </div>
    );
  }

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
            style={PAGE_SHELL_CONTENT_STYLE}
          >
            {children}
          </div>
        </div>
        {staticFooter}
      </div>
    </div>
  );
}
