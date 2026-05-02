import { useMemo } from "react";
import type { ThreadListEntry } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import { AlertTriangle, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { NavLink } from "react-router-dom";
import { EmptyState } from "@bb/ui-core";
import { ProjectActionsMenu } from "@/components/project/ProjectActionsMenu";
import { SidebarMenuItem, SidebarMenuSkeleton } from "@bb/ui-core";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_PROJECT_ROW_ACTION_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
} from "@bb/ui-core";
import { isBusyThread } from "@/lib/thread-activity";
import { cn } from "@/lib/utils";
import { ThreadRow } from "./ThreadRow";

interface ProjectRowProps {
  project: ProjectResponse;
  projectThreads: ThreadListEntry[];
  threadsLoading: boolean;
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

interface ProjectThreadGroups {
  managerThreads: ThreadListEntry[];
  managedThreadsByManagerId: Map<string, ThreadListEntry[]>;
  otherThreads: ThreadListEntry[];
}

function buildProjectThreadGroups(
  projectThreads: ThreadListEntry[],
): ProjectThreadGroups {
  const managerThreads = projectThreads
    .filter((thread) => thread.type === "manager")
    .sort((a, b) => b.createdAt - a.createdAt);
  const managerThreadIds = new Set(managerThreads.map((thread) => thread.id));
  const managedThreadsByManagerId = new Map<string, ThreadListEntry[]>();

  for (const thread of projectThreads) {
    if (thread.type !== "standard" || !thread.parentThreadId) continue;
    if (!managerThreadIds.has(thread.parentThreadId)) continue;

    const existing = managedThreadsByManagerId.get(thread.parentThreadId);
    if (existing) {
      existing.push(thread);
      continue;
    }

    managedThreadsByManagerId.set(thread.parentThreadId, [thread]);
  }

  for (const managedThreads of managedThreadsByManagerId.values()) {
    managedThreads.sort((a, b) => b.createdAt - a.createdAt);
  }

  const otherThreads = projectThreads
    .filter((thread) => {
      if (thread.type === "manager") return false;
      if (!thread.parentThreadId) return true;
      return !managerThreadIds.has(thread.parentThreadId);
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  return {
    managerThreads,
    managedThreadsByManagerId,
    otherThreads,
  };
}

export function ProjectRow({
  project,
  projectThreads,
  threadsLoading,
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
  const { managerThreads, managedThreadsByManagerId, otherThreads } = useMemo(
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
    <SidebarMenuItem className="space-y-0.5">
      <div
        className={cn(
          "group/project-row relative flex w-full items-center rounded-md text-sm transition-colors",
          COARSE_POINTER_ROW_HEIGHT_CLASS,
          isActive
            ? "bg-sidebar-border/80 text-sidebar-foreground"
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
            isCollapsed ? `Expand ${project.name}` : `Collapse ${project.name}`
          }
          title={
            isCollapsed ? "Expand project threads" : "Collapse project threads"
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
      </div>

      {!isCollapsed ? (
        threadsLoading ? (
          <div className="group-data-[collapsible=icon]:hidden">
            <SidebarMenuSkeleton />
          </div>
        ) : projectThreads.length > 0 ? (
          <div className="space-y-0.5 group-data-[collapsible=icon]:hidden">
            {managerThreads.map((thread) => {
              const managedChildren =
                managedThreadsByManagerId.get(thread.id) ?? [];
              const isManagerCollapsed = collapsedManagerIds.has(thread.id);

              return (
                <div key={thread.id} className="space-y-0.5">
                  <ThreadRow
                    projectId={project.id}
                    thread={thread}
                    isActive={selectedThreadId === thread.id}
                    isPromoted={isThreadPromoted(thread)}
                    onProjectSelect={onProjectSelect}
                    onToggleManagerCollapsed={onToggleManagerCollapsed}
                    options={{
                      kind: "manager",
                      hasManagedChildren: managedChildren.length > 0,
                      isCollapsed: isManagerCollapsed,
                      managedChildCount: managedChildren.length,
                      managedChildBusyCount:
                        managedChildren.filter(isBusyThread).length,
                    }}
                  />
                  {!isManagerCollapsed && managedChildren.length > 0 ? (
                    <div className="space-y-0.5">
                      {managedChildren.map((childThread) => (
                        <ThreadRow
                          key={childThread.id}
                          projectId={project.id}
                          thread={childThread}
                          isActive={selectedThreadId === childThread.id}
                          isPromoted={isThreadPromoted(childThread)}
                          onProjectSelect={onProjectSelect}
                          options={{ kind: "managed-child" }}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {otherThreads.map((thread) => (
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
            message="No threads"
            className="py-0.5 pl-8 pr-2 group-data-[collapsible=icon]:hidden"
            messageClassName="text-xs leading-4 text-sidebar-foreground/60"
          />
        )
      ) : null}
    </SidebarMenuItem>
  );
}
