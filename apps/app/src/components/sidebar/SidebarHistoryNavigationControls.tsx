import { useCallback } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { useRouteStateHistoryNavigation } from "@/lib/app-route-history";

interface SidebarHistoryNavigationControlsProps {
  onNavigate?: () => void;
  className?: string;
}

interface SidebarHistoryNavButtonProps {
  icon: IconName;
  label: string;
  disabled: boolean;
  onClick: () => void;
}

const SIDEBAR_HISTORY_NAV_BUTTON_CLASS = cn(
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  "text-muted-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2",
);

function SidebarHistoryNavButton({
  icon,
  label,
  disabled,
  onClick,
}: SidebarHistoryNavButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={SIDEBAR_HISTORY_NAV_BUTTON_CLASS}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      <Icon name={icon} aria-hidden />
    </Button>
  );
}

export function SidebarHistoryNavigationControls({
  onNavigate,
  className,
}: SidebarHistoryNavigationControlsProps) {
  const { canGoBack, canGoForward, goBack, goForward } =
    useRouteStateHistoryNavigation();

  const handleBack = useCallback(() => {
    if (!canGoBack) {
      return;
    }
    goBack();
    onNavigate?.();
  }, [canGoBack, goBack, onNavigate]);

  const handleForward = useCallback(() => {
    if (!canGoForward) {
      return;
    }
    goForward();
    onNavigate?.();
  }, [canGoForward, goForward, onNavigate]);

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <SidebarHistoryNavButton
        icon="ChevronLeft"
        label="Go back"
        disabled={!canGoBack}
        onClick={handleBack}
      />
      <SidebarHistoryNavButton
        icon="ChevronRight"
        label="Go forward"
        disabled={!canGoForward}
        onClick={handleForward}
      />
    </div>
  );
}
