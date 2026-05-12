import { useMemo } from "react";
import type { ThreadListEntry } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import { AlertTriangle, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { NavLink } from "react-router-dom";
import { EmptyState, SidebarStickyTier } from "@/components/ui";
import {
  ProjectActionsContextMenu,
  ProjectActionsMenu,
} from "@/components/project/ProjectActionsMenu";
import { SidebarMenuItem, SidebarMenuSkeleton } from "@/components/ui";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_PROJECT_ROW_ACTION_SIZE_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { ThreadRow } from "./ThreadRow";
import { buildProjectThreadGroups } from "./projectThreadGroups";

export type ProjectThreadListState =
  | {
      status: "loading";
    }
  | {
      status: "ready";
      threads: ThreadListEntry[];
    }
  | {
      status: "unavailable";
    };

interface ProjectRowProps {
  project: ProjectResponse;
  threadListState: ProjectThreadListState;
  selectedThreadId?: string;
  isActive: boolean;
  isCollapsed: boolean;
  collapsedManagerIds: Set<string>;
  isLocalPathInvalid: boolean;
  localHostId: string | null;
  onProjectSelect?: () => void;
  onToggleProjectCollapsed: (projectId: string) => void;
  onToggleManagerCollapsed: (threadId: string) => void;
  promotedBranchName: string | null;
}

const EMPTY_PROJECT_THREADS: ThreadListEntry[] = [];

export function ProjectRow({
  project,
  threadListState,
  selectedThreadId,
  isActive,
  isCollapsed,
  collapsedManagerIds,
  isLocalPathInvalid,
  localHostId,
  onProjectSelect,
  onToggleProjectCollapsed,
  onToggleManagerCollapsed,
  promotedBranchName,
}: ProjectRowProps) {
  const projectThreads =
    threadListState.status === "ready"
      ? threadListState.threads
      : EMPTY_PROJECT_THREADS;
  const { managerThreadGroups, unmanagedStandardThreads } = useMemo(
    () => buildProjectThreadGroups(projectThreads),
    [projectThreads],
  );
  const isThreadPromoted = (thread: ThreadListEntry) =>
    localHostId !== null &&
    promotedBranchName !== null &&
    thread.environmentHostId === localHostId &&
    thread.environmentBranchName === promotedBranchName &&
    thread.environmentWorkspaceDisplayKind !== "other";

  return (
    <SidebarMenuItem data-sidebar-sticky-project-item="">
      <ProjectActionsContextMenu project={project}>
        <SidebarStickyTier
          tier="project"
          className={cn(
            "group/project-row flex w-full items-center rounded-md text-sm transition-colors",
            isActive
              ? "bg-sidebar-border text-sidebar-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
          title={project.name}
        >
          <NavLink
            to={`/projects/${project.id}`}
            onClick={onProjectSelect}
            className="absolute inset-0 rounded-md outline-none ring-sidebar-ring focus-visible:ring-2"
          />
          <button
            type="button"
            aria-expanded={!isCollapsed}
            aria-label={
              isCollapsed
                ? `Expand ${project.name}`
                : `Collapse ${project.name}`
            }
            title={
              isCollapsed
                ? "Expand project threads"
                : "Collapse project threads"
            }
            onClick={() => {
              onToggleProjectCollapsed(project.id);
            }}
            className={cn(
              "relative z-10 flex shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2",
              COARSE_POINTER_PROJECT_ROW_ACTION_SIZE_CLASS,
            )}
          >
            <span
              className={cn(
                "relative inline-flex items-center justify-center",
                COARSE_POINTER_ICON_SIZE_CLASS,
              )}
            >
              <ChevronRight
                className={cn(
                  "absolute opacity-0 transition-all duration-150 group-hover/project-row:opacity-100",
                  COARSE_POINTER_ICON_SIZE_CLASS,
                  !isCollapsed && "rotate-90",
                )}
              />
              {isCollapsed ? (
                <Folder
                  className={cn(
                    "absolute opacity-100 transition-opacity duration-150 group-hover/project-row:opacity-0",
                    COARSE_POINTER_ICON_SIZE_CLASS,
                  )}
                />
              ) : (
                <FolderOpen
                  className={cn(
                    "absolute opacity-100 transition-opacity duration-150 group-hover/project-row:opacity-0",
                    COARSE_POINTER_ICON_SIZE_CLASS,
                  )}
                />
              )}
            </span>
          </button>
          <span className="pointer-events-none relative z-10 min-w-0 flex-1 truncate text-left">
            {project.name}
          </span>
          {isLocalPathInvalid ? (
            <NavLink
              to={`/projects/${project.id}/settings`}
              onClick={(event) => {
                event.stopPropagation();
                onProjectSelect?.();
              }}
              title="Project folder not found. Open project settings to fix."
              aria-label="Project folder not found"
              className={cn(
                "relative z-10 inline-flex shrink-0 items-center justify-center rounded-md text-destructive outline-none ring-sidebar-ring transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2",
                COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
              )}
            >
              <AlertTriangle className={COARSE_POINTER_ICON_SIZE_CLASS} />
            </NavLink>
          ) : null}
          <ProjectActionsMenu
            project={project}
            triggerClassName={cn(
              "relative z-10 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground",
              COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
            )}
          />
        </SidebarStickyTier>
      </ProjectActionsContextMenu>

      {!isCollapsed ? (
        threadListState.status === "loading" ? (
          <div className="group-data-[collapsible=icon]:hidden">
            <SidebarMenuSkeleton />
          </div>
        ) : projectThreads.length > 0 ? (
          <div className="space-y-0.5 group-data-[collapsible=icon]:hidden">
            {managerThreadGroups.map((managerThreadGroup) => {
              const { managerThread, managedThreads, stats } =
                managerThreadGroup;
              const managedChildCount = stats.managedChildCount;
              const managedChildBusyCount = stats.managedChildBusyCount;
              const isManagerCollapsed = collapsedManagerIds.has(
                managerThread.id,
              );

              return (
                <div key={managerThread.id} className="space-y-px">
                  <ThreadRow
                    projectId={project.id}
                    thread={managerThread}
                    isActive={selectedThreadId === managerThread.id}
                    isPromoted={isThreadPromoted(managerThread)}
                    onProjectSelect={onProjectSelect}
                    options={{
                      kind: "manager",
                      isCollapsed: isManagerCollapsed,
                      managedChildCount,
                      managedChildBusyCount,
                      onToggleCollapsed: onToggleManagerCollapsed,
                    }}
                  />
                  {!isManagerCollapsed
                    ? managedThreads.map((managedThread) => (
                        <ThreadRow
                          key={managedThread.id}
                          projectId={project.id}
                          thread={managedThread}
                          isActive={selectedThreadId === managedThread.id}
                          isPromoted={isThreadPromoted(managedThread)}
                          onProjectSelect={onProjectSelect}
                          options={{ kind: "managed-child" }}
                        />
                      ))
                    : null}
                </div>
              );
            })}
            {unmanagedStandardThreads.map((thread) => (
              <ThreadRow
                key={thread.id}
                projectId={project.id}
                thread={thread}
                isActive={selectedThreadId === thread.id}
                isPromoted={isThreadPromoted(thread)}
                onProjectSelect={onProjectSelect}
                options={{ kind: "default" }}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            message={
              threadListState.status === "unavailable"
                ? "Threads unavailable"
                : "No threads"
            }
            className="py-0.5 pl-8 pr-2 group-data-[collapsible=icon]:hidden"
            messageClassName="text-xs leading-4 text-sidebar-foreground/60"
          />
        )
      ) : null}
    </SidebarMenuItem>
  );
}
