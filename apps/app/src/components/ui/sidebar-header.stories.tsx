import type { ReactNode } from "react";
import { Bot, FolderOpen, Search } from "lucide-react";
import {
  Sidebar,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarStickyStack,
  SidebarStickyTier,
  SidebarTrigger,
} from "./sidebar";
import { StatusPill } from "./status-pill";

export default {
  title: "Primitives/Sidebar/Header",
};

export function ExpandedHeader() {
  return (
    <SidebarFrame open>
      <SidebarHeader className="gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">bb workspace</p>
            <p className="truncate text-xs text-sidebar-foreground/70">
              /Users/michael/src/bb
            </p>
          </div>
          <SidebarTrigger />
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-sidebar-foreground/60" />
          <SidebarInput className="pl-8" placeholder="Search threads" />
        </div>
        <SidebarStickyStack>
          <SidebarStickyTier
            tier="label"
            className="flex h-8 items-center gap-2 px-2"
          >
            Workspace
          </SidebarStickyTier>
          <SidebarStickyTier
            tier="project"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
          >
            <FolderOpen className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">bb</span>
            <StatusPill variant="emphasis">Local</StatusPill>
          </SidebarStickyTier>
          <SidebarStickyTier
            tier="manager"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80"
          >
            <Bot className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Manager enabled</span>
          </SidebarStickyTier>
        </SidebarStickyStack>
      </SidebarHeader>
    </SidebarFrame>
  );
}

export function CollapsedHeader() {
  return (
    <SidebarFrame open={false}>
      <SidebarHeader>
        <SidebarTrigger />
        <SidebarStickyStack>
          <SidebarStickyTier
            tier="project"
            className="flex items-center justify-center rounded-md p-2"
          >
            <FolderOpen className="size-4" />
          </SidebarStickyTier>
          <SidebarStickyTier
            tier="manager"
            className="flex items-center justify-center rounded-md p-2"
          >
            <Bot className="size-4" />
          </SidebarStickyTier>
        </SidebarStickyStack>
      </SidebarHeader>
    </SidebarFrame>
  );
}

interface SidebarFrameProps {
  children: ReactNode;
  open: boolean;
}

function SidebarFrame({ children, open }: SidebarFrameProps) {
  return (
    <div className="h-[30rem] overflow-hidden rounded-md border border-border">
      <SidebarProvider open={open}>
        <Sidebar collapsible="icon">
          {children}
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <div className="flex h-full min-h-0 flex-col bg-background p-6">
            <div className="rounded-md border border-border bg-card p-4 text-sm">
              Thread detail
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
