import type { ReactNode } from "react";
import { Bell, Plus, Server, UserCircle } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarProvider,
  SidebarSeparator,
} from "./sidebar";
import { StatusPill } from "./status-pill";

export default {
  title: "Primitives/Sidebar/Groups",
};

export function GroupsAndFooter() {
  return (
    <SidebarGroupFrame open>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupAction aria-label="New project">
            <Plus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <GroupRow label="bb" meta="local" />
            <GroupRow label="agent fixtures" meta="fixtures" />
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>Hosts</SidebarGroupLabel>
          <SidebarGroupContent>
            <GroupRow
              icon={<Server className="size-4 shrink-0" />}
              label="Michael's MacBook Pro"
            >
              <StatusPill variant="emphasis">Connected</StatusPill>
            </GroupRow>
            <GroupRow
              icon={<Server className="size-4 shrink-0" />}
              label="Build runner"
            >
              <StatusPill variant="outline">Offline</StatusPill>
            </GroupRow>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarSeparator />
        <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
          <UserCircle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Michael</span>
          <Bell className="size-4 text-sidebar-foreground/60" />
        </div>
      </SidebarFooter>
    </SidebarGroupFrame>
  );
}

export function CollapsedGroups() {
  return (
    <SidebarGroupFrame open={false}>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <GroupRow label="bb" meta="local" />
            <GroupRow label="agent fixtures" meta="fixtures" />
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>Hosts</SidebarGroupLabel>
          <SidebarGroupContent>
            <GroupRow
              icon={<Server className="size-4 shrink-0" />}
              label="Michael's MacBook Pro"
            />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex justify-center rounded-md p-2">
          <UserCircle className="size-4" />
        </div>
      </SidebarFooter>
    </SidebarGroupFrame>
  );
}

interface SidebarGroupFrameProps {
  children: ReactNode;
  open: boolean;
}

function SidebarGroupFrame({ children, open }: SidebarGroupFrameProps) {
  return (
    <div className="h-[30rem] overflow-hidden rounded-md border border-border">
      <SidebarProvider open={open}>
        <Sidebar collapsible="icon" className="border-r border-sidebar-border">
          {children}
        </Sidebar>
        <div className="flex min-w-0 flex-1 bg-background p-6">
          <div className="h-20 flex-1 rounded-md border border-border bg-card" />
        </div>
      </SidebarProvider>
    </div>
  );
}

interface GroupRowProps {
  children?: ReactNode;
  icon?: ReactNode;
  label: string;
  meta?: string;
}

function GroupRow({ children, icon, label, meta }: GroupRowProps) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/90">
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? (
        <span className="text-xs text-sidebar-foreground/60">{meta}</span>
      ) : null}
      {children}
    </div>
  );
}
