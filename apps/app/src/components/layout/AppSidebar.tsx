import { useCallback, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { Link, useLocation } from "react-router-dom";
import { Moon, Settings, Sun } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@bb/ui-core";
import { COARSE_POINTER_CHILD_ICON_BUTTON_CLASS } from "@bb/ui-core";
import { ProjectList } from "./ProjectList";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { setPreferredTheme, usePreferredTheme } from "@/hooks/useTheme";

interface AppSidebarProps {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
}

export function AppSidebar({ onResizeMouseDown, isResizing }: AppSidebarProps) {
  const quickCreateProject = useQuickCreateProjectController();
  const location = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  const theme = usePreferredTheme();
  const isMobileRef = useRef(isMobile);
  // Keep the ProjectList callback stable while reading the latest breakpoint.
  isMobileRef.current = isMobile;

  const closeOnMobile = useCallback(() => {
    if (isMobileRef.current) {
      setOpenMobile(false);
    }
  }, [setOpenMobile]);

  const isDarkTheme = theme === "dark";
  const toggleTheme = useCallback(() => {
    setPreferredTheme(isDarkTheme ? "light" : "dark");
  }, [isDarkTheme]);
  const selectedProjectId = useMemo(
    () => location.pathname.match(/^\/projects\/([^/]+)/)?.[1],
    [location.pathname],
  );

  return (
    <>
      <Sidebar>
        <SidebarContent>
          <ProjectList
            onNewProject={
              quickCreateProject.isAvailable
                ? quickCreateProject.openCreateDialog
                : undefined
            }
            onProjectSelect={closeOnMobile}
            selectedProjectId={selectedProjectId}
            isCreatingProject={quickCreateProject.isCreating}
          />
        </SidebarContent>
        <SidebarFooter overflowFadePlacement="above">
          <SidebarMenu className="flex-row items-center">
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={toggleTheme}
                className={COARSE_POINTER_CHILD_ICON_BUTTON_CLASS}
                tooltip={
                  isDarkTheme ? "Switch to light mode" : "Switch to dark mode"
                }
                aria-label={
                  isDarkTheme ? "Switch to light mode" : "Switch to dark mode"
                }
              >
                {isDarkTheme ? <Sun /> : <Moon />}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className={COARSE_POINTER_CHILD_ICON_BUTTON_CLASS}
                tooltip="App settings"
                aria-label="App settings"
              >
                <Link to="/settings">
                  <Settings />
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <div
          className={cn(
            "absolute -right-1.5 top-0 z-30 hidden h-full w-3 cursor-col-resize md:block",
            "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sidebar-border",
            "group-data-[collapsible=icon]:hidden",
            isResizing && "before:bg-sidebar-border",
          )}
          onMouseDown={onResizeMouseDown}
        />
      </Sidebar>
    </>
  );
}
