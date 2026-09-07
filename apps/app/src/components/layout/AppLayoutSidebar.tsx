import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import { ToolsSidebar } from "@/components/tools/ToolsSidebar";
import { Sidebar, useSidebar } from "@/components/ui/sidebar.js";

export type AppLayoutSidebarMode = "app" | "settings" | "tools";

interface AppLayoutSidebarProps {
  mode: AppLayoutSidebarMode;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  appRoutePath: string;
  settingsRoutePath: string;
  toolsBackRoutePath: string;
  toolsRoutePath?: string;
}

export function AppLayoutSidebar({
  mode,
  onResizeMouseDown,
  isResizing,
  appRoutePath,
  settingsRoutePath,
  toolsBackRoutePath,
  toolsRoutePath,
}: AppLayoutSidebarProps) {
  const { isCompactViewport, isMobileSidebarClosing } = useSidebar();
  const holdCurrentMode = isCompactViewport && isMobileSidebarClosing;
  const [lastVisibleMode, setLastVisibleMode] = useState(mode);
  if (!holdCurrentMode && lastVisibleMode !== mode) {
    setLastVisibleMode(mode);
  }
  const renderedMode = holdCurrentMode ? lastVisibleMode : mode;

  if (isCompactViewport) {
    return (
      <Sidebar>
        <AppSidebar
          onResizeMouseDown={onResizeMouseDown}
          isResizing={isResizing}
          showTopReserve={true}
          settingsRoutePath={settingsRoutePath}
          toolsRoutePath={toolsRoutePath}
          mobileHosted={{ hidden: renderedMode !== "app" }}
        />
        {renderedMode === "settings" ? (
          <SettingsSidebar
            onResizeMouseDown={onResizeMouseDown}
            isResizing={isResizing}
            showTopReserve={true}
            appRoutePath={appRoutePath}
            mobileHosted
          />
        ) : null}
        {renderedMode === "tools" ? (
          <ToolsSidebar
            onResizeMouseDown={onResizeMouseDown}
            isResizing={isResizing}
            showTopReserve={true}
            appRoutePath={toolsBackRoutePath}
            mobileHosted
          />
        ) : null}
      </Sidebar>
    );
  }

  if (renderedMode === "settings") {
    return (
      <SettingsSidebar
        onResizeMouseDown={onResizeMouseDown}
        isResizing={isResizing}
        showTopReserve={true}
        appRoutePath={appRoutePath}
      />
    );
  }

  if (renderedMode === "tools") {
    return (
      <ToolsSidebar
        onResizeMouseDown={onResizeMouseDown}
        isResizing={isResizing}
        showTopReserve={true}
        appRoutePath={toolsBackRoutePath}
      />
    );
  }

  return (
    <AppSidebar
      onResizeMouseDown={onResizeMouseDown}
      isResizing={isResizing}
      showTopReserve={true}
      settingsRoutePath={settingsRoutePath}
      toolsRoutePath={toolsRoutePath}
    />
  );
}
