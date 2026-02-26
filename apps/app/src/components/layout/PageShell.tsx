import type { ReactNode, Ref, UIEventHandler } from "react";
import { cn } from "@/lib/utils";

interface PageShellProps {
  children: ReactNode;
  footer?: ReactNode;
  shellClassName?: string;
  scrollAreaClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  maxWidthClassName?: string;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  footerUsesPromptPadding?: boolean;
}

const SHELL_BLEED_CLASS =
  "-mx-4 -mt-4 flex h-full min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5";
const DEFAULT_MAX_WIDTH_CLASS = "max-w-[800px]";

export function PageShell({
  children,
  footer,
  shellClassName,
  scrollAreaClassName,
  contentClassName,
  footerClassName,
  maxWidthClassName = DEFAULT_MAX_WIDTH_CLASS,
  scrollRef,
  onScroll,
  footerUsesPromptPadding = false,
}: PageShellProps) {
  return (
    <div className={cn(SHELL_BLEED_CLASS, shellClassName)}>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cn("min-h-0 flex-1 overflow-y-auto", scrollAreaClassName)}
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

        {footer ? (
          <div className="shrink-0">
            <div
              className={cn(
                "mx-auto w-full bg-background px-4 pb-4 pt-2",
                maxWidthClassName,
                footerUsesPromptPadding && "chat-prompt-box",
                footerClassName,
              )}
            >
              {footer}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
