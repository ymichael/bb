import {
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  Sidebar,
  SidebarContent,
  useCloseMobileSidebar,
} from "@/components/ui/sidebar.js";
import { SidebarHistoryNavigationControls } from "@/components/sidebar/SidebarHistoryNavigationControls";
import { PROJECT_LIST_ACTION_BUTTON_CLASS } from "@/components/sidebar/ProjectList";
import { SIDEBAR_STANDARD_ROW_PADDING_CLASS } from "@/components/sidebar/sidebarRowClasses";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import {
  CHROME_ROW_CLASS,
  getBbDesktopInfo,
  MACOS_CHROME_CONTROL_NO_DRAG_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";

export function SectionSidebarIcon({ name }: { name: IconName }) {
  return <Icon name={name} className={COARSE_POINTER_ICON_SIZE_CLASS} />;
}

export function SectionSidebarRow({
  active,
  children,
  label,
  to,
}: {
  active: boolean;
  children: ReactNode;
  label: string;
  to: string;
}) {
  const closeOnMobile = useCloseMobileSidebar();
  return (
    <Button
      asChild
      size="sm"
      variant="ghost"
      className={cn(
        PROJECT_LIST_ACTION_BUTTON_CLASS,
        "w-full",
        active && "bg-sidebar-accent text-sidebar-foreground",
      )}
    >
      <Link
        to={to}
        onClick={closeOnMobile}
        aria-current={active ? "page" : undefined}
      >
        {children}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </Link>
    </Button>
  );
}

export function SectionSidebarActionRow({
  children,
  label,
  onClick,
  testId,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  const closeOnMobile = useCloseMobileSidebar();
  return (
    <Button
      size="sm"
      variant="ghost"
      data-testid={testId}
      className={cn(PROJECT_LIST_ACTION_BUTTON_CLASS, "w-full")}
      onClick={() => {
        closeOnMobile();
        onClick();
      }}
    >
      {children}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </Button>
  );
}

export function SectionSidebarDisclosureRow({
  expanded,
  label,
  onToggle,
}: {
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-expanded={expanded}
      className={cn(
        PROJECT_LIST_ACTION_BUTTON_CLASS,
        "w-full text-subtle-foreground/75",
      )}
      onClick={onToggle}
    >
      <Icon
        name="ChevronRight"
        className={cn(
          "size-3 shrink-0 transition-transform duration-150",
          expanded && "rotate-90",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </Button>
  );
}

export function SectionSidebarLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        CHROME_SECTION_LABEL_CLASS,
        SIDEBAR_STANDARD_ROW_PADDING_CLASS,
      )}
    >
      {children}
    </div>
  );
}

export function SectionSidebar({
  backLabel,
  backTo,
  children,
  isResizing,
  mobileHosted = false,
  onResizeMouseDown,
  showTopReserve,
  testIdPrefix,
}: {
  backLabel: string;
  backTo: string;
  children: ReactNode;
  isResizing: boolean;
  mobileHosted?: boolean;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  showTopReserve: boolean;
  testIdPrefix: string;
}) {
  const closeOnMobile = useCloseMobileSidebar();
  const [desktopInfo] = useState(getBbDesktopInfo);
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);

  const body = (
    <>
      {showTopReserve ? (
        <div
          data-testid={`${testIdPrefix}-sidebar-top-reserve-row`}
          className={cn(
            CHROME_ROW_CLASS,
            "shrink-0 justify-end px-2",
            usesDesktopChrome && MACOS_WINDOW_DRAG_CLASS,
          )}
        >
          <SidebarHistoryNavigationControls
            onNavigate={closeOnMobile}
            className={cn(
              "group-data-[collapsible=icon]:hidden",
              usesDesktopChrome && MACOS_CHROME_CONTROL_NO_DRAG_CLASS,
            )}
          />
        </div>
      ) : null}
      <div className="shrink-0 px-2 py-2 group-data-[collapsible=icon]:hidden">
        <div className="space-y-1">
          <SectionSidebarRow active={false} label={backLabel} to={backTo}>
            <SectionSidebarIcon name="ChevronLeft" />
          </SectionSidebarRow>
        </div>
      </div>
      <SidebarContent>
        <div className="min-w-0 px-2 group-data-[collapsible=icon]:hidden">
          {children}
        </div>
      </SidebarContent>
      <div
        data-testid={`${testIdPrefix}-sidebar-resize-handle`}
        className={cn(
          "absolute -right-1.5 top-0 z-30 hidden h-full w-3 cursor-col-resize md:block",
          "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sidebar-border",
          "group-data-[collapsible=icon]:hidden",
          isResizing && "before:bg-sidebar-border",
        )}
        onMouseDown={onResizeMouseDown}
      />
    </>
  );

  if (mobileHosted) {
    return (
      <div
        data-testid={`${testIdPrefix}-sidebar-body`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {body}
      </div>
    );
  }

  return <Sidebar>{body}</Sidebar>;
}
