import { useState, type ReactNode, type Ref } from "react";
import { useIsSidebarShowing } from "@/components/ui/sidebar.js";
import {
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  COARSE_POINTER_HEADER_REDUCED_GLYPH_ICON_BUTTON_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  BROWSER_COLLAPSED_HEADER_RESERVE_CLASS,
  CHROME_ROW_CLASS,
  CHROME_ROW_HEIGHT_CLASS,
  getBbDesktopInfo,
  MACOS_CHROME_CONTROL_AXIS_CLASS,
  MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldReserveMacosTrafficLights,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { cn } from "@bb/shared-ui/lib/utils";

export const HEADER_ICON_BUTTON_CLASS = COARSE_POINTER_HEADER_ICON_BUTTON_CLASS;

export const HEADER_PANE_ACTION_ICON_BUTTON_CLASS =
  COARSE_POINTER_HEADER_REDUCED_GLYPH_ICON_BUTTON_CLASS;

export const HEADER_SEAM_CLASS = "border-b border-border-seam-vertical/60";

export const APP_PAGE_HEADER_SURFACE_CLASS = "bg-surface-scrim";

export const COMPACT_SHELF_HIDDEN_PAGE_HEADER_ACTIONS_CLASS =
  "group-data-[panel-shelf=open]/page-inset:invisible group-data-[panel-shelf=shelf]/page-inset:invisible";

interface AppPageHeaderProps {
  center?: ReactNode;
  actions?: ReactNode;
  className?: string;
  headerRef?: Ref<HTMLElement>;
  isWindowDragRegion?: boolean;
  ownsWindowTopLeft?: boolean;
}

export function AppPageHeader({
  center,
  actions,
  className,
  headerRef,
  isWindowDragRegion = true,
  ownsWindowTopLeft = true,
}: AppPageHeaderProps) {
  const isSidebarShowing = useIsSidebarShowing();
  const isCompactViewport = useIsCompactViewport();
  const [desktopInfo] = useState(getBbDesktopInfo);
  const desktopWindowState = useDesktopWindowState();
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const reserveMacosTrafficLights = shouldReserveMacosTrafficLights({
    desktopInfo,
    windowState: desktopWindowState,
  });
  const shouldReserveSidebarTrigger =
    ownsWindowTopLeft && (isCompactViewport || !isSidebarShowing);
  return (
    <header
      ref={headerRef}
      className={cn(
        CHROME_ROW_HEIGHT_CLASS,
        HEADER_SEAM_CLASS,
        APP_PAGE_HEADER_SURFACE_CLASS,
        "relative shrink-0 select-none px-4",
        usesDesktopChrome && isWindowDragRegion && MACOS_WINDOW_DRAG_CLASS,
        className,
      )}
    >
      <div
        data-testid="app-page-header-content-row"
        className={cn(
          CHROME_ROW_CLASS,
          "relative z-10 gap-1 md:gap-2",
          usesDesktopChrome && MACOS_CHROME_CONTROL_AXIS_CLASS,
          "transition-[padding] duration-200 ease-linear",
          shouldReserveSidebarTrigger &&
            (reserveMacosTrafficLights
              ? MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS
              : BROWSER_COLLAPSED_HEADER_RESERVE_CLASS),
        )}
      >
        {center ? (
          <div className="flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 max-w-full items-center gap-2">
              {center}
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        {actions ? (
          <div
            data-app-page-header-actions=""
            className={cn(
              "flex shrink-0 items-center gap-1",
              COMPACT_SHELF_HIDDEN_PAGE_HEADER_ACTIONS_CLASS,
              usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
