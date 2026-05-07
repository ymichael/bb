import type { ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Shared sizing for icon-only header action buttons (sidebar trigger, kebab
 * menu, secondary-panel toggle, etc.). Keeps button dimensions and SVG sizing
 * consistent across coarse touch and desktop contexts.
 */
export const HEADER_ICON_BUTTON_CLASS = COARSE_POINTER_HEADER_ICON_BUTTON_CLASS;

interface AppPageHeaderProps {
  center?: ReactNode;
  actions?: ReactNode;
  bordered?: boolean;
  className?: string;
}

export function AppPageHeader({
  center,
  actions,
  bordered = true,
  className,
}: AppPageHeaderProps) {
  return (
    <header
      className={cn(
        "relative h-12 shrink-0 bg-background/95 px-4 backdrop-blur-sm",
        bordered && "border-b border-border/80",
        className,
      )}
    >
      <div className="flex h-full items-center gap-1 md:gap-2">
        <SidebarTrigger className="-ml-2 shrink-0 md:ml-0" />
        {center ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">{center}</div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        {actions ? (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
