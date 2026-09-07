import type { MouseEvent as ReactMouseEvent } from "react";
import { useLocation } from "react-router-dom";
import {
  SectionSidebar,
  SectionSidebarIcon,
  SectionSidebarLabel,
  SectionSidebarRow,
} from "@/components/sidebar/SectionSidebar";
import {
  resolveToolsActivePage,
  TOOLS_NAV_ITEMS,
  TOOLS_PAGES,
} from "./tools-navigation";

export function ToolsSidebar({
  appRoutePath,
  isResizing,
  mobileHosted,
  onResizeMouseDown,
  showTopReserve,
}: {
  appRoutePath: string;
  isResizing: boolean;
  mobileHosted?: boolean;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  showTopReserve: boolean;
}) {
  const location = useLocation();
  const activePage = resolveToolsActivePage(location.pathname, location.search);

  return (
    <SectionSidebar
      backLabel="Back to app"
      backTo={appRoutePath}
      isResizing={isResizing}
      mobileHosted={mobileHosted}
      onResizeMouseDown={onResizeMouseDown}
      showTopReserve={showTopReserve}
      testIdPrefix="tools"
    >
      {TOOLS_NAV_ITEMS.map((section, index) => (
        <div key={section.id} className={index > 0 ? "mt-4" : undefined}>
          <SectionSidebarLabel>{section.label}</SectionSidebarLabel>
          <div className="mt-1 space-y-0.5">
            {TOOLS_PAGES.filter((page) => page.section === section.id).map(
              (page) => (
                <SectionSidebarRow
                  key={page.id}
                  active={activePage === page.id}
                  label={page.label}
                  to={page.to}
                >
                  <SectionSidebarIcon name={page.icon} />
                </SectionSidebarRow>
              ),
            )}
          </div>
        </div>
      ))}
    </SectionSidebar>
  );
}
