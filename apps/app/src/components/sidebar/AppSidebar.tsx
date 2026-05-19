import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "@/components/ui/icon.js";
import { OverflowFade } from "@/components/ui/overflow-fade.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar.js";
import { COARSE_POINTER_CHILD_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing.js";
import { ProjectList, ProjectListActionButtons } from "./ProjectList";
import { useNewManagerDialog } from "@/hooks/useNewManagerDialog";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";

interface AppSidebarProps {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  selectedProjectId?: string;
  isManagerActionPending?: boolean;
}

export function AppSidebar({
  onResizeMouseDown,
  isResizing,
  selectedProjectId,
  isManagerActionPending = false,
}: AppSidebarProps) {
  const quickCreateProject = useQuickCreateProjectController();
  const newManagerDialog = useNewManagerDialog();
  const navigate = useNavigate();
  const { isCompactViewport, setOpenMobile } = useSidebar();
  const isCompactViewportRef = useRef(isCompactViewport);
  // Keep the ProjectList callback stable while reading the latest breakpoint.
  isCompactViewportRef.current = isCompactViewport;

  const closeOnMobile = useCallback(() => {
    if (isCompactViewportRef.current) {
      setOpenMobile(false);
    }
  }, [setOpenMobile]);

  const handleNewChat = useCallback(() => {
    if (!selectedProjectId) return;
    closeOnMobile();
    void navigate(`/projects/${selectedProjectId}`);
  }, [closeOnMobile, navigate, selectedProjectId]);

  const handleNewManager = useCallback(
    (managerProjectId: string) => {
      closeOnMobile();
      newManagerDialog.open(managerProjectId);
    },
    [closeOnMobile, newManagerDialog],
  );

  const newChatAction = selectedProjectId ? handleNewChat : undefined;
  const newManagerAction = selectedProjectId ? handleNewManager : undefined;

  return (
    <>
      <Sidebar>
        {/* Matches the page-header height so the sidebar's top region mirrors
            the chrome on the right of the sidebar. */}
        <div className="flex h-12 shrink-0 items-center px-2">
          <SidebarTrigger />
        </div>
        <div className="shrink-0 px-2 py-2 group-data-[collapsible=icon]:hidden">
          <ProjectListActionButtons
            onNewChat={newChatAction}
            onNewManager={newManagerAction}
            selectedProjectId={selectedProjectId}
            isManagerActionPending={isManagerActionPending}
          />
        </div>
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
        <SidebarFooter className="relative">
          <OverflowFade placement="above" tone="sidebar" size="sm" />
          <SidebarMenu className="flex-row items-center">
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className={COARSE_POINTER_CHILD_ICON_BUTTON_CLASS}
                tooltip="App settings"
                aria-label="App settings"
              >
                <Link to="/settings">
                  <Icon name="Settings" />
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
