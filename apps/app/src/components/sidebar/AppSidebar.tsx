import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { Link, useNavigate } from "react-router-dom";
import { Settings } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui";
import { COARSE_POINTER_CHILD_ICON_BUTTON_CLASS } from "@/components/ui";
import { ProjectList } from "./ProjectList";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";

interface AppSidebarProps {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  selectedProjectId?: string;
  isManagerActionPending?: boolean;
  onNewManager?: (projectId: string) => void;
}

export function AppSidebar({
  onResizeMouseDown,
  isResizing,
  selectedProjectId,
  isManagerActionPending = false,
  onNewManager,
}: AppSidebarProps) {
  const quickCreateProject = useQuickCreateProjectController();
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
      if (!onNewManager) return;
      closeOnMobile();
      onNewManager(managerProjectId);
    },
    [closeOnMobile, onNewManager],
  );

  const newChatAction = selectedProjectId ? handleNewChat : undefined;
  const newManagerAction =
    selectedProjectId && onNewManager ? handleNewManager : undefined;

  return (
    <>
      <Sidebar>
        <SidebarContent>
          <ProjectList
            onNewChat={newChatAction}
            onNewManager={newManagerAction}
            onNewProject={
              quickCreateProject.isAvailable
                ? quickCreateProject.openCreateDialog
                : undefined
            }
            onProjectSelect={closeOnMobile}
            selectedProjectId={selectedProjectId}
            isCreatingProject={quickCreateProject.isCreating}
            isManagerActionPending={isManagerActionPending}
          />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu className="flex-row items-center">
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
