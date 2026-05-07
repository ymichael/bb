import type { ReactNode } from "react";
import {
  Archive,
  Bot,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Settings,
  Sparkles,
} from "lucide-react";
import {
  Sidebar,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
} from "./sidebar";

export default {
  title: "Primitives/Sidebar/Menu",
};

export function MenuRows() {
  return (
    <SidebarMenuFrame open>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton isActive tooltip="Current thread">
            <Sparkles />
            <span>UI consolidation</span>
          </SidebarMenuButton>
          <SidebarMenuBadge>4</SidebarMenuBadge>
          <SidebarMenuAction aria-label="Thread actions" showOnHover>
            <MoreHorizontal />
          </SidebarMenuAction>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton variant="outline">
            <FolderOpen />
            <span>Workspace browser</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton size="sm">
            <Archive />
            <span>Archived threads</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg">
            <Bot />
            <span>Manager thread</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton disabled>
            <Settings />
            <span>Settings unavailable</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarMenuFrame>
  );
}

export function WithSubMenu() {
  return (
    <SidebarMenuFrame open>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton isActive>
            <FolderOpen />
            <span>bb</span>
          </SidebarMenuButton>
          <SidebarMenuSub>
            <SidebarMenuSubItem>
              <SidebarMenuSubButton href="#" isActive>
                <span>Active threads</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
            <SidebarMenuSubItem>
              <SidebarMenuSubButton href="#" size="sm">
                <span>Replay fixtures</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
            <SidebarMenuSubItem>
              <SidebarMenuSubButton href="#">
                <Plus />
                <span>New thread</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          </SidebarMenuSub>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarMenuFrame>
  );
}

export function LoadingRows() {
  return (
    <SidebarMenuFrame open>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuSkeleton />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarMenuFrame>
  );
}

export function CollapsedIcons() {
  return (
    <SidebarMenuFrame open={false}>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="UI consolidation" isActive>
            <Sparkles />
            <span>UI consolidation</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="Workspace browser">
            <FolderOpen />
            <span>Workspace browser</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="Manager thread">
            <Bot />
            <span>Manager thread</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarMenuFrame>
  );
}

interface SidebarMenuFrameProps {
  children: ReactNode;
  open: boolean;
}

function SidebarMenuFrame({ children, open }: SidebarMenuFrameProps) {
  return (
    <div className="h-[30rem] overflow-hidden rounded-md border border-border">
      <SidebarProvider open={open}>
        <Sidebar collapsible="icon" className="border-r border-sidebar-border">
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
            {children}
          </div>
        </Sidebar>
        <div className="flex min-w-0 flex-1 bg-background p-6">
          <div className="h-20 flex-1 rounded-md border border-border bg-card" />
        </div>
      </SidebarProvider>
    </div>
  );
}
